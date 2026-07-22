use rusqlite::{
    OptionalExtension, Transaction, params, params_from_iter, types::Value as SqlValue,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::{EvidenceClass, ProviderEvent, RawArtifactRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    Domain,
    Ip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointFilter {
    pub kind: EndpointKind,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EndpointSummary {
    pub kind: EndpointKind,
    pub value: String,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawView {
    pub content: String,
    pub media_type: String,
    pub reconstructed: bool,
    pub truncated: bool,
    pub masked: bool,
    pub artifact: Option<RawArtifactRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExchangeRow {
    pub request_id: String,
    pub request_sequence: Option<u64>,
    pub response_sequence: Option<u64>,
    pub started_ns: i64,
    pub method: Option<String>,
    pub scheme: Option<String>,
    pub host: Option<String>,
    pub ip: Option<String>,
    pub path: Option<String>,
    pub status: Option<u16>,
    pub protocol: Option<String>,
    pub process_name: Option<String>,
    pub duration_ms: Option<u64>,
    pub request_bytes: Option<u64>,
    pub response_bytes: Option<u64>,
    pub tls: Option<String>,
    pub evidence: EvidenceClass,
    pub warning: Option<String>,
    pub request_raw: Option<RawView>,
    pub response_raw: Option<RawView>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangePage {
    pub exchanges: Vec<ExchangeRow>,
    pub total: u64,
}

fn text(event: &ProviderEvent, key: &str) -> Option<String> {
    event.payload.get(key)?.as_str().map(ToOwned::to_owned)
}

fn unsigned(event: &ProviderEvent, key: &str) -> Option<u64> {
    event.payload.get(key)?.as_u64()
}

fn flag(event: &ProviderEvent, key: &str) -> bool {
    event
        .payload
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn evidence_text(evidence: EvidenceClass) -> &'static str {
    match evidence {
        EvidenceClass::Observed => "observed",
        EvidenceClass::Enriched => "enriched",
        EvidenceClass::Inferred => "inferred",
    }
}

pub(super) fn materialize_event(
    transaction: &Transaction<'_>,
    event: &ProviderEvent,
) -> anyhow::Result<()> {
    if event.kind != "network.request" && event.kind != "network.response" {
        return Ok(());
    }
    let Some(request_id) = text(event, "request_id") else {
        return Ok(());
    };
    let raw = text(event, "raw");
    let media_type = text(event, "media_type").unwrap_or_else(|| "application/octet-stream".into());
    let artifact = event
        .raw_ref
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;

    if event.kind == "network.request" {
        transaction.execute(
            "INSERT INTO exchanges (
                session_id, request_id, request_sequence, started_ns, method, scheme, host, ip,
                path, protocol, process_name, request_bytes, tls, evidence, warning,
                request_raw, request_media_type, request_reconstructed, request_truncated,
                request_masked, request_artifact_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                       'response_missing', ?15, ?16, ?17, ?18, ?19, ?20)
             ON CONFLICT(session_id, request_id) DO UPDATE SET
                request_sequence=excluded.request_sequence, started_ns=excluded.started_ns,
                method=excluded.method, scheme=excluded.scheme, host=excluded.host, ip=excluded.ip,
                path=excluded.path, protocol=excluded.protocol, process_name=excluded.process_name,
                request_bytes=excluded.request_bytes, tls=excluded.tls, evidence=excluded.evidence,
                request_raw=excluded.request_raw, request_media_type=excluded.request_media_type,
                request_reconstructed=excluded.request_reconstructed,
                request_truncated=excluded.request_truncated, request_masked=excluded.request_masked,
                request_artifact_json=excluded.request_artifact_json,
                warning=CASE
                    WHEN exchanges.response_sequence IS NULL THEN 'response_missing'
                    WHEN exchanges.warning LIKE '%invalid_status%' THEN 'invalid_status'
                    ELSE NULL
                END",
            params![
                event.session_id.to_string(), request_id, event.sequence as i64, event.host_time_ns,
                text(event, "method"), text(event, "scheme"), text(event, "host"), text(event, "ip"),
                text(event, "path"), text(event, "protocol"), event.process_name,
                unsigned(event, "request_bytes").map(|v| v as i64), text(event, "tls"),
                evidence_text(event.evidence), raw, media_type, flag(event, "reconstructed"),
                flag(event, "truncated"), flag(event, "masked"), artifact,
            ],
        )?;
    } else {
        let supplied_status = unsigned(event, "status");
        let status = supplied_status.and_then(|value| u16::try_from(value).ok());
        let invalid_status = supplied_status.is_some() && status.is_none();
        let missing_request_warning = if invalid_status {
            "request_missing;invalid_status"
        } else {
            "request_missing"
        };
        let paired_warning = invalid_status.then_some("invalid_status");
        transaction.execute(
            "INSERT INTO exchanges (
                session_id, request_id, response_sequence, started_ns, status, protocol,
                process_name, duration_ms, response_bytes, evidence, warning, response_raw,
                response_media_type, response_reconstructed, response_truncated,
                response_masked, response_artifact_json, request_raw, request_media_type
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17, NULL, NULL)
             ON CONFLICT(session_id, request_id) DO UPDATE SET
                response_sequence=excluded.response_sequence, status=excluded.status,
                protocol=COALESCE(exchanges.protocol, excluded.protocol),
                duration_ms=excluded.duration_ms, response_bytes=excluded.response_bytes,
                response_raw=excluded.response_raw, response_media_type=excluded.response_media_type,
                response_reconstructed=excluded.response_reconstructed,
                response_truncated=excluded.response_truncated, response_masked=excluded.response_masked,
                response_artifact_json=excluded.response_artifact_json,
                warning=CASE WHEN exchanges.request_sequence IS NULL THEN excluded.warning ELSE ?18 END",
            params![
                event.session_id.to_string(), request_id, event.sequence as i64, event.host_time_ns,
                status.map(i64::from), text(event, "protocol"),
                event.process_name, unsigned(event, "duration_ms").map(|v| v as i64),
                unsigned(event, "response_bytes").map(|v| v as i64), evidence_text(event.evidence),
                missing_request_warning, raw, media_type, flag(event, "reconstructed"),
                flag(event, "truncated"), flag(event, "masked"), artifact, paired_warning,
            ],
        )?;
    }
    Ok(())
}

fn escaped_like(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn evidence(value: String) -> rusqlite::Result<EvidenceClass> {
    match value.as_str() {
        "observed" => Ok(EvidenceClass::Observed),
        "enriched" => Ok(EvidenceClass::Enriched),
        "inferred" => Ok(EvidenceClass::Inferred),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            16,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unsupported evidence class {value}"),
            )),
        )),
    }
}

fn artifact(value: Option<String>) -> rusqlite::Result<Option<RawArtifactRef>> {
    value
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()
}

fn exchange_detail_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExchangeRow> {
    let request_content: Option<String> = row.get(18)?;
    let response_content: Option<String> = row.get(19)?;
    let request_artifact = artifact(row.get(28)?)?;
    let response_artifact = artifact(row.get(29)?)?;
    let request_media_type: Option<String> = row.get(20)?;
    let response_media_type: Option<String> = row.get(21)?;
    let request_reconstructed: bool = row.get(22)?;
    let response_reconstructed: bool = row.get(23)?;
    let request_truncated: bool = row.get(24)?;
    let response_truncated: bool = row.get(25)?;
    let request_masked: bool = row.get(26)?;
    let response_masked: bool = row.get(27)?;
    let request_raw = request_content.map(|content| RawView {
        content,
        media_type: request_media_type.unwrap_or_else(|| "application/octet-stream".into()),
        reconstructed: request_reconstructed,
        truncated: request_truncated,
        masked: request_masked,
        artifact: request_artifact,
    });
    let response_raw = response_content.map(|content| RawView {
        content,
        media_type: response_media_type.unwrap_or_else(|| "application/octet-stream".into()),
        reconstructed: response_reconstructed,
        truncated: response_truncated,
        masked: response_masked,
        artifact: response_artifact,
    });
    Ok(ExchangeRow {
        request_id: row.get(0)?,
        request_sequence: row.get::<_, Option<i64>>(1)?.map(|v| v as u64),
        response_sequence: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
        started_ns: row.get(3)?,
        method: row.get(4)?,
        scheme: row.get(5)?,
        host: row.get(6)?,
        ip: row.get(7)?,
        path: row.get(8)?,
        status: row.get::<_, Option<i64>>(9)?.map(|v| v as u16),
        protocol: row.get(10)?,
        process_name: row.get(11)?,
        duration_ms: row.get::<_, Option<i64>>(12)?.map(|v| v as u64),
        request_bytes: row.get::<_, Option<i64>>(13)?.map(|v| v as u64),
        response_bytes: row.get::<_, Option<i64>>(14)?.map(|v| v as u64),
        tls: row.get(15)?,
        evidence: evidence(row.get(16)?)?,
        warning: row.get(17)?,
        request_raw,
        response_raw,
    })
}

pub(super) fn page_exchanges(
    transaction: &rusqlite::Connection,
    session_id: Uuid,
    query: &str,
    endpoint: Option<&EndpointFilter>,
    offset: u64,
    limit: u64,
) -> anyhow::Result<ExchangePage> {
    let mut where_sql = String::from("session_id = ?1");
    let mut values = vec![SqlValue::Text(session_id.to_string())];
    if !query.trim().is_empty() {
        values.push(SqlValue::Text(escaped_like(query.trim())));
        let n = values.len();
        where_sql.push_str(&format!(" AND (COALESCE(method,'') LIKE ?{n} ESCAPE '\\' OR COALESCE(host,'') LIKE ?{n} ESCAPE '\\' OR COALESCE(ip,'') LIKE ?{n} ESCAPE '\\' OR COALESCE(path,'') LIKE ?{n} ESCAPE '\\' OR COALESCE(protocol,'') LIKE ?{n} ESCAPE '\\')"));
    }
    if let Some(endpoint) = endpoint {
        values.push(SqlValue::Text(endpoint.value.clone()));
        let column = match endpoint.kind {
            EndpointKind::Domain => "host",
            EndpointKind::Ip => "ip",
        };
        where_sql.push_str(&format!(" AND {column} = ?{}", values.len()));
    }
    let total: i64 = transaction.query_row(
        &format!("SELECT COUNT(*) FROM exchanges WHERE {where_sql}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;
    let bounded_limit = limit.clamp(1, 500);
    let mut page_values = values;
    page_values.push(SqlValue::Integer(bounded_limit as i64));
    let limit_parameter = page_values.len();
    page_values.push(SqlValue::Integer(offset as i64));
    let offset_parameter = page_values.len();
    let mut statement = transaction.prepare(&format!(
        "SELECT request_id, request_sequence, response_sequence, started_ns, method, scheme,
                host, ip, path, status, protocol, process_name, duration_ms, request_bytes,
                response_bytes, tls, evidence, warning
         FROM exchanges WHERE {where_sql}
         ORDER BY started_ns, request_id LIMIT ?{limit_parameter} OFFSET ?{offset_parameter}"
    ))?;
    let rows = statement.query_map(params_from_iter(page_values.iter()), |row| {
        Ok(ExchangeRow {
            request_id: row.get(0)?,
            request_sequence: row.get::<_, Option<i64>>(1)?.map(|v| v as u64),
            response_sequence: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
            started_ns: row.get(3)?,
            method: row.get(4)?,
            scheme: row.get(5)?,
            host: row.get(6)?,
            ip: row.get(7)?,
            path: row.get(8)?,
            status: row.get::<_, Option<i64>>(9)?.map(|v| v as u16),
            protocol: row.get(10)?,
            process_name: row.get(11)?,
            duration_ms: row.get::<_, Option<i64>>(12)?.map(|v| v as u64),
            request_bytes: row.get::<_, Option<i64>>(13)?.map(|v| v as u64),
            response_bytes: row.get::<_, Option<i64>>(14)?.map(|v| v as u64),
            tls: row.get(15)?,
            evidence: evidence(row.get(16)?)?,
            warning: row.get(17)?,
            request_raw: None,
            response_raw: None,
        })
    })?;
    let exchanges = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ExchangePage {
        exchanges,
        total: total as u64,
    })
}

pub(super) fn get_exchange(
    connection: &rusqlite::Connection,
    session_id: Uuid,
    request_id: &str,
) -> anyhow::Result<Option<ExchangeRow>> {
    let mut statement = connection.prepare(
        "SELECT request_id, request_sequence, response_sequence, started_ns, method, scheme,
                host, ip, path, status, protocol, process_name, duration_ms, request_bytes,
                response_bytes, tls, evidence, warning, request_raw, response_raw,
                request_media_type, response_media_type, request_reconstructed,
                response_reconstructed, request_truncated, response_truncated,
                request_masked, response_masked, request_artifact_json, response_artifact_json
         FROM exchanges WHERE session_id = ?1 AND request_id = ?2",
    )?;
    Ok(statement
        .query_row(
            params![session_id.to_string(), request_id],
            exchange_detail_from_row,
        )
        .optional()?)
}

pub(super) fn list_endpoints(
    connection: &rusqlite::Connection,
    session_id: Uuid,
    query: &str,
    limit: u64,
) -> anyhow::Result<Vec<EndpointSummary>> {
    let bounded_limit = limit.clamp(1, 2000);
    let like = escaped_like(query.trim());
    let mut summaries = Vec::new();
    for (kind, column) in [(EndpointKind::Domain, "host"), (EndpointKind::Ip, "ip")] {
        let sql = format!(
            "SELECT {column}, COUNT(*) FROM exchanges
             WHERE session_id = ?1 AND {column} IS NOT NULL AND {column} != ''
               AND (?2 = '%%'
                    OR COALESCE(method,'') LIKE ?2 ESCAPE '\\'
                    OR COALESCE(host,'') LIKE ?2 ESCAPE '\\'
                    OR COALESCE(ip,'') LIKE ?2 ESCAPE '\\'
                    OR COALESCE(path,'') LIKE ?2 ESCAPE '\\'
                    OR COALESCE(protocol,'') LIKE ?2 ESCAPE '\\')
             GROUP BY {column} ORDER BY COUNT(*) DESC, {column} LIMIT ?3"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![session_id.to_string(), like, bounded_limit as i64],
            |row| {
                Ok(EndpointSummary {
                    kind,
                    value: row.get(0)?,
                    count: row.get::<_, i64>(1)? as u64,
                })
            },
        )?;
        summaries.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    summaries.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.value.cmp(&b.value))
    });
    summaries.truncate(bounded_limit as usize);
    Ok(summaries)
}

impl Ord for EndpointKind {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (*self as u8).cmp(&(*other as u8))
    }
}
impl PartialOrd for EndpointKind {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
