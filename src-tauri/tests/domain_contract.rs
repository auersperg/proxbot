use serde_json::json;
use trace_lab_lib::domain::{
    EvidenceClass, ParseStatus, ProviderEvent, ProviderState, SessionCoordinator, SessionError,
    SessionStatus,
};
use uuid::Uuid;

fn event(session_id: Uuid, sequence: u64) -> ProviderEvent {
    ProviderEvent {
        schema_version: 1,
        provider_id: "fake".into(),
        provider_version: "1.0.0".into(),
        session_id,
        sequence,
        source_time_ns: 1_000 + sequence as i64,
        host_time_ns: 2_000 + sequence as i64,
        monotonic_time_ns: Some(500 + sequence as i64),
        device_id: Some("fixture-device".into()),
        process_id: Some(42),
        process_name: Some("FixtureApp".into()),
        evidence: EvidenceClass::Observed,
        kind: "network.request".into(),
        payload: json!({"url": "https://fixture.invalid/"}),
        raw_ref: None,
        parse_status: ParseStatus::Raw,
    }
}

#[test]
fn provider_event_round_trips_with_explicit_evidence_and_parse_status() {
    let original = event(Uuid::nil(), 7);
    let encoded = serde_json::to_string(&original).unwrap();
    assert!(encoded.contains("\"evidence\":\"observed\""));
    assert!(encoded.contains("\"parse_status\":\"raw\""));
    assert_eq!(
        serde_json::from_str::<ProviderEvent>(&encoded).unwrap(),
        original
    );
}

#[test]
fn session_enforces_valid_transitions_and_degradation() {
    let mut session = SessionCoordinator::new(Uuid::nil());
    session.register_provider("fake").unwrap();
    session.prepare().unwrap();
    session.start().unwrap();
    session
        .set_provider_state("fake", ProviderState::Degraded)
        .unwrap();
    assert_eq!(session.status(), SessionStatus::Degraded);
    session.stop().unwrap();
    assert_eq!(session.status(), SessionStatus::Finalizing);
    session.finalize().unwrap();
    assert_eq!(session.status(), SessionStatus::Ready);
}

#[test]
fn session_rejects_start_before_prepare() {
    let mut session = SessionCoordinator::new(Uuid::nil());
    assert_eq!(
        session.start().unwrap_err(),
        SessionError::InvalidTransition {
            from: SessionStatus::Created,
            action: "start",
        }
    );
}

#[test]
fn duplicate_and_unknown_providers_are_rejected() {
    let mut session = SessionCoordinator::new(Uuid::nil());
    session.register_provider("fake").unwrap();
    assert_eq!(
        session.register_provider("fake").unwrap_err(),
        SessionError::DuplicateProvider("fake".into())
    );
    assert_eq!(
        session
            .set_provider_state("missing", ProviderState::Failed)
            .unwrap_err(),
        SessionError::UnknownProvider("missing".into())
    );
}
