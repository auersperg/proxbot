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

function Pane({ title, view, absent, label = "Raw" }: { title: string; view: RawView | null; absent: string; label?: string }) {
  return (
    <section className="raw-pane" aria-label={title}>
      <header className="raw-pane-header"><h2>{title}</h2><span className="raw-view-label">{label}</span></header>
      {view ? <><Provenance view={view} /><pre>{view.content}</pre></> : <div className="raw-empty">{absent}</div>}
    </section>
  );
}

function display(value: string | number | null) {
  return value === null || value === "" ? "—" : String(value);
}

function PacketAnalysis({ exchange }: { exchange: ExchangeRow }) {
  const artifact = exchange.requestRaw?.artifact;
  return (
    <section className="raw-pane packet-analysis-pane" aria-label="Packet Analysis">
      <header className="raw-pane-header"><h2>Packet Analysis</h2><span className="raw-view-label">Observed</span></header>
      <div className="packet-analysis">
        <p>Frame metadata and the exact captured octets are kept separate. The byte-for-byte packet evidence is shown in canonical hex + ASCII at left.</p>
        <dl>
          <div><dt>Direction / kind</dt><dd>{display(exchange.method)}</dd></div>
          <div><dt>Host / IP</dt><dd>{display(exchange.host ?? exchange.ip)}</dd></div>
          <div><dt>Flow</dt><dd>{display(exchange.path)}</dd></div>
          <div><dt>Protocol</dt><dd>{display(exchange.protocol)}</dd></div>
          <div><dt>TLS state</dt><dd>{display(exchange.tls)}</dd></div>
          <div><dt>Process</dt><dd>{display(exchange.processName)}</dd></div>
          <div><dt>Captured length</dt><dd>{exchange.requestBytes === null ? "—" : `${exchange.requestBytes} B`}</dd></div>
          <div><dt>Evidence</dt><dd>{exchange.evidence.toUpperCase()}</dd></div>
          <div><dt>Artifact range</dt><dd>{artifact ? `${artifact.relativePath} @ ${artifact.offset} + ${artifact.length} B` : "No exact artifact range supplied"}</dd></div>
          <div><dt>Integrity</dt><dd>{artifact?.sha256 ? `SHA-256 ${artifact.sha256}` : "Hash unavailable"}</dd></div>
        </dl>
        {exchange.tls && exchange.tls !== "decrypted" ? <p className="packet-analysis-note">TLS application data remains encrypted at this capture layer; DNS or ClientHello metadata may still identify its destination.</p> : null}
      </div>
    </section>
  );
}

export default function RawInspector({ exchange }: { exchange: ExchangeRow | null }) {
  const isPacket = exchange?.warning?.split(";").includes("packet_metadata") === true;
  if (exchange && isPacket) {
    return (
      <section className="raw-inspector packet-inspector" aria-label="Raw packet and packet analysis inspector">
        <Pane
          title="RAW Packet"
          label="Hex + ASCII"
          view={exchange.requestRaw}
          absent="No exact captured packet bytes were supplied for this record."
        />
        <PacketAnalysis exchange={exchange} />
      </section>
    );
  }
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
