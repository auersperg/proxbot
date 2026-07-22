import type { ExchangeRow, RawView } from "../lib/contracts";

function Provenance({ view }: { view: RawView }) {
  const artifact = view.artifact;
  return (
    <div className="raw-provenance">
      <span>{view.mediaType}</span>
      {view.reconstructed && <b>Reconstructed</b>}
      {view.truncated && <b className="danger-text">Truncated</b>}
      {view.masked && <b className="warning-text">Masked</b>}
      {artifact ? <code title={artifact.relativePath}>offset {artifact.offset} · {artifact.length} B · {artifact.sha256 ?? "hash pending"}</code> : <code>inline provider record · no artifact offset</code>}
    </div>
  );
}

function Pane({ title, view, absent }: { title: string; view: RawView | null; absent: string }) {
  return (
    <section className="raw-pane" aria-label={title}>
      <header className="raw-pane-header"><h2>{title}</h2><nav aria-label={`${title} views`}><button className="active" type="button">Raw</button><button type="button">Headers</button><button type="button">Body</button></nav></header>
      {view ? <><Provenance view={view} /><pre>{view.content}</pre></> : <div className="raw-empty">{absent}</div>}
    </section>
  );
}

export default function RawInspector({ exchange }: { exchange: ExchangeRow | null }) {
  return (
    <section className="raw-inspector" aria-label="Raw request and response inspector">
      <Pane title="RAW Request" view={exchange?.requestRaw ?? null} absent="Select a request to inspect its exact raw evidence." />
      <Pane title="RAW Response" view={exchange?.responseRaw ?? null} absent={exchange ? "No response was observed for this request." : "Select a request to inspect its response."} />
    </section>
  );
}
