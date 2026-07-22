use tokio::io::{AsyncRead, AsyncReadExt};

use crate::domain::ProviderEvent;

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> anyhow::Result<Option<ProviderEvent>> {
    let size = match reader.read_u32().await {
        Ok(size) => size as usize,
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        size <= MAX_FRAME_BYTES,
        "provider frame exceeds {MAX_FRAME_BYTES} bytes"
    );
    let mut payload = vec![0_u8; size];
    reader.read_exact(&mut payload).await?;
    Ok(Some(rmp_serde::from_slice(&payload)?))
}
