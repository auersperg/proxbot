import type { EvidenceClass, ExchangeRow, RawView } from "../lib/contracts";

function Provenance({ view, evidence }: { view: RawView; evidence: EvidenceClass }) {
  const artifact = view.artifact;
  return (
    <div className="raw-provenance">
      <span>{view.mediaType}</span>
      <b>EXCHANGE {evidence.toUpperCase()}</b>
      <b>{view.reconstructed ? "Reconstructed" : "Original"}</b>
      <b className={view.truncated ? "danger-text" : ""}>{view.truncated ? "Truncated" : "Complete"}</b>
      <b className={view.masked ? "warning-text" : ""}>{view.masked ? "Masked" : "Unmasked"}</b>
      {artifact ? <code title={artifact.relativePath}>offset {artifact.offset} · {artifact.length} B · {artifact.sha256 ?? "hash pending"}</code> : <code>inline provider record · no artifact offset</code>}
    </div>
  );
}

function Pane({ title, view, evidence, absent }: { title: string; view: RawView | null; evidence: EvidenceClass; absent: string }) {
  return (
    <section className="raw-pane" aria-label={title}>
      <header className="raw-pane-header"><h2>{title}</h2><span className="raw-view-label">Raw</span></header>
      {view ? <><Provenance view={view} evidence={evidence} /><pre>{view.content}</pre></> : <div className="raw-empty">{absent}</div>}
    </section>
  );
}

export default function RawInspector({ exchange }: { exchange: ExchangeRow | null }) {
  const requestMissing = exchange?.warning?.split(";").includes("request_missing") === true;
  const requestEvidenceAbsent = exchange !== null && exchange.requestRaw === null;
  return (
    <section className="raw-inspector" aria-label="Raw request and response inspector">
      <Pane title="RAW Request" view={exchange?.requestRaw ?? null} evidence={exchange?.evidence ?? "observed"} absent={requestMissing ? "No request was observed for this response." : requestEvidenceAbsent ? "No raw request evidence was supplied for this exchange." : "Select a request to inspect its exact raw evidence."} />
      <Pane title="RAW Response" view={exchange?.responseRaw ?? null} evidence={exchange?.evidence ?? "observed"} absent={exchange ? "No response was observed for this request." : "Select a request to inspect its response."} />
    </section>
  );
}
