use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path},
};

use sha2::{Digest, Sha256};

use crate::domain::RawArtifactRef;

use super::RawView;

/// An Ethernet frame cannot exceed this limit in proxbot's detail view. Keeping
/// the limit here also ensures an untrusted artifact reference cannot cause an
/// unbounded allocation or read.
pub const MAX_PACKET_RAW_BYTES: u64 = 64 * 1024;

pub fn hydrate_packet_raw(session_dir: &Path, view: &mut RawView) -> anyhow::Result<()> {
    let Some(reference) = view.artifact.as_ref() else {
        return Ok(());
    };
    let bytes = read_packet_artifact(session_dir, reference)?;
    view.content = canonical_hex_ascii(&bytes);
    view.media_type = "application/vnd.proxbot.packet+hexdump; charset=utf-8".into();
    view.reconstructed = Some(false);
    view.truncated = Some(false);
    view.masked = Some(false);
    Ok(())
}

pub fn read_packet_artifact(
    session_dir: &Path,
    reference: &RawArtifactRef,
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        reference.length <= MAX_PACKET_RAW_BYTES,
        "packet artifact length {} exceeds the {} byte detail limit",
        reference.length,
        MAX_PACKET_RAW_BYTES
    );
    let end = reference
        .offset
        .checked_add(reference.length)
        .ok_or_else(|| anyhow::anyhow!("packet artifact range overflows u64"))?;
    let relative = validate_relative_path(&reference.relative_path)?;
    let mut file = open_confined_regular_file(session_dir, relative)?;
    let file_length = file.metadata()?.len();
    anyhow::ensure!(
        end <= file_length,
        "packet artifact range {}..{} exceeds file length {}",
        reference.offset,
        end,
        file_length
    );

    file.seek(SeekFrom::Start(reference.offset))?;
    let capacity = usize::try_from(reference.length)
        .map_err(|_| anyhow::anyhow!("packet artifact length does not fit in memory"))?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(reference.length).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() == capacity,
        "packet artifact ended before the referenced range was read"
    );

    if let Some(expected) = reference.sha256.as_deref() {
        anyhow::ensure!(
            expected.len() == 64 && expected.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "packet artifact SHA-256 must contain exactly 64 hexadecimal characters"
        );
        let actual = hex::encode(Sha256::digest(&bytes));
        anyhow::ensure!(
            actual.eq_ignore_ascii_case(expected),
            "packet artifact SHA-256 mismatch"
        );
    }
    Ok(bytes)
}

fn validate_relative_path(value: &str) -> anyhow::Result<&Path> {
    anyhow::ensure!(!value.is_empty(), "packet artifact path must not be empty");
    let path = Path::new(value);
    anyhow::ensure!(path.is_relative(), "packet artifact path must be relative");
    anyhow::ensure!(
        path.components()
            .all(|component| matches!(component, Component::Normal(_))),
        "packet artifact path contains a non-normal component"
    );
    Ok(path)
}

#[cfg(unix)]
fn open_confined_regular_file(root: &Path, relative: &Path) -> anyhow::Result<File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };

    fn open_at(parent: &File, name: &std::ffi::OsStr, directory: bool) -> anyhow::Result<File> {
        let name = CString::new(name.as_bytes())
            .map_err(|_| anyhow::anyhow!("packet artifact path contains a NUL byte"))?;
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        if directory {
            flags |= libc::O_DIRECTORY;
        }
        // SAFETY: `parent` and `name` remain alive for the call, `name` is
        // NUL-terminated, and a successful descriptor is immediately owned by
        // the returned `File`.
        let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: `openat` returned a fresh descriptor that is not owned by any
        // other Rust value.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    use std::os::unix::fs::OpenOptionsExt;
    let root_metadata = std::fs::symlink_metadata(root)?;
    anyhow::ensure!(
        root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
        "session artifact root must be a real directory"
    );
    let mut current = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(root)?;
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            anyhow::bail!("packet artifact path contains a non-normal component");
        };
        current = open_at(&current, name, index + 1 != components.len())?;
    }
    anyhow::ensure!(
        current.metadata()?.is_file(),
        "packet artifact target must be a regular file"
    );
    Ok(current)
}

#[cfg(not(unix))]
fn open_confined_regular_file(root: &Path, relative: &Path) -> anyhow::Result<File> {
    let root_metadata = std::fs::symlink_metadata(root)?;
    anyhow::ensure!(
        root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
        "session artifact root must be a real directory"
    );
    let canonical_root = std::fs::canonicalize(root)?;
    let mut candidate = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            anyhow::bail!("packet artifact path contains a non-normal component");
        };
        candidate.push(name);
        let metadata = std::fs::symlink_metadata(&candidate)?;
        anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "packet artifact path must not contain symbolic links"
        );
    }
    anyhow::ensure!(
        std::fs::canonicalize(&candidate)?.starts_with(&canonical_root),
        "packet artifact escaped the session directory"
    );
    let file = File::open(candidate)?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "packet artifact target must be a regular file"
    );
    Ok(file)
}

/// Format bytes using the stable `hexdump -C` convention: 16 bytes per row,
/// an extra gap between octets 8 and 9, printable ASCII at the right, and the
/// terminal byte offset on the final line.
pub fn canonical_hex_ascii(bytes: &[u8]) -> String {
    let mut output = String::new();
    for (row, chunk) in bytes.chunks(16).enumerate() {
        use std::fmt::Write as _;
        let offset = row * 16;
        let _ = write!(output, "{offset:08x}  ");
        for index in 0..16 {
            if index == 8 {
                output.push(' ');
            }
            if let Some(byte) = chunk.get(index) {
                let _ = write!(output, "{byte:02x} ");
            } else {
                output.push_str("   ");
            }
        }
        output.push_str(" |");
        for byte in chunk {
            output.push(if (0x20..=0x7e).contains(byte) {
                char::from(*byte)
            } else {
                '.'
            });
        }
        output.push_str("|\n");
    }
    use std::fmt::Write as _;
    let _ = writeln!(output, "{:08x}", bytes.len());
    output
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write};

    use tempfile::TempDir;

    use crate::domain::EvidenceClass;

    use super::*;

    fn fixture(root: &Path, bytes: &[u8]) -> RawArtifactRef {
        fs::create_dir_all(root.join("capture")).unwrap();
        let mut file = File::create(root.join("capture/device.pcapng")).unwrap();
        file.write_all(b"prefix").unwrap();
        file.write_all(bytes).unwrap();
        file.write_all(b"suffix").unwrap();
        RawArtifactRef {
            relative_path: "capture/device.pcapng".into(),
            offset: 6,
            length: bytes.len() as u64,
            sha256: Some(hex::encode(Sha256::digest(bytes))),
        }
    }

    fn raw_view(reference: RawArtifactRef) -> RawView {
        RawView {
            content: "packet metadata placeholder".into(),
            media_type: "text/plain".into(),
            evidence: EvidenceClass::Observed,
            reconstructed: None,
            truncated: None,
            masked: None,
            artifact: Some(reference),
        }
    }

    #[test]
    fn hydrates_only_the_referenced_bytes_as_canonical_hex_and_ascii() {
        let root = TempDir::new().unwrap();
        let reference = fixture(root.path(), b"GET /\x00\xff");
        let mut view = raw_view(reference.clone());

        hydrate_packet_raw(root.path(), &mut view).unwrap();

        assert_eq!(
            view.content,
            "00000000  47 45 54 20 2f 00 ff                              |GET /..|\n00000007\n"
        );
        assert_eq!(
            view.media_type,
            "application/vnd.proxbot.packet+hexdump; charset=utf-8"
        );
        assert_eq!(view.reconstructed, Some(false));
        assert_eq!(view.truncated, Some(false));
        assert_eq!(view.masked, Some(false));
        assert_eq!(view.artifact, Some(reference));
    }

    #[test]
    fn formats_two_octet_groups_and_printable_ascii_stably() {
        let bytes = (0u8..=16).collect::<Vec<_>>();
        assert_eq!(
            canonical_hex_ascii(&bytes),
            concat!(
                "00000000  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|\n",
                "00000010  10                                                |.|\n",
                "00000011\n"
            )
        );
    }

    #[test]
    fn rejects_parent_paths_absolute_paths_and_empty_paths() {
        let root = TempDir::new().unwrap();
        for path in ["../outside", "/tmp/outside", ""] {
            let reference = RawArtifactRef {
                relative_path: path.into(),
                offset: 0,
                length: 0,
                sha256: None,
            };
            assert!(read_packet_artifact(root.path(), &reference).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_final_and_intermediate_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("packet"), b"secret").unwrap();
        symlink(
            outside.path().join("packet"),
            root.path().join("final-link"),
        )
        .unwrap();
        symlink(outside.path(), root.path().join("directory-link")).unwrap();

        for path in ["final-link", "directory-link/packet"] {
            let reference = RawArtifactRef {
                relative_path: path.into(),
                offset: 0,
                length: 6,
                sha256: None,
            };
            assert!(read_packet_artifact(root.path(), &reference).is_err());
        }
    }

    #[test]
    fn rejects_oversized_invalid_and_overflowing_ranges() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("packet"), b"small").unwrap();
        for (offset, length) in [(0, MAX_PACKET_RAW_BYTES + 1), (4, 2), (u64::MAX, 2)] {
            let reference = RawArtifactRef {
                relative_path: "packet".into(),
                offset,
                length,
                sha256: None,
            };
            assert!(read_packet_artifact(root.path(), &reference).is_err());
        }
    }

    #[test]
    fn rejects_invalid_or_mismatched_hashes() {
        let root = TempDir::new().unwrap();
        let mut reference = fixture(root.path(), b"packet");
        for hash in ["xyz".to_string(), "0".repeat(64)] {
            reference.sha256 = Some(hash);
            assert!(read_packet_artifact(root.path(), &reference).is_err());
        }
    }
}
