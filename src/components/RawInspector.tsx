import type { ExchangeRow, RawView } from "../lib/contracts";

function stateLabel(value: boolean | null, yes: string, no: string, unknown: string) {
  return value === null ? unknown : value ? yes : no;
}

function Provenance({ view }: { view: RawView }) {
  const artifact = view.artifact;
  return (
    <div className="raw-provenance">
      <span>{view.mediaType}</span>
      <b>EVIDENCE {view.evidence.toUpperCase()}</b>
      <b className={view.reconstructed === null ? "unknown-text" : ""}>{stateLabel(view.reconstructed, "Reconstructed", "Original", "Origin unknown")}</b>
      <b className={view.truncated === true ? "danger-text" : view.truncated === null ? "unknown-text" : ""}>{stateLabel(view.truncated, "Truncated", "Complete", "Completeness unknown")}</b>
      <b className={view.masked === true ? "warning-text" : view.masked === null ? "unknown-text" : ""}>{stateLabel(view.masked, "Masked", "Unmasked", "Masking unknown")}</b>
      {artifact ? <code title={artifact.relativePath}>offset {artifact.offset} · {artifact.length} B · {artifact.sha256 ?? "hash unavailable"}</code> : <code>inline provider record · no artifact offset</code>}
    </div>
  );
}

function Pane({ title, view, absent }: { title: string; view: RawView | null; absent: string }) {
  return (
    <section className="raw-pane" aria-label={title}>
      <header className="raw-pane-header"><h2>{title}</h2><span className="raw-view-label">Raw</span></header>
      {view ? <><Provenance view={view} /><pre>{view.content}</pre></> : <div className="raw-empty">{absent}</div>}
    </section>
  );
}

export default function RawInspector({ exchange }: { exchange: ExchangeRow | null }) {
  const requestMissing = exchange?.warning?.split(";").includes("request_missing") === true;
  const responseMissing = exchange?.responseSequence === null || exchange?.warning?.split(";").includes("response_missing") === true;
  const requestEvidenceAbsent = exchange !== null && exchange.requestRaw === null;
  const responseEvidenceAbsent = exchange !== null && exchange.responseRaw === null;
  return (
    <section className="raw-inspector" aria-label="Raw request and response inspector">
      <Pane title="RAW Request" view={exchange?.requestRaw ?? null} absent={requestMissing ? "No request was observed for this response." : requestEvidenceAbsent ? "No raw request evidence was supplied for this exchange." : "Select a request to inspect its exact raw evidence."} />
      <Pane title="RAW Response" view={exchange?.responseRaw ?? null} absent={responseMissing ? "No response was observed for this request." : responseEvidenceAbsent ? "No raw response evidence was supplied for this exchange." : "Select a request to inspect its response."} />
    </section>
  );
}
