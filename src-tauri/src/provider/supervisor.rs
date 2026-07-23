use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    net::{UnixListener, UnixStream},
    process::{Child, Command},
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

use crate::{
    domain::ProviderEvent,
    provider::{FrameReader, ProviderRuntime},
};

pub struct ProviderSupervisor;

pub struct ProxyStartOptions<'a> {
    pub socket_path: &'a Path,
    pub session_id: Uuid,
    pub artifact_root: &'a Path,
    pub confdir: &'a Path,
    pub listen_host: &'a str,
    pub listen_port: u16,
    pub mode: &'a str,
    pub advertised_host: Option<&'a str>,
    pub wireguard_state: Option<&'a Path>,
    pub wireguard_client_config: Option<&'a Path>,
}

pub struct LiveProvider {
    child: Child,
    reader: FrameReader<UnixStream>,
    stderr: JoinHandle<Vec<u8>>,
    _socket: SocketCleanup,
}

impl LiveProvider {
    pub async fn next_event(&mut self) -> anyhow::Result<Option<ProviderEvent>> {
        self.reader.next_frame().await
    }

    pub fn request_stop(&mut self) -> anyhow::Result<()> {
        let Some(pid) = self.child.id() else {
            return Ok(());
        };
        let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if result == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        Ok(())
    }

    pub async fn wait(mut self) -> anyhow::Result<()> {
        let status = match timeout(Duration::from_secs(10), self.child.wait()).await {
            Ok(result) => result?,
            Err(_) => {
                self.child.start_kill()?;
                self.child.wait().await?
            }
        };
        let stderr = self.stderr.await.unwrap_or_default();
        anyhow::ensure!(
            status.success(),
            "provider exited with {status}: {}",
            String::from_utf8_lossy(&stderr).trim()
        );
        Ok(())
    }
}

impl ProviderSupervisor {
    pub async fn start_live(
        runtime: &ProviderRuntime,
        socket_path: &Path,
        session_id: Uuid,
        udid: &str,
        providers: &str,
        pcap_output: &Path,
        log_output: &Path,
    ) -> anyhow::Result<LiveProvider> {
        if socket_path.exists() {
            std::fs::remove_file(socket_path)?;
        }
        let cleanup = SocketCleanup(socket_path.to_owned());
        let listener = UnixListener::bind(socket_path)?;
        set_socket_owner_only(socket_path)?;
        let socket = socket_path.display().to_string();
        let session = session_id.to_string();
        let pcap = pcap_output.display().to_string();
        let logs = log_output.display().to_string();
        let invocation = runtime.invocation(
            "live-capture",
            &[
                "--socket",
                &socket,
                "--session-id",
                &session,
                "--udid",
                udid,
                "--providers",
                providers,
                "--pcap-out",
                &pcap,
                "--log-out",
                &logs,
            ],
        );
        let mut child = Command::new(invocation.program)
            .args(invocation.arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stderr = tokio::spawn(drain_bounded(
            child.stderr.take().expect("provider stderr pipe missing"),
            64 * 1024,
        ));

        let stream = match timeout(Duration::from_secs(45), listener.accept()).await {
            Ok(Ok((stream, _))) => stream,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => {
                child.start_kill()?;
                let _ = child.wait().await?;
                let tail = stderr.await.unwrap_or_default();
                anyhow::bail!(
                    "provider did not connect within 45 seconds: {}",
                    String::from_utf8_lossy(&tail).trim()
                );
            }
        };
        drop(listener);
        Ok(LiveProvider {
            child,
            reader: FrameReader::new(stream),
            stderr,
            _socket: cleanup,
        })
    }

    pub async fn start_proxy(
        runtime: &ProviderRuntime,
        options: ProxyStartOptions<'_>,
    ) -> anyhow::Result<LiveProvider> {
        let ProxyStartOptions {
            socket_path,
            session_id,
            artifact_root,
            confdir,
            listen_host,
            listen_port,
            mode,
            advertised_host,
            wireguard_state,
            wireguard_client_config,
        } = options;
        if socket_path.exists() {
            std::fs::remove_file(socket_path)?;
        }
        let cleanup = SocketCleanup(socket_path.to_owned());
        let listener = UnixListener::bind(socket_path)?;
        set_socket_owner_only(socket_path)?;
        let socket = socket_path.display().to_string();
        let session = session_id.to_string();
        let artifacts = artifact_root.display().to_string();
        let confdir = confdir.display().to_string();
        let port = listen_port.to_string();
        let mut arguments = vec![
            "--socket",
            &socket,
            "--session-id",
            &session,
            "--artifact-root",
            &artifacts,
            "--confdir",
            &confdir,
            "--listen-host",
            listen_host,
            "--listen-port",
            &port,
            "--mode",
            mode,
            "--allow-remote",
        ];
        let advertised;
        let state;
        let client;
        if mode == "wireguard" {
            advertised = advertised_host
                .ok_or_else(|| anyhow::anyhow!("WireGuard advertised host is required"))?;
            state = wireguard_state
                .ok_or_else(|| anyhow::anyhow!("WireGuard state path is required"))?
                .display()
                .to_string();
            client = wireguard_client_config
                .ok_or_else(|| anyhow::anyhow!("WireGuard client config path is required"))?
                .display()
                .to_string();
            arguments.extend([
                "--advertise-host",
                advertised,
                "--wireguard-state",
                &state,
                "--wireguard-client-config",
                &client,
            ]);
        }
        let invocation = runtime.invocation("start", &arguments);
        let mut child = Command::new(invocation.program)
            .args(invocation.arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stderr = tokio::spawn(drain_bounded(
            child.stderr.take().expect("provider stderr pipe missing"),
            64 * 1024,
        ));

        let stream = match timeout(Duration::from_secs(45), listener.accept()).await {
            Ok(Ok((stream, _))) => stream,
            Ok(Err(error)) => return Err(error.into()),
            Err(_) => {
                child.start_kill()?;
                let _ = child.wait().await?;
                let tail = stderr.await.unwrap_or_default();
                anyhow::bail!(
                    "HTTPS proxy provider did not connect within 45 seconds: {}",
                    String::from_utf8_lossy(&tail).trim()
                );
            }
        };
        drop(listener);
        Ok(LiveProvider {
            child,
            reader: FrameReader::new(stream),
            stderr,
            _socket: cleanup,
        })
    }

    pub async fn run_fake(
        runtime: &ProviderRuntime,
        socket_path: &Path,
        session_id: Uuid,
        count: u64,
    ) -> anyhow::Result<Vec<ProviderEvent>> {
        if socket_path.exists() {
            std::fs::remove_file(socket_path)?;
        }
        let _cleanup = SocketCleanup(socket_path.to_owned());
        let listener = UnixListener::bind(socket_path)?;
        let socket = socket_path.display().to_string();
        let session = session_id.to_string();
        let count_argument = count.to_string();
        let invocation = runtime.invocation(
            "fake",
            &[
                "--socket",
                &socket,
                "--session-id",
                &session,
                "--count",
                &count_argument,
            ],
        );
        let child = Command::new(invocation.program)
            .args(invocation.arguments)
            .env("PROXBOT_ENABLE_TEST_PROVIDER", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let (stream, _) = timeout(Duration::from_secs(15), listener.accept())
            .await
            .map_err(|_| anyhow::anyhow!("provider did not connect within 15 seconds"))??;
        let mut reader = FrameReader::new(stream);
        let mut events = Vec::with_capacity(count as usize);
        while let Some(event) = reader.next_frame().await? {
            events.push(event);
        }

        let output = timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .map_err(|_| anyhow::anyhow!("provider did not exit within 15 seconds"))??;
        anyhow::ensure!(
            output.status.success(),
            "provider exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(events)
    }
}

async fn drain_bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> Vec<u8> {
    let mut tail = Vec::with_capacity(limit);
    let mut chunk = [0_u8; 4096];
    while let Ok(read) = reader.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..read]);
        if tail.len() > limit {
            tail.drain(..tail.len() - limit);
        }
    }
    tail
}

#[cfg(unix)]
fn set_socket_owner_only(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

struct SocketCleanup(std::path::PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}
