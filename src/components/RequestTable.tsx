import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { ExchangeRow } from "../lib/contracts";
import { formatBytes, formatObservedTime, responseLabel, statusTone, warningLabel } from "../lib/exchange";

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

  return (
    <section className="request-table" aria-label="Captured requests">
      <div className="request-grid table-header" role="row">
        {columns.map((column) => <span role="columnheader" key={column}>{column}</span>)}
      </div>
      <div className="request-scroll" ref={scroller}>
        <div className="virtual-space" style={{ height: `${Math.max(virtualizer.getTotalSize(), exchanges.length * 31)}px` }}>
          {renderedItems.map((item) => {
            const exchange = exchanges[item.index];
            if (!exchange) return null;
            const warning = warningLabel(exchange.warning);
            const address = exchange.host ?? exchange.ip ?? "Unknown endpoint";
            return (
              <button
                type="button"
                key={exchange.requestId}
                className={`request-grid request-row${selectedId === exchange.requestId ? " selected" : ""}`}
                aria-label={`${exchange.method ?? "Unknown method"} ${address} ${exchange.path ?? ""}`}
                aria-pressed={selectedId === exchange.requestId}
                style={{ transform: `translateY(${item.start}px)` }}
                onClick={() => onSelect(exchange.requestId)}
              >
                <span className="mono sequence">{exchange.requestSequence ?? exchange.responseSequence ?? "—"}</span>
                <span className="mono subdued">{formatObservedTime(exchange.startedNs)}</span>
                <span><b className={`method method-${(exchange.method ?? "unknown").toLowerCase()}`}>{exchange.method ?? "—"}</b></span>
                <span className="endpoint-cell"><strong>{address}</strong><small>{exchange.ip && exchange.host ? exchange.ip : exchange.processName ?? ""}</small></span>
                <span className="path-cell mono">{exchange.path ?? "—"}</span>
                <span>{warning ? <em className="warning-label">{warning}</em> : <b className={`status status-${statusTone(exchange.status)}`}>{responseLabel(exchange.status)}</b>}</span>
                <span className="mono subdued">{exchange.protocol ?? "—"}</span>
                <span className="mono subdued">{exchange.durationMs === null ? "—" : `${exchange.durationMs} ms`}</span>
                <span className="mono subdued">{formatBytes(exchange.requestBytes)}</span>
                <span className="mono subdued">{formatBytes(exchange.responseBytes)}</span>
                <span className="tls-state">{exchange.tls ?? "—"}</span>
              </button>
            );
          })}
          {!exchanges.length && <div className="table-empty">Run a verified capture to populate network requests.</div>}
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
