use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceClass {
    Observed,
    Enriched,
    Inferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Raw,
    Parsed,
    Malformed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawArtifactRef {
    pub relative_path: String,
    pub offset: u64,
    pub length: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderEvent {
    pub schema_version: u16,
    pub provider_id: String,
    pub provider_version: String,
    #[serde(with = "uuid_string")]
    pub session_id: Uuid,
    pub sequence: u64,
    pub source_time_ns: i64,
    pub host_time_ns: i64,
    pub monotonic_time_ns: Option<i64>,
    pub device_id: Option<String>,
    pub process_id: Option<u32>,
    pub process_name: Option<String>,
    pub evidence: EvidenceClass,
    pub kind: String,
    pub payload: Value,
    pub raw_ref: Option<RawArtifactRef>,
    pub parse_status: ParseStatus,
}

mod uuid_string {
    use serde::{Deserialize, Deserializer, Serializer};
    use uuid::Uuid;

    pub fn serialize<S>(value: &Uuid, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Uuid, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Uuid::parse_str(&value).map_err(serde::de::Error::custom)
    }
}
