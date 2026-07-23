use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, TcpListener, UdpSocket},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, RwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{
    process::Command,
    sync::{Mutex, mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    domain::{EvidenceClass, ParseStatus, ProviderEvent, SessionCoordinator},
    provider::{LiveProvider, ProviderInvocation, ProviderRuntime, ProviderSupervisor},
    store::{EventIndex, SessionStore},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePreflight {
    pub available: bool,
    pub id: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub device_type: Option<String>,
    #[serde(alias = "connection_type")]
    pub connection_type: Option<String>,
    pub paired: Option<bool>,
    pub trusted: Option<bool>,
    #[serde(alias = "product_type")]
    pub product_type: Option<String>,
    #[serde(alias = "product_version")]
    pub product_version: Option<String>,
    #[serde(alias = "build_version")]
    pub build_version: Option<String>,
    #[serde(alias = "developer_mode")]
    pub developer_mode: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureStatus {
    Idle,
    Starting,
    Capturing,
    Stopping,
    Ready,
    Degraded,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMetrics {
    pub received: u64,
    pub persisted: u64,
    pub malformed: u64,
    pub dropped: u64,
    pub queue_depth: u64,
    pub throughput_per_second: f64,
    pub drift_ms: f64,
    pub reconnects: u64,
    pub last_event_age_ms: Option<u64>,
    #[serde(skip)]
    pub last_event_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshot {
    pub revision: u64,
    pub status: CaptureStatus,
    pub session_id: Option<Uuid>,
    pub session_dir: Option<PathBuf>,
    pub profile: Option<String>,
    pub device: Option<DevicePreflight>,
    pub metrics: CaptureMetrics,
    pub sources: Vec<CaptureSource>,
    pub error: Option<String>,
}

impl Default for CaptureSnapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            status: CaptureStatus::Idle,
            session_id: None,
            session_dir: None,
            profile: None,
            device: None,
            metrics: CaptureMetrics::default(),
            sources: Vec::new(),
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMarker {
    pub id: Uuid,
    pub session_id: Uuid,
    pub label: String,
    pub created_at_ms: u64,
}

enum CaptureAction {
    Stop,
    Marker {
        label: String,
        reply: oneshot::Sender<anyhow::Result<CaptureMarker>>,
    },
}

struct ActiveCapture {
    actions: mpsc::Sender<CaptureAction>,
    snapshot: Arc<RwLock<CaptureSnapshot>>,
    task: tokio::task::JoinHandle<anyhow::Result<CaptureSnapshot>>,
}

struct LiveCaptureState {
    active: Option<ActiveCapture>,
    settling: bool,
    last: CaptureSnapshot,
}

pub struct LiveCaptureService {
    sessions_root: PathBuf,
    runtime: ProviderRuntime,
    proxy_runtime: ProviderRuntime,
    preflight: Mutex<Option<(Instant, Option<String>, DevicePreflight)>>,
    state: Mutex<LiveCaptureState>,
}

impl LiveCaptureService {
    pub fn new(
        sessions_root: PathBuf,
        runtime: ProviderRuntime,
        proxy_runtime: ProviderRuntime,
    ) -> Self {
        Self {
            sessions_root,
            runtime,
            proxy_runtime,
            preflight: Mutex::new(None),
            state: Mutex::new(LiveCaptureState {
                active: None,
                settling: false,
                last: CaptureSnapshot::default(),
            }),
        }
    }

    pub async fn device_preflight(
        &self,
        device_id: Option<&str>,
    ) -> anyhow::Result<DevicePreflight> {
        let requested_device = device_id.map(ToOwned::to_owned);
        let mut preflight = self.preflight.lock().await;
        if let Some((completed_at, cached_device, result)) = preflight.as_ref()
            && completed_at.elapsed() <= Duration::from_secs(5)
            && cached_device == &requested_device
        {
            return Ok(result.clone());
        }
        let mut arguments = Vec::new();
        if let Some(device_id) = device_id {
            anyhow::ensure!(!device_id.trim().is_empty(), "device ID must not be empty");
            anyhow::ensure!(
                device_id.len() <= 512,
                "device ID must not exceed 512 bytes"
            );
            arguments.extend(["--udid", device_id]);
        }
        let invocation = self.runtime.invocation("device-preflight", &arguments);
        let output = run_preflight_command(invocation, Duration::from_secs(45)).await?;
        anyhow::ensure!(
            output.status.success(),
            "device preflight failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        let result: DevicePreflight = serde_json::from_slice(&output.stdout)?;
        *preflight = Some((Instant::now(), requested_device, result.clone()));
        Ok(result)
    }

    pub async fn start_capture(
        &self,
        profile: &str,
        device_id: Option<String>,
    ) -> anyhow::Result<CaptureSnapshot> {
        anyhow::ensure!(
            matches!(profile, "wireguard" | "deep" | "passive"),
            "capture profile must be wireguard, deep, or passive"
        );
        let _ = self.reap_finished().await;
        {
            let mut state = self.state.lock().await;
            anyhow::ensure!(
                state.active.is_none()
                    && !state.settling
                    && !matches!(
                        state.last.status,
                        CaptureStatus::Starting | CaptureStatus::Stopping
                    ),
                "another capture is already active"
            );
            state.last = starting_snapshot(state.last.revision + 1, profile);
        }

        let result = self.start_capture_inner(profile, device_id).await;
        if let Err(error) = &result {
            let mut state = self.state.lock().await;
            state.last.revision += 1;
            state.last.status = CaptureStatus::Error;
            state.last.error = Some(error.to_string());
        }
        result
    }

    async fn start_capture_inner(
        &self,
        profile: &str,
        device_id: Option<String>,
    ) -> anyhow::Result<CaptureSnapshot> {
        let device = self.device_preflight(device_id.as_deref()).await?;
        anyhow::ensure!(
            device.available,
            "{}",
            device.error.as_deref().unwrap_or("USB iPhone unavailable")
        );
        anyhow::ensure!(device.paired == Some(true), "USB iPhone is not paired");
        anyhow::ensure!(device.trusted == Some(true), "USB iPhone is not trusted");
        let udid = device
            .id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("device preflight returned no ID"))?;

        let session_id = Uuid::new_v4();
        let mut coordinator = SessionCoordinator::new(session_id);
        coordinator.register_provider("ios-live")?;
        let proxy_enabled = matches!(profile, "wireguard" | "deep");
        if proxy_enabled {
            coordinator.register_provider("proxy-mitm")?;
        }
        coordinator.prepare()?;
        coordinator.start()?;
        let mut store = SessionStore::create(&self.sessions_root, session_id)?;
        let session_dir = store.session_dir().to_path_buf();
        let mut startup_guard = StartupSessionGuard::new(session_dir.clone());
        let index = EventIndex::open(&session_dir.join("database/session.sqlite"))?;
        let socket_path = std::env::temp_dir().join(format!(
            "proxbot-ios-{}.sock",
            &session_id.simple().to_string()[..12]
        ));
        let pcap = session_dir.join("capture/device.pcapng");
        let logs = session_dir.join("logs/device.jsonl");
        let providers = if proxy_enabled { "pcap,syslog" } else { "pcap" };
        let mut ios_provider = ProviderSupervisor::start_live(
            &self.runtime,
            &socket_path,
            session_id,
            &udid,
            providers,
            &pcap,
            &logs,
        )
        .await?;
        let ready = timeout(Duration::from_secs(45), ios_provider.next_event())
            .await
            .map_err(|_| anyhow::anyhow!("provider ready event timed out"))??
            .ok_or_else(|| anyhow::anyhow!("provider disconnected before ready"))?;
        validate_live_event(&ready, session_id, "ios-live", 0)?;
        anyhow::ensure!(
            ready.kind == "provider.ready",
            "first provider event is not ready"
        );
        store.append(&ready)?;
        store.checkpoint()?;
        index.insert(&ready)?;

        let mut proxy_provider = None;
        let mut proxy_endpoint = None;
        let mut wireguard_client_config = None;
        if proxy_enabled {
            let proxy_socket = std::env::temp_dir().join(format!(
                "proxbot-proxy-{}.sock",
                &session_id.simple().to_string()[..12]
            ));
            let proxy_artifacts = session_dir.join("proxy");
            let proxy_confdir = self
                .sessions_root
                .parent()
                .unwrap_or(&self.sessions_root)
                .join("proxy-ca");
            create_owner_only_directory(&proxy_confdir)?;
            let wireguard = profile == "wireguard";
            let listen_port = if wireguard {
                available_wireguard_port()?
            } else {
                available_proxy_port()?
            };
            let listen_host = advertised_lan_address();
            let wireguard_root = self
                .sessions_root
                .parent()
                .unwrap_or(&self.sessions_root)
                .join("wireguard");
            let wireguard_state = wireguard.then(|| wireguard_root.join("server.json"));
            let client_config = wireguard.then(|| wireguard_root.join("proxbot.conf"));
            if wireguard {
                create_owner_only_directory(&wireguard_root)?;
            }
            let advertised_host = wireguard.then(|| listen_host.to_string());
            let started = ProviderSupervisor::start_proxy(
                &self.proxy_runtime,
                crate::provider::ProxyStartOptions {
                    socket_path: &proxy_socket,
                    session_id,
                    artifact_root: &proxy_artifacts,
                    confdir: &proxy_confdir,
                    listen_host: "0.0.0.0",
                    listen_port,
                    mode: if wireguard { "wireguard" } else { "regular" },
                    advertised_host: advertised_host.as_deref(),
                    wireguard_state: wireguard_state.as_deref(),
                    wireguard_client_config: client_config.as_deref(),
                },
            )
            .await;
            let mut started = match started {
                Ok(provider) => provider,
                Err(error) => {
                    let _ = ios_provider.request_stop();
                    let _ = ios_provider.wait().await;
                    return Err(error.context("HTTPS proxy provider failed to start"));
                }
            };
            let proxy_ready = match timeout(Duration::from_secs(45), started.next_event()).await {
                Ok(Ok(Some(event))) => event,
                Ok(Ok(None)) => {
                    let _ = ios_provider.request_stop();
                    let _ = started.request_stop();
                    let _ = ios_provider.wait().await;
                    let _ = started.wait().await;
                    anyhow::bail!("HTTPS proxy disconnected before ready");
                }
                Ok(Err(error)) => {
                    let _ = ios_provider.request_stop();
                    let _ = started.request_stop();
                    let _ = ios_provider.wait().await;
                    let _ = started.wait().await;
                    return Err(error.context("HTTPS proxy ready event failed"));
                }
                Err(_) => {
                    let _ = ios_provider.request_stop();
                    let _ = started.request_stop();
                    let _ = ios_provider.wait().await;
                    let _ = started.wait().await;
                    anyhow::bail!("HTTPS proxy ready event timed out");
                }
            };
            validate_live_event(&proxy_ready, session_id, "proxy-mitm", 0)?;
            anyhow::ensure!(
                proxy_ready.kind == "provider.ready",
                "first HTTPS proxy event is not ready"
            );
            persist_event(&mut store, &index, &proxy_ready)?;
            proxy_endpoint = Some(format!("{listen_host}:{listen_port}"));
            wireguard_client_config = client_config;
            proxy_provider = Some(started);
        }

        let snapshot = CaptureSnapshot {
            revision: self.state.lock().await.last.revision + 1,
            status: CaptureStatus::Capturing,
            session_id: Some(session_id),
            session_dir: Some(session_dir),
            profile: Some(profile.to_owned()),
            device: Some(device),
            metrics: CaptureMetrics {
                received: if proxy_provider.is_some() { 2 } else { 1 },
                persisted: if proxy_provider.is_some() { 2 } else { 1 },
                last_event_age_ms: Some(0),
                last_event_at_ms: Some(now_ms()),
                ..CaptureMetrics::default()
            },
            sources: capture_sources(
                profile,
                proxy_endpoint.as_deref(),
                wireguard_client_config.as_deref(),
            ),
            error: None,
        };
        let shared_snapshot = Arc::new(RwLock::new(snapshot.clone()));
        let (actions, receiver) = mpsc::channel(32);
        let worker_snapshot = Arc::clone(&shared_snapshot);
        let task = tokio::spawn(async move {
            run_live_worker(LiveWorker {
                ios_provider,
                proxy_provider,
                store,
                index,
                coordinator,
                actions: receiver,
                snapshot: worker_snapshot,
                session_id,
            })
            .await
        });
        let mut state = self.state.lock().await;
        state.last = snapshot.clone();
        state.active = Some(ActiveCapture {
            actions,
            snapshot: shared_snapshot,
            task,
        });
        startup_guard.disarm();
        Ok(snapshot)
    }

    pub async fn status(&self) -> CaptureSnapshot {
        let _ = self.reap_finished().await;
        let state = self.state.lock().await;
        let mut snapshot = state.active.as_ref().map_or_else(
            || state.last.clone(),
            |active| {
                active
                    .snapshot
                    .read()
                    .expect("capture snapshot poisoned")
                    .clone()
            },
        );
        snapshot.metrics.last_event_age_ms = snapshot
            .metrics
            .last_event_at_ms
            .map(|last| now_ms().saturating_sub(last));
        snapshot
    }

    pub async fn add_marker(&self, label: Option<String>) -> anyhow::Result<CaptureMarker> {
        let sender = {
            let state = self.state.lock().await;
            state.active.as_ref().map(|active| active.actions.clone())
        }
        .ok_or_else(|| anyhow::anyhow!("no active capture"))?;
        let label = label.unwrap_or_else(|| "Marker".into());
        anyhow::ensure!(!label.trim().is_empty(), "marker label must not be empty");
        anyhow::ensure!(label.len() <= 512, "marker label must not exceed 512 bytes");
        let (reply, result) = oneshot::channel();
        sender
            .send(CaptureAction::Marker { label, reply })
            .await
            .map_err(|_| anyhow::anyhow!("capture worker stopped"))?;
        result
            .await
            .map_err(|_| anyhow::anyhow!("capture worker stopped"))?
    }

    pub async fn stop_capture(&self) -> anyhow::Result<CaptureSnapshot> {
        let (active, fallback) = {
            let mut state = self.state.lock().await;
            let active = state
                .active
                .take()
                .ok_or_else(|| anyhow::anyhow!("no active capture"))?;
            {
                let mut snapshot = active.snapshot.write().expect("capture snapshot poisoned");
                snapshot.revision += 1;
                snapshot.status = CaptureStatus::Stopping;
            }
            let fallback = active
                .snapshot
                .read()
                .expect("capture snapshot poisoned")
                .clone();
            state.last = fallback.clone();
            state.settling = true;
            (active, fallback)
        };
        let _ = active.actions.send(CaptureAction::Stop).await;
        self.settle_active(active, fallback).await
    }

    async fn reap_finished(&self) -> anyhow::Result<()> {
        let finished = {
            let mut state = self.state.lock().await;
            if state.settling
                || !state
                    .active
                    .as_ref()
                    .is_some_and(|active| active.task.is_finished())
            {
                None
            } else {
                let active = state.active.take().expect("finished capture disappeared");
                let fallback = active
                    .snapshot
                    .read()
                    .expect("capture snapshot poisoned")
                    .clone();
                state.settling = true;
                Some((active, fallback))
            }
        };
        if let Some((active, fallback)) = finished {
            self.settle_active(active, fallback).await?;
        }
        Ok(())
    }

    async fn settle_active(
        &self,
        active: ActiveCapture,
        fallback: CaptureSnapshot,
    ) -> anyhow::Result<CaptureSnapshot> {
        match active.task.await {
            Ok(Ok(result)) => {
                let mut state = self.state.lock().await;
                state.last = result.clone();
                state.settling = false;
                Ok(result)
            }
            outcome => {
                let error = match outcome {
                    Ok(Err(error)) => error,
                    Err(error) => error.into(),
                    Ok(Ok(_)) => unreachable!(),
                };
                let mut failed = fallback;
                failed.revision += 1;
                failed.status = CaptureStatus::Error;
                failed.error = Some(error.to_string());
                let mut state = self.state.lock().await;
                state.last = failed;
                state.settling = false;
                Err(error)
            }
        }
    }
}

async fn run_preflight_command(
    invocation: ProviderInvocation,
    duration: Duration,
) -> anyhow::Result<std::process::Output> {
    let mut command = Command::new(invocation.program);
    command
        .args(invocation.arguments)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    timeout(duration, command.output())
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "device preflight timed out after {} seconds",
                duration.as_secs()
            )
        })?
        .map_err(Into::into)
}

fn starting_snapshot(revision: u64, profile: &str) -> CaptureSnapshot {
    CaptureSnapshot {
        revision,
        status: CaptureStatus::Starting,
        profile: Some(profile.to_owned()),
        ..CaptureSnapshot::default()
    }
}

struct StartupSessionGuard {
    session_dir: PathBuf,
    armed: bool,
}

impl StartupSessionGuard {
    fn new(session_dir: PathBuf) -> Self {
        Self {
            session_dir,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartupSessionGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_dir_all(&self.session_dir);
        }
    }
}

fn capture_sources(
    profile: &str,
    proxy_endpoint: Option<&str>,
    wireguard_client_config: Option<&Path>,
) -> Vec<CaptureSource> {
    let mut sources = vec![CaptureSource {
        id: "pcap".into(),
        label: "Encrypted network packets".into(),
        status: "active".into(),
        detail: Some("USB pcapd / PCAPNG".into()),
    }];
    if matches!(profile, "wireguard" | "deep") {
        sources.push(CaptureSource {
            id: "syslog".into(),
            label: "Device syslog".into(),
            status: "active".into(),
            detail: Some("USB syslog relay / JSONL".into()),
        });
        sources.push(CaptureSource {
            id: "proxy-mitm".into(),
            label: if profile == "wireguard" {
                "WireGuard HTTP(S) inspection".into()
            } else {
                "HTTP(S) proxy".into()
            },
            status: "active".into(),
            detail: Some(if profile == "wireguard" {
                format!(
                    "{} · WireGuard full tunnel · profile {} · CA http://mitm.it",
                    proxy_endpoint.unwrap_or("listener active"),
                    wireguard_client_config
                        .map(|path| path.display().to_string())
                        .unwrap_or_else(|| "initializing".into())
                )
            } else {
                format!(
                    "{} · iPhone Wi-Fi proxy · CA http://mitm.it",
                    proxy_endpoint.unwrap_or("listener active")
                )
            }),
        });
    }
    sources
}

fn available_proxy_port() -> anyhow::Result<u16> {
    for port in 9090..=9190 {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(listener) => {
                drop(listener);
                return Ok(port);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("no free HTTPS proxy port in range 9090-9190")
}

fn available_wireguard_port() -> anyhow::Result<u16> {
    for port in 51820..=51920 {
        match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(socket) => {
                drop(socket);
                return Ok(port);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("no free WireGuard UDP port in range 51820-51920")
}

fn advertised_lan_address() -> IpAddr {
    UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((Ipv4Addr::new(1, 1, 1, 1), 80))?;
            socket.local_addr()
        })
        .ok()
        .map(|address| address.ip())
        .filter(|address| !address.is_loopback() && !address.is_unspecified())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

fn create_owner_only_directory(path: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

struct LiveWorker {
    ios_provider: LiveProvider,
    proxy_provider: Option<LiveProvider>,
    store: SessionStore,
    index: EventIndex,
    coordinator: SessionCoordinator,
    actions: mpsc::Receiver<CaptureAction>,
    snapshot: Arc<RwLock<CaptureSnapshot>>,
    session_id: Uuid,
}

const LIVE_BATCH_MAX_EVENTS: usize = 256;
const LIVE_BATCH_INTERVAL: Duration = Duration::from_millis(25);

async fn run_live_worker(worker: LiveWorker) -> anyhow::Result<CaptureSnapshot> {
    let LiveWorker {
        mut ios_provider,
        mut proxy_provider,
        mut store,
        index,
        mut coordinator,
        mut actions,
        snapshot,
        session_id,
    } = worker;
    let started = Instant::now();
    let mut next_sequences = BTreeMap::from([("ios-live", 1_u64)]);
    if proxy_provider.is_some() {
        next_sequences.insert("proxy-mitm", 1);
    }
    let mut marker_sequence = 0;
    let mut stopping = false;
    let mut stop_deadline = None;
    let mut terminal_error = None;
    let mut ios_done = false;
    let mut proxy_done = proxy_provider.is_none();
    let mut pending = Vec::with_capacity(LIVE_BATCH_MAX_EVENTS);
    let mut flush_interval = tokio::time::interval(LIVE_BATCH_INTERVAL);
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Tokio intervals tick immediately once. Consume that tick so the first
    // actual checkpoint occurs after the configured realtime batching window.
    flush_interval.tick().await;
    loop {
        if ios_done && proxy_done {
            break;
        }
        tokio::select! {
            action = actions.recv() => match action {
                Some(CaptureAction::Stop) if !stopping => {
                    stopping = true;
                    stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(12));
                    if let Err(error) = flush_pending_events(
                        &mut pending,
                        &mut store,
                        &index,
                        &snapshot,
                        started,
                    ) {
                        terminal_error.get_or_insert_with(|| error.to_string());
                    }
                    if let Err(error) = ios_provider.request_stop() {
                        terminal_error.get_or_insert_with(|| error.to_string());
                    }
                    if let Some(provider) = proxy_provider.as_mut()
                        && let Err(error) = provider.request_stop()
                    {
                        terminal_error.get_or_insert_with(|| error.to_string());
                    }
                }
                Some(CaptureAction::Marker { label, reply }) => {
                    let marker = CaptureMarker { id: Uuid::new_v4(), session_id, label, created_at_ms: now_ms() };
                    let event = marker_event(&marker, marker_sequence);
                    marker_sequence += 1;
                    let result = flush_pending_events(
                        &mut pending,
                        &mut store,
                        &index,
                        &snapshot,
                        started,
                    ).and_then(|_| persist_event(&mut store, &index, &event)).map(|_| {
                        update_snapshot(&snapshot, &event, started);
                        marker
                    });
                    if let Err(error) = &result {
                        fail_live_capture(
                            error.to_string(),
                            &mut ios_provider,
                            proxy_provider.as_mut(),
                            &mut stopping,
                            &mut stop_deadline,
                            &mut terminal_error,
                        );
                    }
                    let _ = reply.send(result);
                }
                _ => {}
            },
            event = async {
                if ios_done {
                    std::future::pending::<anyhow::Result<Option<ProviderEvent>>>().await
                } else {
                    ios_provider.next_event().await
                }
            } => match event {
                Ok(Some(event)) => {
                    if let Err(error) = ingest_live_event(
                        event,
                        "ios-live",
                        session_id,
                        &mut next_sequences,
                        &mut pending,
                        &mut store,
                        &index,
                        &snapshot,
                        started,
                    ) {
                        fail_live_capture(
                            error.to_string(),
                            &mut ios_provider,
                            proxy_provider.as_mut(),
                            &mut stopping,
                            &mut stop_deadline,
                            &mut terminal_error,
                        );
                    }
                }
                Ok(None) => {
                    ios_done = true;
                    if !stopping {
                        terminal_error.get_or_insert_with(|| "iOS provider disconnected unexpectedly".into());
                        stopping = true;
                        stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(12));
                        if let Some(provider) = proxy_provider.as_mut() {
                            let _ = provider.request_stop();
                        }
                    }
                },
                Err(error) => {
                    ios_done = true;
                    fail_live_capture(
                        error.to_string(),
                        &mut ios_provider,
                        proxy_provider.as_mut(),
                        &mut stopping,
                        &mut stop_deadline,
                        &mut terminal_error,
                    );
                }
            },
            event = async {
                match proxy_provider.as_mut() {
                    Some(provider) if !proxy_done => provider.next_event().await,
                    _ => std::future::pending::<anyhow::Result<Option<ProviderEvent>>>().await,
                }
            } => match event {
                Ok(Some(event)) => {
                    if let Err(error) = ingest_live_event(
                        event,
                        "proxy-mitm",
                        session_id,
                        &mut next_sequences,
                        &mut pending,
                        &mut store,
                        &index,
                        &snapshot,
                        started,
                    ) {
                        fail_live_capture(
                            error.to_string(),
                            &mut ios_provider,
                            proxy_provider.as_mut(),
                            &mut stopping,
                            &mut stop_deadline,
                            &mut terminal_error,
                        );
                    }
                }
                Ok(None) => {
                    proxy_done = true;
                    if !stopping {
                        terminal_error.get_or_insert_with(|| "HTTPS proxy provider disconnected unexpectedly".into());
                        stopping = true;
                        stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(12));
                        let _ = ios_provider.request_stop();
                    }
                },
                Err(error) => {
                    proxy_done = true;
                    fail_live_capture(
                        error.to_string(),
                        &mut ios_provider,
                        proxy_provider.as_mut(),
                        &mut stopping,
                        &mut stop_deadline,
                        &mut terminal_error,
                    );
                }
            },
            _ = flush_interval.tick(), if !pending.is_empty() => {
                if let Err(error) = flush_pending_events(
                    &mut pending,
                    &mut store,
                    &index,
                    &snapshot,
                    started,
                ) {
                    fail_live_capture(
                        error.to_string(),
                        &mut ios_provider,
                        proxy_provider.as_mut(),
                        &mut stopping,
                        &mut stop_deadline,
                        &mut terminal_error,
                    );
                }
            },
            _ = async {
                if let Some(deadline) = stop_deadline { tokio::time::sleep_until(deadline).await }
                else { std::future::pending::<()>().await }
            } => {
                terminal_error.get_or_insert_with(|| "provider stop timed out".into());
                let _ = ios_provider.request_stop();
                if let Some(provider) = proxy_provider.as_mut() {
                    let _ = provider.request_stop();
                }
                break;
            }
        }
    }
    if let Err(error) = flush_pending_events(&mut pending, &mut store, &index, &snapshot, started) {
        terminal_error.get_or_insert_with(|| error.to_string());
    }
    if let Err(error) = ios_provider.wait().await {
        terminal_error.get_or_insert_with(|| error.to_string());
    }
    if let Some(provider) = proxy_provider
        && let Err(error) = provider.wait().await
    {
        terminal_error.get_or_insert_with(|| error.to_string());
    }
    coordinator.stop()?;
    coordinator.finalize()?;
    let finalized = store.finalize()?;
    let mut final_snapshot = snapshot.read().expect("capture snapshot poisoned").clone();
    final_snapshot.revision += 1;
    final_snapshot.session_dir = Some(finalized.session_dir);
    final_snapshot.status = if terminal_error.is_some() {
        CaptureStatus::Error
    } else {
        CaptureStatus::Ready
    };
    for source in &mut final_snapshot.sources {
        source.status = if terminal_error.is_some() {
            "error".into()
        } else {
            "idle".into()
        };
    }
    final_snapshot.error = terminal_error;
    *snapshot.write().expect("capture snapshot poisoned") = final_snapshot.clone();
    Ok(final_snapshot)
}

#[allow(clippy::too_many_arguments)]
fn ingest_live_event(
    event: ProviderEvent,
    provider_id: &'static str,
    session_id: Uuid,
    next_sequences: &mut BTreeMap<&'static str, u64>,
    pending: &mut Vec<ProviderEvent>,
    store: &mut SessionStore,
    index: &EventIndex,
    snapshot: &RwLock<CaptureSnapshot>,
    started: Instant,
) -> anyhow::Result<()> {
    queue_live_event(event, provider_id, session_id, next_sequences, pending)?;
    let depth = pending.len();
    // The exact depth is operational telemetry, not evidence. Publishing the
    // first event and cache-line-sized increments keeps it useful without a
    // write lock on the UI snapshot for every captured packet.
    if depth == 1 || depth.is_multiple_of(64) {
        set_pending_depth(snapshot, depth);
    }
    if depth >= LIVE_BATCH_MAX_EVENTS {
        flush_pending_events(pending, store, index, snapshot, started)?;
    }
    Ok(())
}

fn fail_live_capture(
    error: String,
    ios_provider: &mut LiveProvider,
    proxy_provider: Option<&mut LiveProvider>,
    stopping: &mut bool,
    stop_deadline: &mut Option<tokio::time::Instant>,
    terminal_error: &mut Option<String>,
) {
    terminal_error.get_or_insert(error);
    *stopping = true;
    *stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(12));
    let _ = ios_provider.request_stop();
    if let Some(provider) = proxy_provider {
        let _ = provider.request_stop();
    }
}

fn queue_live_event(
    event: ProviderEvent,
    provider_id: &'static str,
    session_id: Uuid,
    next_sequences: &mut BTreeMap<&'static str, u64>,
    pending: &mut Vec<ProviderEvent>,
) -> anyhow::Result<()> {
    let expected = next_sequences
        .get_mut(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unregistered live provider: {provider_id}"))?;
    validate_live_event(&event, session_id, provider_id, *expected)?;
    *expected += 1;
    pending.push(event);
    Ok(())
}

fn flush_pending_events(
    pending: &mut Vec<ProviderEvent>,
    store: &mut SessionStore,
    index: &EventIndex,
    snapshot: &RwLock<CaptureSnapshot>,
    started: Instant,
) -> anyhow::Result<()> {
    if pending.is_empty() {
        set_pending_depth(snapshot, 0);
        return Ok(());
    }
    let events = std::mem::replace(pending, Vec::with_capacity(LIVE_BATCH_MAX_EVENTS));
    persist_events(store, index, &events)?;
    update_snapshot_batch(snapshot, &events, started);
    Ok(())
}

fn set_pending_depth(snapshot: &RwLock<CaptureSnapshot>, depth: usize) {
    snapshot
        .write()
        .expect("capture snapshot poisoned")
        .metrics
        .queue_depth = depth as u64;
}

fn persist_event(
    store: &mut SessionStore,
    index: &EventIndex,
    event: &ProviderEvent,
) -> anyhow::Result<()> {
    persist_events(store, index, std::slice::from_ref(event))
}

fn persist_events(
    store: &mut SessionStore,
    index: &EventIndex,
    events: &[ProviderEvent],
) -> anyhow::Result<()> {
    for event in events {
        store.append(event)?;
    }
    store.checkpoint()?;
    index.insert_batch(events)?;
    Ok(())
}

fn validate_live_event(
    event: &ProviderEvent,
    session_id: Uuid,
    provider_id: &str,
    sequence: u64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        event.session_id == session_id,
        "provider event belongs to another session"
    );
    anyhow::ensure!(
        event.provider_id == provider_id,
        "unexpected live provider ID: expected {provider_id}, received {}",
        event.provider_id
    );
    anyhow::ensure!(
        event.sequence == sequence,
        "provider sequence gap: expected {sequence}, received {}",
        event.sequence
    );
    anyhow::ensure!(
        event
            .payload
            .get("fixture")
            .and_then(|value| value.as_bool())
            != Some(true),
        "live provider emitted fixture evidence"
    );
    Ok(())
}

fn update_snapshot(snapshot: &RwLock<CaptureSnapshot>, event: &ProviderEvent, started: Instant) {
    update_snapshot_batch(snapshot, std::slice::from_ref(event), started);
}

fn update_snapshot_batch(
    snapshot: &RwLock<CaptureSnapshot>,
    events: &[ProviderEvent],
    started: Instant,
) {
    if events.is_empty() {
        return;
    }
    let mut snapshot = snapshot.write().expect("capture snapshot poisoned");
    snapshot.revision += events.len() as u64;
    snapshot.metrics.received += events.len() as u64;
    snapshot.metrics.persisted += events.len() as u64;
    snapshot.metrics.queue_depth = 0;
    for event in events {
        snapshot.metrics.malformed += u64::from(event.parse_status == ParseStatus::Malformed);
        snapshot.metrics.drift_ms =
            (event.host_time_ns - event.source_time_ns) as f64 / 1_000_000.0;
        if event.kind == "provider.health" {
            if let Some(dropped) = event
                .payload
                .get("dropped")
                .and_then(|value| value.as_u64())
            {
                snapshot.metrics.dropped = snapshot.metrics.dropped.max(dropped);
            }
            if let Some(reconnects) = event
                .payload
                .get("reconnects")
                .and_then(|value| value.as_u64())
            {
                snapshot.metrics.reconnects = snapshot.metrics.reconnects.max(reconnects);
            }
        }
        update_source_from_event(&mut snapshot, event);
        if event.kind == "provider.error" {
            snapshot.status = CaptureStatus::Degraded;
            snapshot.error = event
                .payload
                .get("message")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
        }
    }
    snapshot.metrics.throughput_per_second =
        snapshot.metrics.received as f64 / started.elapsed().as_secs_f64().max(0.001);
    snapshot.metrics.last_event_at_ms = Some(now_ms());
    snapshot.metrics.last_event_age_ms = Some(0);
}

fn update_source_from_event(snapshot: &mut CaptureSnapshot, event: &ProviderEvent) {
    if event.provider_id == "proxy-mitm" && event.kind == "network.request" {
        let https_plaintext =
            event.payload.get("scheme").and_then(|value| value.as_str()) == Some("https");
        if let Some(source) = snapshot
            .sources
            .iter_mut()
            .find(|source| source.id == "proxy-mitm")
        {
            source.status = "active".into();
            let existing = source.detail.as_deref().unwrap_or("HTTPS proxy");
            let base = existing
                .split(" · client traffic observed")
                .next()
                .unwrap_or(existing)
                .split(" · HTTPS plaintext observed")
                .next()
                .unwrap_or(existing);
            source.detail = Some(format!(
                "{base} · {}",
                if https_plaintext || existing.contains("HTTPS plaintext observed") {
                    "HTTPS plaintext observed"
                } else {
                    "client traffic observed"
                }
            ));
        }
    }
}

fn marker_event(marker: &CaptureMarker, sequence: u64) -> ProviderEvent {
    let now_ns = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    )
    .unwrap_or(i64::MAX);
    ProviderEvent {
        schema_version: 1,
        provider_id: "proxbot.marker".into(),
        provider_version: env!("CARGO_PKG_VERSION").into(),
        session_id: marker.session_id,
        sequence,
        source_time_ns: now_ns,
        host_time_ns: now_ns,
        monotonic_time_ns: None,
        device_id: None,
        process_id: None,
        process_name: None,
        evidence: EvidenceClass::Observed,
        kind: "capture.marker".into(),
        payload: json!({"marker_id": marker.id, "label": marker.label}),
        raw_ref: None,
        parse_status: ParseStatus::Parsed,
    }
}

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureSummary {
    pub session_id: Uuid,
    pub session_dir: PathBuf,
    pub event_count: u64,
    pub indexed_count: u64,
    pub first_sequence: u64,
    pub last_sequence: u64,
}

pub async fn run_fake_capture(
    root: &Path,
    provider_project: &Path,
    count: u64,
) -> anyhow::Result<CaptureSummary> {
    let runtime = ProviderRuntime::discover(&[], provider_project.to_path_buf())?;
    run_fake_capture_with_runtime(root, &runtime, count).await
}

pub async fn run_fake_capture_with_runtime(
    root: &Path,
    runtime: &ProviderRuntime,
    count: u64,
) -> anyhow::Result<CaptureSummary> {
    anyhow::ensure!(
        (1..=10_000).contains(&count),
        "count must be between 1 and 10000"
    );
    let session_id = Uuid::new_v4();
    let mut coordinator = SessionCoordinator::new(session_id);
    coordinator.register_provider("fake")?;
    coordinator.prepare()?;
    coordinator.start()?;

    let mut store = SessionStore::create(root, session_id)?;
    let index = EventIndex::open(&store.session_dir().join("database/session.sqlite"))?;
    let socket_name = format!("proxbot-{}.sock", &session_id.simple().to_string()[..12]);
    let socket_path = std::env::temp_dir().join(socket_name);
    let events = ProviderSupervisor::run_fake(runtime, &socket_path, session_id, count).await?;

    anyhow::ensure!(
        events.len() == count as usize,
        "provider returned {} events; expected {count}",
        events.len()
    );
    for (expected, event) in events.iter().enumerate() {
        anyhow::ensure!(
            event.session_id == session_id,
            "provider event belongs to session {} instead of {session_id}",
            event.session_id
        );
        anyhow::ensure!(
            event.sequence == expected as u64,
            "provider sequence gap: expected {expected}, received {}",
            event.sequence
        );
    }

    // JSONL is the authoritative evidence stream. Persist the complete stream
    // before updating the derived SQLite index so a crash cannot leave SQLite
    // claiming that evidence exists when it has not reached stable storage.
    for event in &events {
        store.append(event)?;
    }
    store.checkpoint()?;

    index.insert_batch(&events)?;

    coordinator.stop()?;
    coordinator.finalize()?;
    let first_sequence = events
        .first()
        .map(|event| event.sequence)
        .unwrap_or_default();
    let last_sequence = events
        .last()
        .map(|event| event.sequence)
        .unwrap_or_default();
    let finalized = store.finalize()?;

    Ok(CaptureSummary {
        session_id,
        session_dir: finalized.session_dir,
        event_count: finalized.event_count,
        indexed_count: events.len() as u64,
        first_sequence,
        last_sequence,
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, sync::Arc, time::Duration};

    use tempfile::tempdir;
    use tokio::sync::oneshot;

    use super::*;

    fn test_service(root: &Path) -> Arc<LiveCaptureService> {
        let runtime = ProviderRuntime::from_executable(PathBuf::from("/usr/bin/true")).unwrap();
        Arc::new(LiveCaptureService::new(
            root.to_path_buf(),
            runtime.clone(),
            runtime,
        ))
    }

    fn live_snapshot(revision: u64, status: CaptureStatus) -> CaptureSnapshot {
        CaptureSnapshot {
            revision,
            status,
            session_id: Some(Uuid::new_v4()),
            profile: Some("deep".into()),
            ..CaptureSnapshot::default()
        }
    }

    fn provider_event(session_id: Uuid, provider_id: &str, sequence: u64) -> ProviderEvent {
        ProviderEvent {
            schema_version: 1,
            provider_id: provider_id.into(),
            provider_version: "test".into(),
            session_id,
            sequence,
            source_time_ns: 1,
            host_time_ns: 2,
            monotonic_time_ns: Some(1),
            device_id: None,
            process_id: None,
            process_name: None,
            evidence: EvidenceClass::Observed,
            kind: "provider.health".into(),
            payload: json!({"fixture": false}),
            raw_ref: None,
            parse_status: ParseStatus::Parsed,
        }
    }

    #[test]
    fn live_validation_keeps_sequences_local_to_each_provider() {
        let session_id = Uuid::new_v4();
        let ios = provider_event(session_id, "ios-live", 1);
        let proxy = provider_event(session_id, "proxy-mitm", 1);

        validate_live_event(&ios, session_id, "ios-live", 1).unwrap();
        validate_live_event(&proxy, session_id, "proxy-mitm", 1).unwrap();
        assert!(validate_live_event(&proxy, session_id, "ios-live", 1).is_err());
        assert!(validate_live_event(&ios, session_id, "ios-live", 2).is_err());
    }

    #[test]
    fn live_batch_is_durable_before_materialization_and_updates_metrics_once() {
        let root = tempdir().unwrap();
        let session_id = Uuid::new_v4();
        let mut store = SessionStore::create(root.path(), session_id).unwrap();
        let index = EventIndex::open(&store.session_dir().join("database/session.sqlite")).unwrap();
        let snapshot = RwLock::new(CaptureSnapshot::default());
        let started = Instant::now();
        let mut next_sequences = BTreeMap::from([("ios-live", 1_u64), ("proxy-mitm", 1_u64)]);
        let mut pending = Vec::with_capacity(LIVE_BATCH_MAX_EVENTS);

        queue_live_event(
            provider_event(session_id, "ios-live", 1),
            "ios-live",
            session_id,
            &mut next_sequences,
            &mut pending,
        )
        .unwrap();
        queue_live_event(
            provider_event(session_id, "proxy-mitm", 1),
            "proxy-mitm",
            session_id,
            &mut next_sequences,
            &mut pending,
        )
        .unwrap();
        set_pending_depth(&snapshot, pending.len());

        assert_eq!(pending.len(), 2);
        assert_eq!(snapshot.read().unwrap().metrics.queue_depth, 2);
        assert_eq!(index.page(session_id, 0, 10).unwrap().total, 0);

        flush_pending_events(&mut pending, &mut store, &index, &snapshot, started).unwrap();

        assert!(pending.is_empty());
        assert_eq!(index.page(session_id, 0, 10).unwrap().total, 2);
        let partial = std::fs::read_to_string(
            store
                .session_dir()
                .join("events/provider-events.jsonl.partial"),
        )
        .unwrap();
        let persisted: Vec<ProviderEvent> = partial
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            persisted
                .iter()
                .map(|event| event.provider_id.as_str())
                .collect::<Vec<_>>(),
            ["ios-live", "proxy-mitm"]
        );
        let snapshot = snapshot.read().unwrap();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.metrics.received, 2);
        assert_eq!(snapshot.metrics.persisted, 2);
        assert_eq!(snapshot.metrics.queue_depth, 0);
    }

    #[test]
    fn proxy_source_reports_observed_plaintext_without_claiming_ca_trust_early() {
        let session_id = Uuid::new_v4();
        let mut snapshot = CaptureSnapshot {
            sources: capture_sources("deep", Some("192.168.1.31:9091"), None),
            ..CaptureSnapshot::default()
        };
        let mut event = provider_event(session_id, "proxy-mitm", 1);
        event.kind = "network.request".into();
        event.payload = json!({"fixture": false, "scheme": "http"});

        let lock = RwLock::new(snapshot.clone());
        update_snapshot(&lock, &event, Instant::now());
        snapshot = lock.into_inner().unwrap();
        assert!(
            snapshot.sources[2]
                .detail
                .as_deref()
                .unwrap()
                .contains("client traffic observed")
        );
        assert!(
            !snapshot.sources[2]
                .detail
                .as_deref()
                .unwrap()
                .contains("HTTPS plaintext observed")
        );

        event.payload = json!({"fixture": false, "scheme": "https"});
        let lock = RwLock::new(snapshot);
        update_snapshot(&lock, &event, Instant::now());
        let snapshot = lock.into_inner().unwrap();
        assert!(
            snapshot.sources[2]
                .detail
                .as_deref()
                .unwrap()
                .contains("HTTPS plaintext observed")
        );
    }

    #[test]
    fn wireguard_source_exposes_route_and_owner_local_import_path_without_secrets() {
        let sources = capture_sources(
            "wireguard",
            Some("192.168.1.23:51820"),
            Some(Path::new("/private/proxbot.conf")),
        );
        let proxy = sources
            .iter()
            .find(|source| source.id == "proxy-mitm")
            .unwrap();
        assert_eq!(proxy.label, "WireGuard HTTP(S) inspection");
        let detail = proxy.detail.as_deref().unwrap();
        assert!(detail.contains("192.168.1.23:51820"));
        assert!(detail.contains("WireGuard full tunnel"));
        assert!(detail.contains("/private/proxbot.conf"));
        assert!(detail.contains("CA http://mitm.it"));
        assert!(!detail.contains("PrivateKey"));
    }

    #[test]
    fn starting_snapshot_does_not_reuse_a_previous_session() {
        let snapshot = starting_snapshot(18, "passive");

        assert_eq!(snapshot.revision, 18);
        assert_eq!(snapshot.status, CaptureStatus::Starting);
        assert_eq!(snapshot.profile.as_deref(), Some("passive"));
        assert!(snapshot.session_id.is_none());
        assert!(snapshot.session_dir.is_none());
        assert!(snapshot.device.is_none());
        assert_eq!(snapshot.metrics, CaptureMetrics::default());
        assert!(snapshot.sources.is_empty());
        assert!(snapshot.error.is_none());
    }

    #[tokio::test]
    async fn stop_keeps_the_lifecycle_exclusive_until_finalization_finishes() {
        let root = tempdir().unwrap();
        let service = test_service(root.path());
        let capturing = live_snapshot(3, CaptureStatus::Capturing);
        let ready = CaptureSnapshot {
            revision: 5,
            status: CaptureStatus::Ready,
            ..capturing.clone()
        };
        let (actions, mut receiver) = mpsc::channel(1);
        let (release, released) = oneshot::channel();
        let result = ready.clone();
        let task = tokio::spawn(async move {
            assert!(matches!(receiver.recv().await, Some(CaptureAction::Stop)));
            released.await.unwrap();
            Ok(result)
        });
        {
            let mut state = service.state.lock().await;
            state.last = capturing.clone();
            state.active = Some(ActiveCapture {
                actions,
                snapshot: Arc::new(RwLock::new(capturing)),
                task,
            });
        }

        let stopping_service = Arc::clone(&service);
        let stop = tokio::spawn(async move { stopping_service.stop_capture().await });
        for _ in 0..100 {
            if service.state.lock().await.settling {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }

        let during_stop = service.status().await;
        assert_eq!(during_stop.status, CaptureStatus::Stopping);
        assert!(
            service
                .start_capture("deep", None)
                .await
                .unwrap_err()
                .to_string()
                .contains("another capture is already active")
        );

        release.send(()).unwrap();
        assert_eq!(stop.await.unwrap().unwrap(), ready);
        let state = service.state.lock().await;
        assert!(!state.settling);
        assert!(state.active.is_none());
    }

    #[tokio::test]
    async fn status_reaps_a_worker_that_ended_without_an_explicit_stop() {
        let root = tempdir().unwrap();
        let service = test_service(root.path());
        let capturing = live_snapshot(7, CaptureStatus::Capturing);
        let ready = CaptureSnapshot {
            revision: 8,
            status: CaptureStatus::Ready,
            ..capturing.clone()
        };
        let (actions, _receiver) = mpsc::channel(1);
        let result = ready.clone();
        let task = tokio::spawn(async move { Ok(result) });
        {
            let mut state = service.state.lock().await;
            state.last = capturing.clone();
            state.active = Some(ActiveCapture {
                actions,
                snapshot: Arc::new(RwLock::new(capturing)),
                task,
            });
        }
        tokio::task::yield_now().await;

        assert_eq!(service.status().await, ready);
        let state = service.state.lock().await;
        assert!(!state.settling);
        assert!(state.active.is_none());
    }

    #[tokio::test]
    async fn failed_provider_start_removes_the_unpublished_session_directory() {
        let root = tempdir().unwrap();
        let executable = root.path().join("provider.py");
        fs::write(
            &executable,
            r#"#!/usr/bin/env python3
import json, socket, sys
if sys.argv[1] == "device-preflight":
    print(json.dumps({"available": True, "id": "TEST-UDID", "paired": True, "trusted": True}))
    raise SystemExit(0)
if sys.argv[1] == "live-capture":
    path = sys.argv[sys.argv.index("--socket") + 1]
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(path)
    connection.close()
    raise SystemExit(1)
raise SystemExit(2)
"#,
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let sessions = root.path().join("sessions");
        let runtime = ProviderRuntime::from_executable(executable).unwrap();
        let service = LiveCaptureService::new(sessions.clone(), runtime.clone(), runtime);

        let error = service.start_capture("deep", None).await.unwrap_err();

        assert!(error.to_string().contains("disconnected before ready"));
        assert_eq!(fs::read_dir(sessions).unwrap().count(), 0);
        let snapshot = service.status().await;
        assert_eq!(snapshot.status, CaptureStatus::Error);
        assert!(snapshot.session_id.is_none());
        assert!(snapshot.session_dir.is_none());
    }
}
