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
    pub evidence: EvidenceClass,
    pub reconstructed: Option<bool>,
    pub truncated: Option<bool>,
    pub masked: Option<bool>,
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

fn flag(event: &ProviderEvent, key: &str) -> Option<bool> {
    event.payload.get(key).and_then(|value| value.as_bool())
}

fn sqlite_i64(value: u64, field: &str) -> anyhow::Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("{field} exceeds SQLite INTEGER range"))
}

fn optional_sqlite_i64(value: Option<u64>, field: &str) -> anyhow::Result<Option<i64>> {
    value.map(|number| sqlite_i64(number, field)).transpose()
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
    anyhow::ensure!(
        !request_id.trim().is_empty() && request_id.len() <= 512,
        "network event request_id must contain 1..=512 bytes"
    );
    let sequence = sqlite_i64(event.sequence, "event sequence")?;
    let raw = text(event, "raw");
    let media_type = text(event, "media_type").unwrap_or_else(|| "application/octet-stream".into());
    let artifact = event
        .raw_ref
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let event_evidence = evidence_text(event.evidence);

    if event.kind == "network.request" {
        transaction.execute(
            "INSERT INTO exchanges (
                session_id, request_id, request_sequence, started_ns, method, scheme, host, ip,
                path, protocol, process_name, request_bytes, tls, evidence, request_evidence,
                warning, request_raw, request_media_type, request_reconstructed_state,
                request_truncated_state, request_masked_state, request_artifact_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                       ?14, 'response_missing', ?15, ?16, ?17, ?18, ?19, ?20)
             ON CONFLICT(session_id, request_id) DO UPDATE SET
                request_sequence=excluded.request_sequence, started_ns=excluded.started_ns,
                method=excluded.method, scheme=excluded.scheme, host=excluded.host, ip=excluded.ip,
                path=excluded.path, protocol=excluded.protocol, process_name=excluded.process_name,
                request_bytes=excluded.request_bytes, tls=excluded.tls,
                request_evidence=excluded.request_evidence,
                evidence=CASE
                    WHEN excluded.request_evidence = 'inferred' OR exchanges.response_evidence = 'inferred' THEN 'inferred'
                    WHEN excluded.request_evidence = 'enriched' OR exchanges.response_evidence = 'enriched' THEN 'enriched'
                    ELSE 'observed'
                END,
                request_raw=excluded.request_raw, request_media_type=excluded.request_media_type,
                request_reconstructed_state=excluded.request_reconstructed_state,
                request_truncated_state=excluded.request_truncated_state,
                request_masked_state=excluded.request_masked_state,
                request_artifact_json=excluded.request_artifact_json,
                warning=CASE
                    WHEN exchanges.response_sequence IS NULL THEN 'response_missing'
                    WHEN exchanges.warning LIKE '%invalid_status%' THEN 'invalid_status'
                    ELSE NULL
                END",
            params![
                event.session_id.to_string(),
                request_id,
                sequence,
                event.host_time_ns,
                text(event, "method"),
                text(event, "scheme"),
                text(event, "host"),
                text(event, "ip"),
                text(event, "path"),
                text(event, "protocol"),
                event.process_name,
                optional_sqlite_i64(unsigned(event, "request_bytes"), "request_bytes")?,
                text(event, "tls"),
                event_evidence,
                raw,
                media_type,
                flag(event, "reconstructed"),
                flag(event, "truncated"),
                flag(event, "masked"),
                artifact,
            ],
        )?;
    } else {
        let supplied_status = event.payload.get("status");
        let status = supplied_status
            .and_then(|value| value.as_u64())
            .filter(|value| (100..=599).contains(value));
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
                process_name, duration_ms, response_bytes, evidence, response_evidence, warning,
                response_raw, response_media_type, response_reconstructed_state,
                response_truncated_state, response_masked_state, response_artifact_json,
                request_raw, request_media_type
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17, NULL, NULL)
             ON CONFLICT(session_id, request_id) DO UPDATE SET
                response_sequence=excluded.response_sequence, status=excluded.status,
                protocol=COALESCE(exchanges.protocol, excluded.protocol),
                duration_ms=excluded.duration_ms, response_bytes=excluded.response_bytes,
                response_evidence=excluded.response_evidence,
                evidence=CASE
                    WHEN exchanges.request_evidence = 'inferred' OR excluded.response_evidence = 'inferred' THEN 'inferred'
                    WHEN exchanges.request_evidence = 'enriched' OR excluded.response_evidence = 'enriched' THEN 'enriched'
                    ELSE 'observed'
                END,
                response_raw=excluded.response_raw, response_media_type=excluded.response_media_type,
                response_reconstructed_state=excluded.response_reconstructed_state,
                response_truncated_state=excluded.response_truncated_state,
                response_masked_state=excluded.response_masked_state,
                response_artifact_json=excluded.response_artifact_json,
                warning=CASE WHEN exchanges.request_sequence IS NULL THEN excluded.warning ELSE ?18 END",
            params![
                event.session_id.to_string(),
                request_id,
                sequence,
                event.host_time_ns,
                status.map(|value| value as i64),
                text(event, "protocol"),
                event.process_name,
                optional_sqlite_i64(unsigned(event, "duration_ms"), "duration_ms")?,
                optional_sqlite_i64(unsigned(event, "response_bytes"), "response_bytes")?,
                event_evidence,
                missing_request_warning,
                raw,
                media_type,
                flag(event, "reconstructed"),
                flag(event, "truncated"),
                flag(event, "masked"),
                artifact,
                paired_warning,
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

fn conversion_error(
    index: usize,
    data_type: rusqlite::types::Type,
    message: String,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        data_type,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn optional_u64(
    row: &rusqlite::Row<'_>,
    index: usize,
    field: &str,
) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u64::try_from(value).map_err(|_| {
                conversion_error(
                    index,
                    rusqlite::types::Type::Integer,
                    format!("{field} must be a non-negative 64-bit value; found {value}"),
                )
            })
        })
        .transpose()
}

fn optional_status(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<u16>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            if (100..=599).contains(&value) {
                Ok(value as u16)
            } else {
                Err(conversion_error(
                    index,
                    rusqlite::types::Type::Integer,
                    format!("status must be a valid HTTP status (100..=599); found {value}"),
                ))
            }
        })
        .transpose()
}

fn optional_flag(
    row: &rusqlite::Row<'_>,
    index: usize,
    field: &str,
) -> rusqlite::Result<Option<bool>> {
    match row.get::<_, Option<i64>>(index)? {
        None => Ok(None),
        Some(0) => Ok(Some(false)),
        Some(1) => Ok(Some(true)),
        Some(value) => Err(conversion_error(
            index,
            rusqlite::types::Type::Integer,
            format!("{field} must be 0, 1, or NULL; found {value}"),
        )),
    }
}

fn required_evidence(
    value: Option<String>,
    index: usize,
    field: &str,
) -> rusqlite::Result<EvidenceClass> {
    let value = value.ok_or_else(|| {
        conversion_error(
            index,
            rusqlite::types::Type::Null,
            format!("{field} is missing for raw evidence"),
        )
    })?;
    evidence(value)
}

fn exchange_detail_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExchangeRow> {
    let request_content: Option<String> = row.get(18)?;
    let response_content: Option<String> = row.get(19)?;
    let request_artifact = artifact(row.get(30)?)?;
    let response_artifact = artifact(row.get(31)?)?;
    let request_media_type: Option<String> = row.get(20)?;
    let response_media_type: Option<String> = row.get(21)?;
    let request_evidence: Option<String> = row.get(22)?;
    let response_evidence: Option<String> = row.get(23)?;
    let request_reconstructed = optional_flag(row, 24, "request_reconstructed")?;
    let response_reconstructed = optional_flag(row, 25, "response_reconstructed")?;
    let request_truncated = optional_flag(row, 26, "request_truncated")?;
    let response_truncated = optional_flag(row, 27, "response_truncated")?;
    let request_masked = optional_flag(row, 28, "request_masked")?;
    let response_masked = optional_flag(row, 29, "response_masked")?;
    let request_raw = request_content
        .map(|content| {
            Ok::<RawView, rusqlite::Error>(RawView {
                content,
                media_type: request_media_type.unwrap_or_else(|| "application/octet-stream".into()),
                evidence: required_evidence(request_evidence, 22, "request_evidence")?,
                reconstructed: request_reconstructed,
                truncated: request_truncated,
                masked: request_masked,
                artifact: request_artifact,
            })
        })
        .transpose()?;
    let response_raw = response_content
        .map(|content| {
            Ok::<RawView, rusqlite::Error>(RawView {
                content,
                media_type: response_media_type
                    .unwrap_or_else(|| "application/octet-stream".into()),
                evidence: required_evidence(response_evidence, 23, "response_evidence")?,
                reconstructed: response_reconstructed,
                truncated: response_truncated,
                masked: response_masked,
                artifact: response_artifact,
            })
        })
        .transpose()?;
    Ok(ExchangeRow {
        request_id: row.get(0)?,
        request_sequence: optional_u64(row, 1, "request_sequence")?,
        response_sequence: optional_u64(row, 2, "response_sequence")?,
        started_ns: row.get(3)?,
        method: row.get(4)?,
        scheme: row.get(5)?,
        host: row.get(6)?,
        ip: row.get(7)?,
        path: row.get(8)?,
        status: optional_status(row, 9)?,
        protocol: row.get(10)?,
        process_name: row.get(11)?,
        duration_ms: optional_u64(row, 12, "duration_ms")?,
        request_bytes: optional_u64(row, 13, "request_bytes")?,
        response_bytes: optional_u64(row, 14, "response_bytes")?,
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
    anyhow::ensure!(query.len() <= 1_024, "query must not exceed 1024 bytes");
    if let Some(endpoint) = endpoint {
        anyhow::ensure!(
            !endpoint.value.trim().is_empty() && endpoint.value.len() <= 512,
            "endpoint value must contain 1..=512 bytes"
        );
    }
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
    page_values.push(SqlValue::Integer(sqlite_i64(offset, "page offset")?));
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
            request_sequence: optional_u64(row, 1, "request_sequence")?,
            response_sequence: optional_u64(row, 2, "response_sequence")?,
            started_ns: row.get(3)?,
            method: row.get(4)?,
            scheme: row.get(5)?,
            host: row.get(6)?,
            ip: row.get(7)?,
            path: row.get(8)?,
            status: optional_status(row, 9)?,
            protocol: row.get(10)?,
            process_name: row.get(11)?,
            duration_ms: optional_u64(row, 12, "duration_ms")?,
            request_bytes: optional_u64(row, 13, "request_bytes")?,
            response_bytes: optional_u64(row, 14, "response_bytes")?,
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
        total: u64::try_from(total)?,
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
                request_media_type, response_media_type, request_evidence, response_evidence,
                request_reconstructed_state, response_reconstructed_state,
                request_truncated_state, response_truncated_state,
                request_masked_state, response_masked_state,
                request_artifact_json, response_artifact_json
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
    anyhow::ensure!(query.len() <= 1_024, "query must not exceed 1024 bytes");
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
                    count: u64::try_from(row.get::<_, i64>(1)?).map_err(|error| {
                        conversion_error(1, rusqlite::types::Type::Integer, error.to_string())
                    })?,
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
