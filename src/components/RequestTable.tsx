import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { ExchangeRow } from "../lib/contracts";
import { formatBytes, formatObservedTime, plaintextEvidenceLabel, responseLabel, statusTone, warningLabel } from "../lib/exchange";

interface Props {
  exchanges: ExchangeRow[];
  total: number;
  offset: number;
  limit: number;
  selectedId: string | null;
  busy: boolean;
  onSelect: (requestId: string) => void;
  onPage: (offset: number) => void;
}

const columns = ["#", "Time", "Method", "Host / IP", "Path", "Status", "Protocol", "Duration", "Request", "Response", "TLS"];

export default function RequestTable({ exchanges, total, offset, limit, selectedId, busy, onSelect, onPage }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: exchanges.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 31,
    overscan: 12,
    initialRect: { width: 1200, height: 480 },
    getItemKey: (index) => exchanges[index]?.requestId ?? index,
  });
  const items = virtualizer.getVirtualItems();
  const renderedItems = items.length
    ? items
    : exchanges.map((_, index) => ({ index, start: index * 31 }));
  const moveSelection = (index: number, key: string) => {
    const nextIndex = key === "ArrowDown" ? Math.min(exchanges.length - 1, index + 1)
      : key === "ArrowUp" ? Math.max(0, index - 1)
        : key === "Home" ? 0
          : key === "End" ? exchanges.length - 1
            : index;
    if (nextIndex === index || nextIndex < 0) return false;
    const next = exchanges[nextIndex];
    if (!next) return false;
    virtualizer.scrollToIndex(nextIndex, { align: "auto" });
    onSelect(next.requestId);
    window.requestAnimationFrame(() => {
      scroller.current?.querySelector<HTMLButtonElement>(`[data-row-index="${nextIndex}"]`)?.focus();
    });
    return true;
  };

  return (
    <section className="request-table" aria-label="Captured requests">
      <div className="request-scroll" ref={scroller}>
        <div className="request-grid table-header" aria-hidden="true">
          {columns.map((column) => <span key={column}>{column}</span>)}
        </div>
        <div className="virtual-space" style={{ height: `${Math.max(virtualizer.getTotalSize(), exchanges.length * 31)}px` }}>
          {renderedItems.map((item) => {
            const exchange = exchanges[item.index];
            if (!exchange) return null;
            const warning = warningLabel(exchange.warning);
            const address = exchange.host ?? exchange.ip ?? "Unknown endpoint";
            const status = responseLabel(exchange.status);
            const duration = exchange.durationMs === null ? "not reported" : `${exchange.durationMs} ms`;
            const plaintext = plaintextEvidenceLabel(exchange);
            const process = exchange.processName ?? (exchange.processId === null ? null : `PID ${exchange.processId}`);
            const diagnosticLabel = [
              `Request ${exchange.requestSequence ?? exchange.responseSequence ?? "not reported"}`,
              `time ${formatObservedTime(exchange.startedNs)}`,
              `method ${exchange.method ?? "not reported"}`,
              `endpoint ${address}`,
              `path ${exchange.path ?? "not reported"}`,
              `status ${status === "—" ? "not reported" : status}`,
              `warning ${warning || "none"}`,
              `protocol ${exchange.protocol ?? "not reported"}`,
              `duration ${duration}`,
              `request size ${formatBytes(exchange.requestBytes)}`,
              `response size ${formatBytes(exchange.responseBytes)}`,
              `TLS ${exchange.tls ?? "not reported"}`,
              `capture ${plaintext}`,
              `provider ${exchange.providerId}`,
              `process ${process ?? "not reported"}`,
              `correlation ${exchange.correlationId ?? "not reported"}`,
              `evidence ${exchange.evidence}`,
            ].join("; ");
            return (
              <button
                type="button"
                key={exchange.requestId}
                className={`request-grid request-row${selectedId === exchange.requestId ? " selected" : ""}`}
                aria-label={diagnosticLabel}
                aria-pressed={selectedId === exchange.requestId}
                data-row-index={item.index}
                style={{ transform: `translateY(${item.start}px)` }}
                onClick={() => onSelect(exchange.requestId)}
                onKeyDown={(event) => {
                  if (moveSelection(item.index, event.key)) event.preventDefault();
                }}
              >
                <span className="mono sequence">{exchange.requestSequence ?? exchange.responseSequence ?? "—"}</span>
                <span className="mono subdued">{formatObservedTime(exchange.startedNs)}</span>
                <span><b className={`method method-${(exchange.method ?? "unknown").toLowerCase()}`}>{exchange.method ?? "—"}</b></span>
                <span className="endpoint-cell"><strong>{address}</strong><small>{[exchange.ip && exchange.host ? exchange.ip : null, process].filter(Boolean).join(" · ")}</small></span>
                <span className="path-cell mono">{exchange.path ?? "—"}</span>
                <span className="status-stack" title={warning ? `${status} · ${warning}` : status}><b className={`status status-${statusTone(exchange.status)}`}>{status}</b>{warning && <em className="warning-label" title={warning}>{warning}</em>}</span>
                <span className="mono subdued">{exchange.protocol ?? "—"}</span>
                <span className="mono subdued">{exchange.durationMs === null ? "—" : duration}</span>
                <span className="mono subdued">{formatBytes(exchange.requestBytes)}</span>
                <span className="mono subdued">{formatBytes(exchange.responseBytes)}</span>
                <span className="tls-state" title={`${plaintext} · ${exchange.providerId}`}><span>{exchange.tls ?? "—"}<i className="evidence-class">{exchange.evidence.toUpperCase()}</i></span><em className={`evidence-label capture-${exchange.captureLayer}`}>{plaintext}</em></span>
              </button>
            );
          })}
          {!exchanges.length && <div className="table-empty">No network packets or HTTP exchanges observed yet.</div>}
        </div>
      </div>
      <footer className="table-pagination">
        <span>{exchanges.length} shown · {total.toLocaleString()} total</span>
        <button type="button" disabled={busy || offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</button>
        <span className="mono">{Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil(total / limit))}</span>
        <button type="button" disabled={busy || offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</button>
      </footer>
    </section>
  );
}
