use std::{path::Path, process::Stdio, time::Duration};

use tokio::{io::BufReader, net::UnixListener, process::Command, time::timeout};
use uuid::Uuid;

use crate::{domain::ProviderEvent, provider::read_frame};

pub struct ProviderSupervisor;

impl ProviderSupervisor {
    pub async fn run_fake(
        provider_project: &Path,
        socket_path: &Path,
        session_id: Uuid,
        count: u64,
    ) -> anyhow::Result<Vec<ProviderEvent>> {
        if socket_path.exists() {
            std::fs::remove_file(socket_path)?;
        }
        let _cleanup = SocketCleanup(socket_path.to_owned());
        let listener = UnixListener::bind(socket_path)?;
        let child = Command::new("uv")
            .args(["run", "--project"])
            .arg(provider_project)
            .args(["proxbot-ios-provider", "fake", "--socket"])
            .arg(socket_path)
            .args(["--session-id", &session_id.to_string()])
            .args(["--count", &count.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let (stream, _) = timeout(Duration::from_secs(15), listener.accept())
            .await
            .map_err(|_| anyhow::anyhow!("provider did not connect within 15 seconds"))??;
        let mut reader = BufReader::new(stream);
        let mut events = Vec::with_capacity(count as usize);
        while let Some(event) = read_frame(&mut reader).await? {
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

struct SocketCleanup(std::path::PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}
