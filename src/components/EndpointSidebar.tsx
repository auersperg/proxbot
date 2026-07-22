import type { EndpointFilter, EndpointSummary } from "../lib/contracts";

interface DeviceSummary { name: string; id: string; available: boolean }
interface Props {
  device: DeviceSummary;
  endpoints: EndpointSummary[];
  total: number;
  selected: EndpointFilter | null;
  onSelect: (filter: EndpointFilter | null) => void;
}

function redacted(identifier: string) {
  return identifier.length <= 12 ? identifier : `${identifier.slice(0, 4)}…${identifier.slice(-4)}`;
}

export default function EndpointSidebar({ device, endpoints, total, selected, onSelect }: Props) {
  const domains = endpoints.filter((item) => item.kind === "domain");
  const ips = endpoints.filter((item) => item.kind === "ip");
  const endpointButton = (item: EndpointSummary) => {
    const active = selected?.kind === item.kind && selected.value === item.value;
    return (
      <button className={`endpoint-row${active ? " selected" : ""}`} type="button" key={`${item.kind}:${item.value}`} aria-pressed={active} aria-label={`${item.value}, ${item.count} requests`} onClick={() => onSelect({ kind: item.kind, value: item.value })}>
        <span className="endpoint-icon" aria-hidden="true">{item.kind === "domain" ? "◉" : "#"}</span>
        <span className="endpoint-name">{item.value}</span>
        <span className="endpoint-count">{item.count}</span>
      </button>
    );
  };

  return (
    <aside className="endpoint-sidebar" aria-label="Device and endpoint navigator">
      <div className="sidebar-caption">Remote devices</div>
      <button className={`device-row${selected === null ? " selected" : ""}`} type="button" aria-pressed={selected === null} onClick={() => onSelect(null)}>
        <span className={`device-indicator ${device.available ? "online" : "offline"}`} aria-hidden="true" />
        <span><strong>{device.name}</strong><small>{redacted(device.id)}</small></span>
        <span className="endpoint-count">{total}</span>
      </button>
      <section className="endpoint-group" aria-labelledby="domains-heading">
        <h2 id="domains-heading">Domains</h2>
        {domains.length ? domains.map(endpointButton) : <p className="empty-group">No domains observed</p>}
      </section>
      <section className="endpoint-group" aria-labelledby="ips-heading">
        <h2 id="ips-heading">IP addresses</h2>
        {ips.length ? ips.map(endpointButton) : <p className="empty-group">No IP addresses observed</p>}
      </section>
      <section className="sidebar-sources">
        <h2>Evidence sources</h2>
        <div><i className="state-dot idle" />USB packet capture<span>not reported</span></div>
        <div><i className="state-dot idle" />System logs<span>not reported</span></div>
        <div><i className="state-dot idle" />Process map<span>not reported</span></div>
        <div><i className="state-dot idle" />TLS plaintext<span>not configured</span></div>
      </section>
    </aside>
  );
}
