import { useVirtualizer } from "@tanstack/react-virtual";
import QRCode from "qrcode";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { proxyRuntimeState } from "../lib/capture-diagnostics";
import type { EndpointFilter, EndpointSummary, EvidenceSource, WireGuardSetup } from "../lib/contracts";

interface DeviceSummary { name: string; id: string; available: boolean }
interface Props {
  device: DeviceSummary;
  endpoints: EndpointSummary[];
  total: number;
  selected: EndpointFilter | null;
  onSelect: (filter: EndpointFilter | null) => void;
  sources: EvidenceSource[];
  wireguardSetup?: WireGuardSetup | null;
}

type TreeEntry =
  | { type: "heading"; id: string; label: string }
  | { type: "empty"; id: string; label: string }
  | { type: "endpoint"; id: string; item: EndpointSummary };

function redacted(identifier: string) {
  return identifier.length <= 12 ? identifier : `${identifier.slice(0, 4)}…${identifier.slice(-4)}`;
}

function isHttpProxy(source: EvidenceSource) {
  const identity = `${source.id} ${source.label}`.toLowerCase();
  return identity.includes("proxy") && (identity.includes("http") || identity.includes("mitm"));
}

function EndpointSidebar({ device, endpoints, total, selected, onSelect, sources, wireguardSetup = null }: Props) {
  const proxyState = useMemo(() => proxyRuntimeState(sources), [sources]);
  const [wireguardQr, setWireguardQr] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    if (!wireguardSetup) {
      setWireguardQr(null);
      return;
    }
    QRCode.toString(wireguardSetup.clientConfig, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: { dark: "#05070a", light: "#ffffff" },
    }).then((svg) => {
      if (!disposed) setWireguardQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    }).catch(() => {
      if (!disposed) setWireguardQr(null);
    });
    return () => { disposed = true; };
  }, [wireguardSetup]);
  const entries = useMemo<TreeEntry[]>(() => {
    const domains = endpoints.filter((item) => item.kind === "domain");
    const ips = endpoints.filter((item) => item.kind === "ip");
    return [
      { type: "heading", id: "domains-heading", label: "Domains" },
      ...(domains.length
        ? domains.map((item) => ({ type: "endpoint" as const, id: `domain:${item.value}`, item }))
        : [{ type: "empty" as const, id: "domains-empty", label: "No domains observed" }]),
      { type: "heading", id: "ips-heading", label: "IP addresses" },
      ...(ips.length
        ? ips.map((item) => ({ type: "endpoint" as const, id: `ip:${item.value}`, item }))
        : [{ type: "empty" as const, id: "ips-empty", label: "No IP addresses observed" }]),
    ];
  }, [endpoints]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => entries[index]?.type === "endpoint" ? 27 : 29,
    overscan: 12,
    initialRect: { width: 232, height: 480 },
    getItemKey: (index) => entries[index]?.id ?? index,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const renderedItems = virtualItems.length
    ? virtualItems
    : entries.slice(0, 32).map((_, index) => ({
        index,
        start: entries.slice(0, index).reduce((height, entry) => height + (entry.type === "endpoint" ? 27 : 29), 0),
      }));
  const moveFocus = (index: number, key: string) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
    const endpointIndexes = entries.flatMap((entry, entryIndex) => entry.type === "endpoint" ? [entryIndex] : []);
    const position = endpointIndexes.indexOf(index);
    const next = key === "Home" ? endpointIndexes[0]
      : key === "End" ? endpointIndexes.at(-1)
        : key === "ArrowDown" ? endpointIndexes[Math.min(endpointIndexes.length - 1, position + 1)]
          : endpointIndexes[Math.max(0, position - 1)];
    if (next === undefined || next === index) return false;
    virtualizer.scrollToIndex(next, { align: "auto" });
    window.requestAnimationFrame(() => {
      scroller.current?.querySelector<HTMLButtonElement>(`[data-endpoint-index="${next}"]`)?.focus();
    });
    return true;
  };

  return (
    <aside className="endpoint-sidebar" aria-label="Device and endpoint navigator">
      <div className="sidebar-caption">Remote devices</div>
      <button className={`device-row${selected === null ? " selected" : ""}`} type="button" aria-pressed={selected === null} onClick={() => onSelect(null)}>
        <span className={`device-indicator ${device.available ? "online" : "offline"}`} aria-hidden="true" />
        <span><strong>{device.name}</strong><small>{redacted(device.id)}</small></span>
        <span className="endpoint-count">{total}</span>
      </button>
      <div className="endpoint-tree" ref={scroller} aria-label="Observed domains and IP addresses">
        <div className="endpoint-virtual-space" style={{ height: `${Math.max(virtualizer.getTotalSize(), 58)}px` }}>
          {renderedItems.map((virtualItem) => {
            const entry = entries[virtualItem.index];
            if (!entry) return null;
            if (entry.type === "heading") {
              return <h2 className="endpoint-tree-heading" id={entry.id} key={entry.id} style={{ transform: `translateY(${virtualItem.start}px)` }}>{entry.label}</h2>;
            }
            if (entry.type === "empty") {
              return <p className="empty-group endpoint-tree-item" key={entry.id} style={{ transform: `translateY(${virtualItem.start}px)` }}>{entry.label}</p>;
            }
            const active = selected?.kind === entry.item.kind && selected.value === entry.item.value;
            return (
              <button
                className={`endpoint-row endpoint-tree-item${active ? " selected" : ""}`}
                type="button"
                key={entry.id}
                aria-pressed={active}
                aria-label={`${entry.item.value}, ${entry.item.count} requests`}
                data-endpoint-index={virtualItem.index}
                style={{ transform: `translateY(${virtualItem.start}px)` }}
                onClick={() => onSelect({ kind: entry.item.kind, value: entry.item.value })}
                onKeyDown={(event) => {
                  if (moveFocus(virtualItem.index, event.key)) event.preventDefault();
                }}
              >
                <span className="endpoint-icon" aria-hidden="true">{entry.item.kind === "domain" ? "◉" : "#"}</span>
                <span className="endpoint-name">{entry.item.value}</span>
                <span className="endpoint-count">{entry.item.count}</span>
              </button>
            );
          })}
        </div>
      </div>
      {sources.length > 0 && <section className="sidebar-sources" aria-label="Evidence sources">
        <h2>Evidence sources</h2>
        {sources.map((source) => {
          const proxy = isHttpProxy(source);
          const wireguard = proxy && /wireguard/i.test(`${source.label} ${source.detail ?? ""}`);
          const detail = source.detail ?? source.status;
          return <section className={`source-entry${proxy ? " proxy-source-entry" : ""}`} key={source.id} aria-label={`${source.label}: ${source.status}`}>
            <div className="source-row"><i className={`state-dot ${source.status}`} /><span className="source-label">{proxy ? "HTTP(S) proxy" : source.label}</span><span className="source-detail" title={detail}>{detail}</span></div>
            {proxy && <details className="proxy-setup-help" open={wireguard && wireguardSetup !== null}>
              <summary><span>{wireguard ? "WireGuard + CA setup" : "CA setup"}</span><code>http://mitm.it</code></summary>
              <div role="note">
                <div className="proxy-runtime-diagnostics" aria-label="HTTP(S) runtime diagnostics">
                  <span className={proxyState.routeObserved ? "diagnostic-observed" : "diagnostic-unresolved"} title={proxyState.routeObserved ? "At least one client request reached this proxy." : "The listener is active, but no client request has reached it yet."}>Route {proxyState.routeObserved ? "observed" : "not observed"}</span>
                  <span className={proxyState.httpsPlaintextObserved ? "diagnostic-observed" : "diagnostic-unresolved"} title={proxyState.httpsPlaintextObserved ? "At least one accepted HTTPS request supplied application plaintext." : "CONNECT or listener readiness does not establish CA trust or distinguish certificate pinning."}>HTTPS {proxyState.httpsPlaintextObserved ? "observed" : "unresolved"}</span>
                  <span className={proxyState.inProcessAvailable ? "diagnostic-observed" : "diagnostic-unavailable"} title={proxyState.inProcessAvailable ? "An active in-process instrumentation source is present." : "No active in-process TLS instrumentation source is present."}>Hooks {proxyState.inProcessAvailable ? "active" : "unavailable"}</span>
                </div>
                {wireguard ? <>
                  {wireguardQr
                    ? <img className="wireguard-qr" src={wireguardQr} alt="WireGuard client configuration QR code" />
                    : <p>Preparing the WireGuard QR code…</p>}
                  <p>In WireGuard on the iPhone, add a tunnel by scanning this QR code, enable the tunnel, then open <code>http://mitm.it</code> in Safari to install the CA.</p>
                  {wireguardSetup && <p className="wireguard-config-path" title={wireguardSetup.clientConfigPath}>Owner-only client profile: <code>{wireguardSetup.clientConfigPath}</code></p>}
                </> : <p>Set the iPhone Wi-Fi proxy to the endpoint above, then open this address on the iPhone to install the CA.</p>}
                <p><strong>Listening does not prove CA trust.</strong> HTTPS raw data appears only after an accepted intercepted request. Certificate-pinned apps may remain encrypted.</p>
              </div>
            </details>}
          </section>;
        })}
      </section>}
    </aside>
  );
}

export default memo(EndpointSidebar);
