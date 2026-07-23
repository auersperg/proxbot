use tokio::io::{AsyncRead, AsyncReadExt};

use crate::domain::ProviderEvent;

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// Cancellation-safe reader for the provider's length-prefixed MessagePack
/// stream.
///
/// `tokio::select!` drops losing branch futures. A plain `read_exact` frame
/// read can therefore consume part of a frame and then lose those bytes when
/// the future is cancelled, desynchronizing every subsequent frame. This
/// reader owns the partial buffer across `next_frame` calls and only performs
/// cancellation-safe `read` operations, so timer/action branches cannot
/// corrupt a busy provider stream.
pub struct FrameReader<R> {
    inner: R,
    buffered: Vec<u8>,
    expected_payload: Option<usize>,
}

impl<R> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buffered: Vec::with_capacity(READ_CHUNK_BYTES),
            expected_payload: None,
        }
    }
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub async fn next_frame(&mut self) -> anyhow::Result<Option<ProviderEvent>> {
        loop {
            if self.expected_payload.is_none() && self.buffered.len() >= 4 {
                let size =
                    u32::from_be_bytes(self.buffered[..4].try_into().expect("four-byte prefix"))
                        as usize;
                anyhow::ensure!(
                    size <= MAX_FRAME_BYTES,
                    "provider frame exceeds {MAX_FRAME_BYTES} bytes"
                );
                self.buffered.drain(..4);
                self.expected_payload = Some(size);
            }

            if let Some(size) = self.expected_payload
                && self.buffered.len() >= size
            {
                let payload: Vec<u8> = self.buffered.drain(..size).collect();
                self.expected_payload = None;
                return Ok(Some(rmp_serde::from_slice(&payload)?));
            }

            let mut chunk = [0_u8; READ_CHUNK_BYTES];
            let read = self.inner.read(&mut chunk).await?;
            if read == 0 {
                if self.buffered.is_empty() && self.expected_payload.is_none() {
                    return Ok(None);
                }
                anyhow::bail!("provider disconnected during a partial frame");
            }
            self.buffered.extend_from_slice(&chunk[..read]);
        }
    }
}

pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> anyhow::Result<Option<ProviderEvent>> {
    FrameReader::new(reader).next_frame().await
}
