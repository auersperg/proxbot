import type { CaptureProfile, CaptureStatus, DevicePreflight } from "../lib/contracts";
import { useEffect, useState } from "react";

interface Props {
  busy: boolean;
  status: CaptureStatus;
  device: DevicePreflight | null;
  profile: CaptureProfile;
  query: string;
  onQuery: (query: string) => void;
  onProfile: (profile: CaptureProfile) => void;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onMarker: () => void;
}

export default function Toolbar({ busy, status, device, profile, query, onQuery, onProfile, onStart, onStop, onRefresh, onMarker }: Props) {
  const [localQuery, setLocalQuery] = useState(query);
  useEffect(() => setLocalQuery(query), [query]);

  const updateQuery = (value: string) => {
    setLocalQuery(value);
    onQuery(value);
  };
  const active = status === "capturing" || status === "degraded";
  const transitioning = status === "starting" || status === "stopping";
  const deviceReady = device?.available === true && device.paired === true && device.trusted === true;
  const deviceTrust = !device?.available ? "unavailable" : device.paired !== true ? "not paired" : device.trusted !== true ? "not trusted" : "paired · trusted";
  const deviceLabel = device?.name ?? "iPhone";
  const profileDescription = profile === "wireguard"
    ? "Recommended for proxy-bypassing apps: USB packets and device logs plus a WireGuard full tunnel into the HTTP(S) inspector. Scan the generated profile in WireGuard on the iPhone and install the CA from http://mitm.it. Certificate pinning is reported, not bypassed."
    : profile === "deep"
      ? "USB packets and device logs plus the regular HTTP(S) proxy. Route the iPhone to the endpoint shown under Evidence sources and install its CA from http://mitm.it to inspect accepted HTTPS traffic. Certificate pinning is reported, not bypassed."
      : "USB packet capture only. HTTPS payloads remain encrypted; DNS or TLS metadata may still identify a domain when observed.";

  return (
    <header className="toolbar">
      <div className="window-brand"><div className="brand-lens" aria-hidden="true"><i /><i /><i /></div><span><strong>proxbot</strong><small>Network observability</small></span></div>
      <div className={`device-pill ${deviceReady ? "connected" : ""}`} aria-label={`iOS device ${deviceLabel}; available ${device?.available === true ? "yes" : "no"}; paired ${device?.paired === true ? "yes" : "no"}; trusted ${device?.trusted === true ? "yes" : "no"}; version ${device?.productVersion ?? "unknown"}`}><i /><span><small>{device?.productVersion ? `iOS ${device.productVersion}` : "iOS USB"} · {deviceTrust}</small><strong>{device?.available ? deviceLabel : "No connected device"}</strong></span></div>
      <label className="profile-select" title={profileDescription}><small>PROFILE</small><select aria-label="Capture profile" aria-description={profileDescription} value={profile} disabled={active || transitioning || busy} onChange={(event) => onProfile(event.target.value as CaptureProfile)}><option value="wireguard">VPN + USB</option><option value="deep">HTTP proxy + USB</option><option value="passive">USB packets only</option></select></label>
      <div className="capture-actions"><button type="button" className="tool-button" aria-label="Add capture marker" title="Add a timestamped capture marker" disabled={!active || busy} onClick={onMarker}>◇</button><button type="button" className="tool-button" aria-label="Refresh capture" title="Refresh device, status, and traffic" disabled={busy} onClick={onRefresh}>↻</button></div>
      <label className="global-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Filter requests" placeholder="Filter host, path, method, protocol…" maxLength={1024} value={localQuery} onChange={(event) => updateQuery(event.target.value)} />{localQuery && <button type="button" aria-label="Clear filter" onClick={() => updateQuery("")}>×</button>}</label>
      <div className={`capture-status capture-${status}`} role="status" aria-live="polite"><i />{status}</div>
      <button type="button" className="secondary-button stop-button" disabled={!active || busy} onClick={onStop}>Stop</button>
      <button type="button" className="primary-button" disabled={active || transitioning || busy || !deviceReady} onClick={onStart}>{status === "starting" ? "Starting…" : "Start capture"}</button>
    </header>
  );
}
