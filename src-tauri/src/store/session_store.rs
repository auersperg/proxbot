use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Write},
    os::unix::fs::PermissionsExt,
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
        let session_dir = root.join(session_id.to_string());
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
            fs::create_dir_all(session_dir.join(relative))?;
        }
        fs::set_permissions(&session_dir, fs::Permissions::from_mode(0o700))?;
        let partial_path = session_dir.join("events/provider-events.jsonl.partial");
        let file = owner_only_file(&partial_path)?;
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

    pub fn finalize(mut self) -> anyhow::Result<SessionSummary> {
        self.writer.flush()?;
        self.writer.get_ref().sync_all()?;
        let final_events = self.session_dir.join("events/provider-events.jsonl");
        fs::rename(&self.partial_path, &final_events)?;

        let manifest = Manifest {
            schema_version: 1,
            session_id: self.session_id,
            status: "ready",
            event_count: self.event_count,
        };
        let manifest_partial = self.session_dir.join("manifest.json.partial");
        let mut manifest_file = owner_only_file(&manifest_partial)?;
        serde_json::to_writer_pretty(&mut manifest_file, &manifest)?;
        manifest_file.write_all(b"\n")?;
        manifest_file.sync_all()?;
        fs::rename(manifest_partial, self.session_dir.join("manifest.json"))?;

        let checksum = sha256_file(&final_events)?;
        let checksums_path = self.session_dir.join("checksums.sha256");
        let mut checksums = owner_only_file(&checksums_path)?;
        writeln!(checksums, "{checksum}  events/provider-events.jsonl")?;
        checksums.sync_all()?;
        File::open(&self.session_dir)?.sync_all()?;

        Ok(SessionSummary {
            session_id: self.session_id,
            session_dir: self.session_dir,
            event_count: self.event_count,
        })
    }
}

fn owner_only_file(path: &Path) -> anyhow::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let mut input = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}
