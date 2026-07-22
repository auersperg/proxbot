use std::{path::Path, process::Stdio, time::Duration};

use tokio::{io::BufReader, net::UnixListener, process::Command, time::timeout};
use uuid::Uuid;

use crate::{
    domain::ProviderEvent,
    provider::{ProviderRuntime, read_frame},
};

pub struct ProviderSupervisor;

impl ProviderSupervisor {
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
