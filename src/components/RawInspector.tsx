import { diagnoseCapturePath } from "../lib/capture-diagnostics";
import type { EvidenceSource, ExchangeRow, RawView } from "../lib/contracts";
import { plaintextEvidenceLabel } from "../lib/exchange";

function stateLabel(value: boolean | null, yes: string, no: string, unknown: string) {
  return value === null ? unknown : value ? yes : no;
}

interface RawPresentation {
  content: string;
  label: string;
  decodedEncoding: string | null;
  binary: {
    bytes: number;
    entropy: number;
    printableRatio: number;
  } | null;
}

function contentDecodedEncoding(mediaType: string) {
  const match = /(?:^|;)\s*content-decoded=([^;]+)/i.exec(mediaType);
  return match?.[1]?.trim() || null;
}

function isBinaryMediaType(mediaType: string) {
  const normalized = mediaType.toLowerCase();
  if (normalized.includes("encoding=base64") || normalized.includes("hexdump")) return false;
  const base = normalized.split(";", 1)[0]?.trim() ?? "";
  return base === "application/octet-stream"
    || base.includes("protobuf")
    || base === "application/cbor"
    || base === "application/zip"
    || base === "application/gzip"
    || base.startsWith("image/")
    || base.startsWith("audio/")
    || base.startsWith("video/");
}

function latin1Bytes(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function byteAnalysis(bytes: Uint8Array) {
  if (bytes.length === 0) return { entropy: 0, printableRatio: 1 };
  const frequencies = new Uint32Array(256);
  let printable = 0;
  for (const byte of bytes) {
    frequencies[byte] += 1;
    if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) printable += 1;
  }
  let entropy = 0;
  for (const count of frequencies) {
    if (count === 0) continue;
    const probability = count / bytes.length;
    entropy -= probability * Math.log2(probability);
  }
  return { entropy, printableRatio: printable / bytes.length };
}

function hexDump(bytes: Uint8Array) {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, Math.min(offset + 16, bytes.length));
    const octets = Array.from(row, (byte) => byte.toString(16).padStart(2, "0"));
    const left = octets.slice(0, 8).join(" ").padEnd(23, " ");
    const right = octets.slice(8).join(" ").padEnd(23, " ");
    const ascii = Array.from(row, (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${left}  ${right}  |${ascii.padEnd(16, " ")}|`);
  }
  lines.push(bytes.length.toString(16).padStart(8, "0"));
  return lines.join("\n");
}

function presentRaw(view: RawView, fallbackLabel: string): RawPresentation {
  const decodedEncoding = contentDecodedEncoding(view.mediaType);
  if (!isBinaryMediaType(view.mediaType)) {
    return {
      content: view.content,
      label: decodedEncoding ? `Decoded ${decodedEncoding}` : fallbackLabel,
      decodedEncoding,
      binary: null,
    };
  }
  const separator = view.content.indexOf("\r\n\r\n");
  const prefix = separator === -1 ? "" : view.content.slice(0, separator + 4);
  const body = separator === -1 ? view.content : view.content.slice(separator + 4);
  const bytes = latin1Bytes(body);
  const analysis = byteAnalysis(bytes);
  return {
    content: `${prefix}${prefix ? "\n" : ""}--- BINARY BODY · ${bytes.length} BYTES ---\n${hexDump(bytes)}`,
    label: "Header + Body Hex",
    decodedEncoding,
    binary: { bytes: bytes.length, ...analysis },
  };
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

function ExchangeContext({ exchange }: { exchange: ExchangeRow }) {
  const process = exchange.processName
    ? `${exchange.processName}${exchange.processId === null ? "" : ` (PID ${exchange.processId})`}`
    : exchange.processId === null ? "process unavailable" : `PID ${exchange.processId}`;
  return (
    <div className="raw-exchange-context">
      <strong className={`capture-label capture-${exchange.captureLayer}`}>{plaintextEvidenceLabel(exchange)}</strong>
      <span title={exchange.host ?? exchange.ip ?? undefined}>HOST {exchange.host ?? exchange.ip ?? "unavailable"}</span>
      <span title={process}>PROCESS {process}</span>
      <span title={exchange.providerId}>PROVIDER {exchange.providerId}</span>
      <span title={exchange.hostSource ?? undefined}>HOST SOURCE {exchange.hostSource ?? "unavailable"}</span>
      <span title={exchange.correlationId ?? undefined}>CORRELATION {exchange.correlationId ?? "unavailable"}</span>
    </div>
  );
}

function Pane({ title, view, absent, label = "Raw", exchange }: { title: string; view: RawView | null; absent: string; label?: string; exchange?: ExchangeRow }) {
  const presentation = view ? presentRaw(view, label) : null;
  const hasNotice = Boolean(presentation?.binary || presentation?.decodedEncoding);
  return (
    <section className={`raw-pane${exchange ? " with-exchange-context" : ""}${hasNotice ? " with-notice" : ""}`} aria-label={title}>
      <header className="raw-pane-header"><h2>{title}</h2><span className="raw-view-label">{presentation?.label ?? label}</span></header>
      {view && presentation ? <>
        <Provenance view={view} />
        {exchange ? <ExchangeContext exchange={exchange} /> : null}
        {hasNotice ? <div className="raw-notices">
          {presentation.decodedEncoding ? <p className="raw-decoded-notice">
            Analyst view decoded from <b>{presentation.decodedEncoding}</b> content encoding.
            The original content-encoded wire body remains byte-for-byte in the referenced evidence artifact.
          </p> : null}
          {presentation.binary ? <p className="raw-binary-notice">
            Binary application body rendered byte-for-byte as hex + ASCII instead of text.
            TLS plaintext was recovered, but the {view.mediaType.split(";", 1)[0]} payload itself is
            {presentation.binary.entropy >= 7.5 && presentation.binary.printableRatio < 0.6
              ? ` high-entropy/opaque (${presentation.binary.entropy.toFixed(2)} bits per byte) and may still use application-level encryption or encoding.`
              : " not declared as textual data."}
          </p> : null}
        </div> : null}
        <pre>{presentation.content}</pre>
      </> : <div className="raw-empty">{absent}</div>}
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
      <header className="raw-pane-header"><h2>Packet Analysis</h2><span className="raw-view-label">{plaintextEvidenceLabel(exchange)}</span></header>
      <div className="packet-analysis">
        <p>Frame metadata and the exact captured octets are kept separate. The byte-for-byte packet evidence is shown in canonical hex + ASCII at left.</p>
        <dl>
          <div><dt>Direction / kind</dt><dd>{display(exchange.method)}</dd></div>
          <div><dt>Host / IP</dt><dd>{display(exchange.host ?? exchange.ip)}</dd></div>
          <div><dt>Flow</dt><dd>{display(exchange.path)}</dd></div>
          <div><dt>Protocol</dt><dd>{display(exchange.protocol)}</dd></div>
          <div><dt>Capture semantics</dt><dd>{plaintextEvidenceLabel(exchange)}</dd></div>
          <div><dt>Provider</dt><dd>{display(exchange.providerId)}</dd></div>
          <div><dt>Correlation</dt><dd>{display(exchange.correlationId)}</dd></div>
          <div><dt>Host source</dt><dd>{display(exchange.hostSource)}</dd></div>
          <div><dt>TLS state</dt><dd>{display(exchange.tls)}</dd></div>
          <div><dt>Process</dt><dd>{display(exchange.processName)}</dd></div>
          <div><dt>Process ID</dt><dd>{display(exchange.processId)}</dd></div>
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

function RuntimeDiagnostics({ exchange, sources }: { exchange: ExchangeRow; sources: EvidenceSource[] }) {
  const diagnostic = diagnoseCapturePath(exchange, sources);
  return (
    <aside className="runtime-path-diagnostics" aria-label="Selected flow runtime diagnostics">
      <span className={`diagnostic-${diagnostic.route}`} title={diagnostic.routeDetail}><b>ROUTE</b>{diagnostic.routeLabel}</span>
      <span className={`diagnostic-${diagnostic.https}`} title={diagnostic.httpsDetail}><b>HTTPS</b>{diagnostic.httpsLabel}</span>
      <span title={exchange.processName ? "Process attribution was supplied by observed device evidence." : "No process attribution was supplied for this record."}><b>PROCESS</b>{diagnostic.processLabel}</span>
      <span className={diagnostic.inProcessLabel.endsWith("unavailable") ? "diagnostic-unavailable" : "diagnostic-available"} title={diagnostic.inProcessDetail}><b>HOOKS</b>{diagnostic.inProcessLabel}</span>
    </aside>
  );
}

export default function RawInspector({ exchange, sources = [] }: { exchange: ExchangeRow | null; sources?: EvidenceSource[] }) {
  const isPacket = exchange?.warning?.split(";").includes("packet_metadata") === true;
  if (exchange && isPacket) {
    return (
      <section className="raw-inspector packet-inspector with-runtime-diagnostics" aria-label="Raw packet and packet analysis inspector">
        <RuntimeDiagnostics exchange={exchange} sources={sources} />
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
    <section className={`raw-inspector${exchange ? " with-runtime-diagnostics" : ""}`} aria-label="Raw request and response inspector">
      {exchange ? <RuntimeDiagnostics exchange={exchange} sources={sources} /> : null}
      <Pane title="RAW Request" exchange={exchange ?? undefined} view={exchange?.requestRaw ?? null} absent={requestMissing ? "No request was observed for this response." : requestEvidenceAbsent ? "No raw request evidence was supplied for this exchange." : "Select a request to inspect its exact raw evidence."} />
      <Pane title="RAW Response" exchange={exchange ?? undefined} view={exchange?.responseRaw ?? null} absent={responseMissing ? "No response was observed for this request." : responseEvidenceAbsent ? "No raw response evidence was supplied for this exchange." : "Select a request to inspect its response."} />
    </section>
  );
}
