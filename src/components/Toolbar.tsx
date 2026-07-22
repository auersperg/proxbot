import type { FridaPreflight } from "../lib/contracts";
import { useEffect, useState } from "react";

interface Props {
  busy: boolean;
  status: "idle" | "capturing" | "ready" | "error" | "degraded";
  device: FridaPreflight | null;
  query: string;
  onQuery: (query: string) => void;
  onPreflight: () => void;
  onStart: () => void;
}

export default function Toolbar({ busy, status, device, query, onQuery, onPreflight, onStart }: Props) {
  const [localQuery, setLocalQuery] = useState(query);
  useEffect(() => setLocalQuery(query), [query]);

  const updateQuery = (value: string) => {
    setLocalQuery(value);
    onQuery(value);
  };

  return (
    <header className="toolbar">
      <div className="window-brand"><div className="brand-lens" aria-hidden="true"><i /><i /><i /></div><span><strong>proxbot</strong><small>Network observability</small></span></div>
      <div className={`device-pill ${device?.available ? "connected" : ""}`}><i /><span><small>IOS USB</small><strong>{device?.available ? device.name ?? "iPhone" : "No verified device"}</strong></span></div>
      <label className="profile-select"><small>PROFILE</small><select aria-label="Capture profile" defaultValue="deep"><option value="deep">Deep capture</option><option value="passive">Passive USB</option></select></label>
      <div className="capture-actions"><button type="button" className="tool-button" aria-label="Pause capture" disabled>Ⅱ</button><button type="button" className="tool-button" aria-label="Add marker" disabled={status === "idle"}>◇</button></div>
      <label className="global-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Filter requests" placeholder="Filter host, path, method, protocol…" value={localQuery} onChange={(event) => updateQuery(event.target.value)} />{localQuery && <button type="button" aria-label="Clear filter" onClick={() => updateQuery("")}>×</button>}</label>
      <div className={`capture-status capture-${status}`}><i />{status}</div>
      <button type="button" className="secondary-button" disabled={busy} onClick={onPreflight}>Check iPhone</button>
      <button type="button" className="primary-button" disabled={busy} onClick={onStart}>{busy ? "Working…" : "Run verified demo"}</button>
    </header>
  );
}
