use proxbot_lib::domain::{EvidenceClass, ParseStatus, ProviderEvent};
use proxbot_lib::provider::{FrameReader, read_frame};
use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};
use uuid::Uuid;

fn event() -> ProviderEvent {
    ProviderEvent {
        schema_version: 1,
        provider_id: "fake".into(),
        provider_version: "0.1.0".into(),
        session_id: Uuid::nil(),
        sequence: 0,
        source_time_ns: 1,
        host_time_ns: 2,
        monotonic_time_ns: Some(3),
        device_id: Some("fixture".into()),
        process_id: Some(42),
        process_name: Some("FixtureApp".into()),
        evidence: EvidenceClass::Observed,
        kind: "provider.ready".into(),
        payload: json!({"ready": true}),
        raw_ref: None,
        parse_status: ParseStatus::Parsed,
    }
}

#[tokio::test]
async fn rust_reads_big_endian_messagepack_provider_frames() {
    let original = event();
    let payload = rmp_serde::to_vec_named(&original).unwrap();
    let (mut writer, reader) = tokio::io::duplex(4096);
    writer.write_u32(payload.len() as u32).await.unwrap();
    writer.write_all(&payload).await.unwrap();
    drop(writer);

    assert_eq!(
        read_frame(&mut BufReader::new(reader)).await.unwrap(),
        Some(original)
    );
}

#[tokio::test]
async fn rust_rejects_provider_frames_larger_than_sixteen_megabytes() {
    let (mut writer, reader) = tokio::io::duplex(16);
    writer.write_u32(16 * 1024 * 1024 + 1).await.unwrap();
    drop(writer);

    let error = read_frame(&mut BufReader::new(reader)).await.unwrap_err();
    assert!(error.to_string().contains("provider frame exceeds"));
}

#[tokio::test]
async fn persistent_frame_reader_survives_cancellation_after_partial_frame() {
    let original = event();
    let payload = rmp_serde::to_vec_named(&original).unwrap();
    let split = payload.len() / 2;
    let (mut writer, reader) = tokio::io::duplex(4096);
    writer.write_u32(payload.len() as u32).await.unwrap();
    writer.write_all(&payload[..split]).await.unwrap();

    let mut reader = FrameReader::new(reader);
    let cancelled =
        tokio::time::timeout(std::time::Duration::from_millis(10), reader.next_frame()).await;
    assert!(cancelled.is_err(), "partial frame unexpectedly completed");

    writer.write_all(&payload[split..]).await.unwrap();
    drop(writer);
    assert_eq!(reader.next_frame().await.unwrap(), Some(original));
    assert_eq!(reader.next_frame().await.unwrap(), None);
}
