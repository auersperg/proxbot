import { useCallback, useEffect, useRef, useState } from "react";
import EndpointSidebar from "./components/EndpointSidebar";
import HealthStrip from "./components/HealthStrip";
import RawInspector from "./components/RawInspector";
import RequestTable from "./components/RequestTable";
import Toolbar from "./components/Toolbar";
import { api, type ApiClient } from "./lib/api";
import type { CaptureSummary, EndpointFilter, EndpointSummary, ExchangePage, FridaPreflight } from "./lib/contracts";
import "./styles.css";

const PAGE_LIMIT = 200;
type CaptureStatus = "idle" | "capturing" | "ready" | "error" | "degraded";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function App({ client = api }: { client?: ApiClient }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [device, setDevice] = useState<FridaPreflight | null>(null);
  const [summary, setSummary] = useState<CaptureSummary | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [page, setPage] = useState<ExchangePage>({ exchanges: [], total: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ExchangePage["exchanges"][number] | null>(null);
  const [endpoint, setEndpoint] = useState<EndpointFilter | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const lastQueryKey = useRef<string | null>(null);

  const applyPage = useCallback((nextPage: ExchangePage) => {
    setPage(nextPage);
    setSelectedId((current) => nextPage.exchanges.some((item) => item.requestId === current) ? current : nextPage.exchanges[0]?.requestId ?? null);
  }, []);

  const load = useCallback(async (sessionId: string, nextQuery: string, nextEndpoint: EndpointFilter | null, nextOffset: number) => {
    const epoch = ++requestEpoch.current;
    setBusy(true);
    setError(null);
    try {
      const [nextEndpoints, nextPage] = await Promise.all([
        client.listEndpoints(sessionId, nextQuery, 2_000),
        client.pageExchanges(sessionId, { query: nextQuery, endpoint: nextEndpoint, offset: nextOffset, limit: PAGE_LIMIT }),
      ]);
      if (epoch !== requestEpoch.current) return;
      setEndpoints(nextEndpoints);
      setOffset(nextOffset);
      applyPage(nextPage);
    } catch (reason) {
      if (epoch === requestEpoch.current) throw reason;
    } finally {
      if (epoch === requestEpoch.current) setBusy(false);
    }
  }, [applyPage, client]);

  const runPreflight = async () => {
    setBusy(true); setError(null);
    try {
      const result = await client.fridaPreflight();
      setDevice(result);
      if (!result.available) setError(result.error ?? "USB iPhone is unavailable.");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const runCapture = async () => {
    setBusy(true); setStatus("capturing"); setError(null); setEndpoint(null); setQuery("");
    detailEpoch.current += 1;
    setSelectedDetail(null);
    try {
      const nextSummary = await client.createDemoSession(161);
      setSummary(nextSummary);
      lastQueryKey.current = `${nextSummary.sessionId}\u0000`;
      await load(nextSummary.sessionId, "", null, 0);
      setStatus("ready");
    } catch (reason) { setStatus("error"); setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const selectEndpoint = async (nextEndpoint: EndpointFilter | null) => {
    setEndpoint(nextEndpoint); setError(null);
    if (!summary) return;
    try { await load(summary.sessionId, query, nextEndpoint, 0); }
    catch (reason) { setError(errorText(reason)); }
  };

  const changePage = async (nextOffset: number) => {
    if (!summary) return;
    setError(null);
    try { await load(summary.sessionId, query, endpoint, nextOffset); }
    catch (reason) { setError(errorText(reason)); }
  };

  useEffect(() => {
    if (!summary) return;
    const key = `${summary.sessionId}\u0000${query}`;
    if (lastQueryKey.current === key) return;
    lastQueryKey.current = key;
    const timer = window.setTimeout(() => {
      load(summary.sessionId, query, endpoint, 0).catch((reason) => setError(errorText(reason)));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [endpoint, load, query, summary]);

  useEffect(() => {
    if (!summary || !selectedId) {
      detailEpoch.current += 1;
      setSelectedDetail(null);
      return;
    }
    const epoch = ++detailEpoch.current;
    setSelectedDetail(null);
    client.getExchange(summary.sessionId, selectedId)
      .then((exchange) => {
        if (epoch === detailEpoch.current) setSelectedDetail(exchange);
      })
      .catch((reason) => {
        if (epoch === detailEpoch.current) setError(errorText(reason));
      });
    return () => {
      if (epoch === detailEpoch.current) detailEpoch.current += 1;
    };
  }, [client, selectedId, summary]);

  const fallbackDevice = { name: device?.name ?? "USB iPhone", id: device?.id ?? "Device preflight required", available: device?.available === true };

  return (
    <main className="app-shell" role="application" aria-label="proxbot">
      <Toolbar busy={busy} status={status} device={device} query={query} onQuery={setQuery} onPreflight={runPreflight} onStart={runCapture} />
      {error && <div className="error-banner" role="alert"><strong>Capture warning</strong><span>{error}</span><button type="button" aria-label="Dismiss warning" onClick={() => setError(null)}>×</button></div>}
      <div className={`workspace${error ? " has-error" : ""}`}>
        <EndpointSidebar device={fallbackDevice} endpoints={endpoints} total={page.total} selected={endpoint} onSelect={selectEndpoint} />
        <RequestTable exchanges={page.exchanges} total={page.total} offset={offset} limit={PAGE_LIMIT} selectedId={selectedId} busy={busy} onSelect={setSelectedId} onPage={changePage} />
        <RawInspector exchange={selectedDetail} />
      </div>
      <HealthStrip status={status} received={null} persisted={summary?.eventCount ?? null} malformed={null} dropped={null} queueDepth={null} throughput={null} drift={null} reconnects={null} lastEventAge={null} sessionPath={summary?.sessionDir ?? null} />
    </main>
  );
}
