use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::domain::ProviderEvent;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionSummary {
    pub session_id: Uuid,
    pub session_dir: PathBuf,
    pub event_count: u64,
}

#[derive(Serialize)]
struct Manifest {
    schema_version: u16,
    session_id: Uuid,
    status: &'static str,
    event_count: u64,
    artifacts: Vec<ManifestArtifact>,
}

#[derive(Clone, Serialize)]
struct ManifestArtifact {
    relative_path: String,
    bytes: u64,
    sha256: String,
}

pub struct SessionStore {
    session_id: Uuid,
    session_dir: PathBuf,
    partial_path: PathBuf,
    writer: BufWriter<File>,
    event_count: u64,
}

impl SessionStore {
    pub fn create(root: &Path, session_id: Uuid) -> anyhow::Result<Self> {
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        let session_dir = root.join(session_id.to_string());
        create_owner_only_directory(&session_dir)?;
        for relative in [
            "events",
            "capture",
            "logs",
            "proxy",
            "objects",
            "database",
            "sensitive",
            "reports",
            "exports",
        ] {
            create_owner_only_directory(&session_dir.join(relative))?;
        }
        let partial_path = session_dir.join("events/provider-events.jsonl.partial");
        let file = owner_only_file(&partial_path)?;
        sync_directory(&session_dir.join("events"))?;
        sync_directory(&session_dir)?;
        sync_directory(&root)?;
        Ok(Self {
            session_id,
            session_dir,
            partial_path,
            writer: BufWriter::new(file),
            event_count: 0,
        })
    }

    pub fn session_dir(&self) -> &Path {
        &self.session_dir
    }

    pub fn append(&mut self, event: &ProviderEvent) -> anyhow::Result<()> {
        anyhow::ensure!(
            event.session_id == self.session_id,
            "event belongs to a different session"
        );
        serde_json::to_writer(&mut self.writer, event)?;
        self.writer.write_all(b"\n")?;
        self.event_count += 1;
        Ok(())
    }

    /// Flushes every appended event to the authoritative JSONL file and asks
    /// the operating system to persist it before any derived index is updated.
    pub fn checkpoint(&mut self) -> anyhow::Result<()> {
        self.writer.flush()?;
        self.writer.get_ref().sync_all()?;
        sync_directory(&self.session_dir.join("events"))?;
        Ok(())
    }

    pub fn finalize(mut self) -> anyhow::Result<SessionSummary> {
        self.checkpoint()?;
        let final_events = self.session_dir.join("events/provider-events.jsonl");
        refuse_symlink(&final_events)?;
        fs::rename(&self.partial_path, &final_events)?;
        sync_directory(&self.session_dir.join("events"))?;

        let mut artifacts = vec![manifest_artifact(
            &self.session_dir,
            "events/provider-events.jsonl",
        )?];
        for relative_path in [
            "capture/device.pcapng",
            "logs/device.jsonl",
            "proxy/request-bodies.bin",
            "proxy/response-bodies.bin",
            "proxy/websocket-messages.bin",
        ] {
            let path = self.session_dir.join(relative_path);
            match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    anyhow::ensure!(
                        metadata.is_file() && !metadata.file_type().is_symlink(),
                        "refusing non-regular evidence artifact: {}",
                        path.display()
                    );
                    artifacts.push(manifest_artifact(&self.session_dir, relative_path)?);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let checksums_path = self.session_dir.join("checksums.sha256");
        let checksums_partial = self.session_dir.join("checksums.sha256.partial");
        refuse_symlink(&checksums_path)?;
        let mut checksums = owner_only_file(&checksums_partial)?;
        for artifact in &artifacts {
            writeln!(checksums, "{}  {}", artifact.sha256, artifact.relative_path)?;
        }
        checksums.sync_all()?;
        fs::rename(&checksums_partial, &checksums_path)?;
        sync_directory(&self.session_dir)?;

        let manifest = Manifest {
            schema_version: 1,
            session_id: self.session_id,
            status: "ready",
            event_count: self.event_count,
            artifacts,
        };
        let manifest_path = self.session_dir.join("manifest.json");
        let manifest_partial = self.session_dir.join("manifest.json.partial");
        refuse_symlink(&manifest_path)?;
        let mut manifest_file = owner_only_file(&manifest_partial)?;
        serde_json::to_writer_pretty(&mut manifest_file, &manifest)?;
        manifest_file.write_all(b"\n")?;
        manifest_file.sync_all()?;
        fs::rename(&manifest_partial, &manifest_path)?;
        sync_directory(&self.session_dir)?;

        Ok(SessionSummary {
            session_id: self.session_id,
            session_dir: self.session_dir,
            event_count: self.event_count,
        })
    }
}

fn manifest_artifact(session_dir: &Path, relative_path: &str) -> anyhow::Result<ManifestArtifact> {
    let path = session_dir.join(relative_path);
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)?;
    let metadata = input.metadata()?;
    anyhow::ensure!(
        metadata.is_file(),
        "evidence artifact is not a regular file"
    );
    anyhow::ensure!(
        metadata.permissions().mode() & 0o077 == 0,
        "evidence artifact must be owner-only: {}",
        path.display()
    );
    input.sync_all()?;
    sync_directory(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("artifact has no parent"))?,
    )?;
    input.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ManifestArtifact {
        relative_path: relative_path.to_owned(),
        bytes: metadata.len(),
        sha256: hex::encode(hasher.finalize()),
    })
}

fn create_owner_only_directory(path: &Path) -> anyhow::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn refuse_symlink(path: &Path) -> anyhow::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "refusing symlink artifact: {}",
            path.display()
        );
    }
    Ok(())
}

fn sync_directory(path: &Path) -> anyhow::Result<()> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    directory.sync_all()?;
    Ok(())
}

fn owner_only_file(path: &Path) -> anyhow::Result<File> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}
