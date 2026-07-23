import { useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import EndpointSidebar from "./components/EndpointSidebar";
import HealthStrip from "./components/HealthStrip";
import RawInspector from "./components/RawInspector";
import RequestTable from "./components/RequestTable";
import Toolbar from "./components/Toolbar";
import { api, type ApiClient } from "./lib/api";
import type { CaptureMetrics, CaptureProfile, CaptureSnapshot, CaptureStatus, DevicePreflight, EndpointFilter, EndpointSummary, EvidenceSource, ExchangePage, WireGuardSetup } from "./lib/contracts";
import "./styles.css";

const PAGE_LIMIT = 200;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const INSPECTOR_MIN = 210;
const INSPECTOR_MAX = 520;
const SIDEBAR_STORAGE = "proxbot.layout.sidebarWidth";
const INSPECTOR_STORAGE = "proxbot.layout.inspectorHeight";

type ErrorLane = "capture" | "query" | "preflight" | "detail";

const EMPTY_METRICS: CaptureMetrics = {
  received: null, persisted: null, malformed: null, dropped: null, queueDepth: null,
  throughputPerSecond: null, driftMs: null, reconnects: null, lastEventAgeMs: null,
};

interface WorkspaceState {
  operations: string[];
  revision: number;
  status: CaptureStatus;
  profile: CaptureProfile;
  device: DevicePreflight | null;
  sessionId: string | null;
  sessionDir: string | null;
  metrics: CaptureMetrics;
  sources: EvidenceSource[];
  wireguardSetup: WireGuardSetup | null;
  endpoints: EndpointSummary[];
  page: ExchangePage;
  deviceTotal: number;
  selectedId: string | null;
  selectedDetail: ExchangePage["exchanges"][number] | null;
  endpoint: EndpointFilter | null;
  query: string;
  offset: number;
  errors: Record<ErrorLane, string | null>;
  sidebarWidth: number;
  inspectorHeight: number;
  viewportHeight: number;
}

type WorkspaceAction =
  | { type: "patch"; value: Partial<WorkspaceState> }
  | { type: "operation-started"; token: string }
  | { type: "operation-finished"; token: string }
  | { type: "snapshot-received"; snapshot: CaptureSnapshot }
  | { type: "page-loaded"; page: ExchangePage; endpoints: EndpointSummary[] | null; offset: number; deviceTotal: number | null }
  | { type: "sidebar-resized"; value: number }
  | { type: "inspector-resized"; value: number }
  | { type: "viewport-resized"; height: number }
  | { type: "error-set"; lane: ErrorLane; value: string | null }
  | { type: "errors-cleared" };

function storedNumber(key: string, fallback: number, minimum: number, maximum: number) {
  try {
    const parsed = Number.parseInt(window.localStorage.getItem(key) ?? "", 10);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  } catch {
    return fallback;
  }
}

function initialState(): WorkspaceState {
  return {
    operations: [],
    revision: -1,
    status: "idle",
    profile: "wireguard",
    device: null,
    sessionId: null,
    sessionDir: null,
    metrics: EMPTY_METRICS,
    sources: [],
    wireguardSetup: null,
    endpoints: [],
    page: { exchanges: [], total: 0 },
    deviceTotal: 0,
    selectedId: null,
    selectedDetail: null,
    endpoint: null,
    query: "",
    offset: 0,
    errors: { capture: null, query: null, preflight: null, detail: null },
    sidebarWidth: storedNumber(SIDEBAR_STORAGE, 232, SIDEBAR_MIN, SIDEBAR_MAX),
    inspectorHeight: storedNumber(INSPECTOR_STORAGE, 300, INSPECTOR_MIN, INSPECTOR_MAX),
    viewportHeight: window.innerHeight,
  };
}

function reducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "patch": return { ...state, ...action.value };
    case "operation-started": return state.operations.includes(action.token) ? state : { ...state, operations: [...state.operations, action.token] };
    case "operation-finished": return { ...state, operations: state.operations.filter((token) => token !== action.token) };
    case "snapshot-received": {
      const snapshot = action.snapshot;
      if (snapshot.revision < state.revision) return state;
      const newSession = snapshot.sessionId !== state.sessionId;
      return {
        ...state,
        revision: snapshot.revision,
        status: snapshot.status,
        profile: snapshot.profile ?? state.profile,
        device: snapshot.device ?? state.device,
        sessionId: snapshot.sessionId,
        sessionDir: snapshot.sessionDir,
        metrics: snapshot.metrics,
        sources: snapshot.sources,
        wireguardSetup: snapshot.profile === "wireguard" ? state.wireguardSetup : null,
        ...(newSession ? {
          endpoints: [], page: { exchanges: [], total: 0 }, deviceTotal: 0,
          selectedId: null, selectedDetail: null, endpoint: null, offset: 0,
        } : {}),
        errors: { ...state.errors, capture: snapshot.error },
      };
    }
    case "page-loaded": {
      const selectedId = action.page.exchanges.some((item) => item.requestId === state.selectedId)
        ? state.selectedId
        : action.page.exchanges[0]?.requestId ?? null;
      return {
        ...state,
        endpoints: action.endpoints ?? state.endpoints,
        page: action.page,
        offset: action.offset,
        selectedId,
        deviceTotal: action.deviceTotal ?? state.deviceTotal,
      };
    }
    case "sidebar-resized": return { ...state, sidebarWidth: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(action.value))) };
    case "inspector-resized": return { ...state, inspectorHeight: Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(action.value))) };
    case "viewport-resized": return { ...state, viewportHeight: action.height };
    case "error-set": return { ...state, errors: { ...state.errors, [action.lane]: action.value } };
    case "errors-cleared": return { ...state, errors: { capture: null, query: null, preflight: null, detail: null } };
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

interface SplitterProps {
  orientation: "vertical" | "horizontal";
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  onResize: (value: number) => void;
}

function WorkspaceSplitter({ orientation, label, value, minimum, maximum, onResize }: SplitterProps) {
  const resizeFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const workspace = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!workspace) return;
    const requested = orientation === "vertical" ? event.clientX - workspace.left : workspace.bottom - event.clientY;
    const layoutMaximum = orientation === "horizontal" ? Math.min(maximum, workspace.height - 285) : maximum;
    onResize(Math.min(layoutMaximum, Math.max(minimum, requested)));
  };
  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = orientation === "vertical"
      ? event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0
      : event.key === "ArrowUp" ? 16 : event.key === "ArrowDown" ? -16 : 0;
    if (!delta) return;
    event.preventDefault();
    onResize(value + delta);
  };
  return (
    <div
      className={`workspace-splitter splitter-${orientation}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={resizeFromPointer}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onPointerCancel={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={resizeFromKeyboard}
    />
  );
}

export default function App({ client = api }: { client?: ApiClient }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const requestEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const captureEpoch = useRef(0);
  const statusInFlight = useRef(false);
  const latestRevision = useRef(-1);
  const latestSession = useRef<string | null>(null);
  const queryRef = useRef("");
  const endpointRef = useRef<EndpointFilter | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const operationSequence = useRef(0);
  const lastQueryKey = useRef<string | null>(null);
  const busy = state.operations.length > 0;
  const controlsBusy = state.operations.some((token) => !token.startsWith("query:"));
  const selectedPageVersion = state.page.exchanges.find((exchange) => exchange.requestId === state.selectedId);
  const selectedDetailVersion = selectedPageVersion
    ? `${selectedPageVersion.requestSequence ?? ""}:${selectedPageVersion.responseSequence ?? ""}`
    : "";
  queryRef.current = state.query;
  endpointRef.current = state.endpoint;
  deviceIdRef.current = state.device?.id ?? null;

  const beginOperation = useCallback((kind: string) => {
    const token = `${kind}:${++operationSequence.current}`;
    dispatch({ type: "operation-started", token });
    return token;
  }, []);
  const finishOperation = useCallback((token: string) => dispatch({ type: "operation-finished", token }), []);

  const load = useCallback(async (
    sessionId: string,
    nextQuery: string,
    nextEndpoint: EndpointFilter | null,
    nextOffset: number,
    refreshDeviceTotal: boolean,
    refreshEndpoints: boolean,
  ) => {
    const epoch = ++requestEpoch.current;
    const token = beginOperation("query");
    dispatch({ type: "error-set", lane: "query", value: null });
    try {
      const pagePromise = client.pageExchanges(sessionId, { query: nextQuery, endpoint: nextEndpoint, offset: nextOffset, limit: PAGE_LIMIT });
      const devicePagePromise = refreshDeviceTotal && nextEndpoint
        ? client.pageExchanges(sessionId, { query: nextQuery, endpoint: null, offset: 0, limit: 1 })
        : Promise.resolve<ExchangePage | null>(null);
      const [nextEndpoints, nextPage, devicePage] = await Promise.all([
        refreshEndpoints ? client.listEndpoints(sessionId, nextQuery, 2_000) : Promise.resolve<EndpointSummary[] | null>(null),
        pagePromise,
        devicePagePromise,
      ]);
      if (epoch !== requestEpoch.current) return;
      dispatch({
        type: "page-loaded",
        endpoints: nextEndpoints,
        page: nextPage,
        offset: nextOffset,
        deviceTotal: nextEndpoint === null ? nextPage.total : devicePage?.total ?? null,
      });
    } catch (reason) {
      if (epoch === requestEpoch.current) throw reason;
    } finally {
      finishOperation(token);
    }
  }, [beginOperation, client, finishOperation]);

  const refreshDevice = useCallback(async (tracked: boolean) => {
    const token = tracked ? beginOperation("preflight") : null;
    dispatch({ type: "error-set", lane: "preflight", value: null });
    try {
      const result = await client.devicePreflight(deviceIdRef.current);
      dispatch({ type: "patch", value: { device: result } });
      const ready = result.available && result.paired && result.trusted;
      dispatch({ type: "error-set", lane: "preflight", value: ready ? null : result.error ?? "USB iPhone is not available, paired, and trusted." });
    } catch (reason) {
      dispatch({ type: "error-set", lane: "preflight", value: errorText(reason) });
    } finally {
      if (token) finishOperation(token);
    }
  }, [beginOperation, client, finishOperation]);

  const acceptSnapshot = useCallback(async (snapshot: CaptureSnapshot, refreshData: boolean) => {
    const previousSession = latestSession.current;
    if (snapshot.revision < latestRevision.current) return;
    const changed = snapshot.revision !== latestRevision.current || snapshot.sessionId !== previousSession;
    latestRevision.current = snapshot.revision;
    latestSession.current = snapshot.sessionId;
    dispatch({ type: "snapshot-received", snapshot });
    if (!refreshData && snapshot.sessionId && snapshot.sessionId !== previousSession) {
      // The status subscriber owns the first coalesced realtime load. Mark the
      // empty query key as scheduled so the query effect does not launch a
      // duplicate request for the same newly observed session.
      lastQueryKey.current = `${snapshot.sessionId}\u0000`;
    }
    if (!refreshData || !changed || !snapshot.sessionId || snapshot.status === "idle" || snapshot.status === "starting") return;
    const nextEndpoint = snapshot.sessionId === previousSession ? endpointRef.current : null;
    const nextQuery = snapshot.sessionId === previousSession ? queryRef.current : "";
    try {
      await load(snapshot.sessionId, nextQuery, nextEndpoint, 0, true, true);
      lastQueryKey.current = `${snapshot.sessionId}\u0000${nextQuery}`;
    } catch (reason) {
      dispatch({ type: "error-set", lane: "query", value: errorText(reason) });
    }
  }, [load]);

  const pollStatus = useCallback(async (reportError: boolean, refreshData: boolean) => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try {
      await acceptSnapshot(await client.getCaptureStatus(), refreshData);
    } catch (reason) {
      if (reportError) dispatch({ type: "error-set", lane: "capture", value: errorText(reason) });
    } finally {
      statusInFlight.current = false;
    }
  }, [acceptSnapshot, client]);

  const startCapture = async () => {
    const epoch = ++captureEpoch.current;
    requestEpoch.current += 1;
    detailEpoch.current += 1;
    const token = beginOperation("start");
    dispatch({
      type: "patch",
      value: {
        status: "starting",
        endpoint: null,
        query: "",
        sessionId: null,
        sessionDir: null,
        metrics: EMPTY_METRICS,
        sources: [],
        wireguardSetup: null,
        endpoints: [],
        page: { exchanges: [], total: 0 },
        deviceTotal: 0,
        selectedId: null,
        selectedDetail: null,
        offset: 0,
      },
    });
    dispatch({ type: "errors-cleared" });
    try {
      const snapshot = await client.startCapture({ profile: state.profile, deviceId: state.device?.id ?? null });
      if (epoch !== captureEpoch.current) return;
      await acceptSnapshot(snapshot, true);
    } catch (reason) {
      if (epoch === captureEpoch.current) {
        dispatch({ type: "patch", value: { status: "error" } });
        dispatch({ type: "error-set", lane: "capture", value: errorText(reason) });
      }
    } finally {
      finishOperation(token);
    }
  };

  const stopCapture = async () => {
    ++captureEpoch.current;
    const token = beginOperation("stop");
    dispatch({ type: "patch", value: { status: "stopping" } });
    dispatch({ type: "error-set", lane: "capture", value: null });
    try {
      await acceptSnapshot(await client.stopCapture(), true);
    } catch (reason) {
      dispatch({ type: "patch", value: { status: "error" } });
      dispatch({ type: "error-set", lane: "capture", value: errorText(reason) });
    } finally {
      finishOperation(token);
    }
  };

  const addMarker = async () => {
    const token = beginOperation("marker");
    dispatch({ type: "error-set", lane: "capture", value: null });
    try {
      await client.addMarker(null);
    } catch (reason) {
      dispatch({ type: "error-set", lane: "capture", value: errorText(reason) });
    } finally {
      finishOperation(token);
    }
  };

  const refreshCapture = async () => {
    const token = beginOperation("refresh");
    dispatch({ type: "errors-cleared" });
    try {
      await Promise.all([refreshDevice(false), pollStatus(true, false)]);
      const sessionId = latestSession.current;
      if (sessionId) await load(sessionId, queryRef.current, endpointRef.current, 0, true, true);
    } catch (reason) {
      dispatch({ type: "error-set", lane: "capture", value: errorText(reason) });
    } finally {
      finishOperation(token);
    }
  };

  const selectEndpoint = useCallback(async (nextEndpoint: EndpointFilter | null) => {
    dispatch({ type: "patch", value: { endpoint: nextEndpoint } });
    dispatch({ type: "error-set", lane: "query", value: null });
    if (!state.sessionId) return;
    try {
      await load(state.sessionId, state.query, nextEndpoint, 0, false, false);
    } catch (reason) {
      dispatch({ type: "error-set", lane: "query", value: errorText(reason) });
    }
  }, [load, state.query, state.sessionId]);

  const changePage = useCallback(async (nextOffset: number) => {
    if (!state.sessionId) return;
    dispatch({ type: "error-set", lane: "query", value: null });
    try {
      await load(state.sessionId, state.query, state.endpoint, nextOffset, false, false);
    } catch (reason) {
      dispatch({ type: "error-set", lane: "query", value: errorText(reason) });
    }
  }, [load, state.endpoint, state.query, state.sessionId]);

  useEffect(() => {
    if (!state.sessionId) return;
    const key = `${state.sessionId}\u0000${state.query}`;
    if (lastQueryKey.current === key) return;
    lastQueryKey.current = key;
    const timer = window.setTimeout(() => {
      load(state.sessionId!, state.query, state.endpoint, 0, true, true)
        .catch((reason) => dispatch({ type: "error-set", lane: "query", value: errorText(reason) }));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [load, state.endpoint, state.query, state.sessionId]);

  useEffect(() => {
    if (!state.sessionId || !state.selectedId) {
      detailEpoch.current += 1;
      dispatch({ type: "patch", value: { selectedDetail: null } });
      return;
    }
    const epoch = ++detailEpoch.current;
    dispatch({ type: "patch", value: { selectedDetail: null } });
    dispatch({ type: "error-set", lane: "detail", value: null });
    const sessionId = state.sessionId;
    const selectedId = state.selectedId;
    const timer = window.setTimeout(() => {
      client.getExchange(sessionId, selectedId)
        .then((exchange) => {
          if (epoch === detailEpoch.current) dispatch({ type: "patch", value: { selectedDetail: exchange } });
        })
        .catch((reason) => {
          if (epoch === detailEpoch.current) dispatch({ type: "error-set", lane: "detail", value: errorText(reason) });
        });
    }, 75);
    return () => {
      window.clearTimeout(timer);
      if (epoch === detailEpoch.current) detailEpoch.current += 1;
    };
  }, [client, selectedDetailVersion, state.selectedId, state.sessionId]);

  useEffect(() => {
    const active = state.status === "capturing" || state.status === "degraded";
    if (state.profile !== "wireguard" || !active || !state.sessionId) {
      if (state.wireguardSetup !== null) {
        dispatch({ type: "patch", value: { wireguardSetup: null } });
      }
      return;
    }
    let disposed = false;
    client.getWireGuardSetup()
      .then((wireguardSetup) => {
        if (!disposed) dispatch({ type: "patch", value: { wireguardSetup } });
      })
      .catch((reason) => {
        if (!disposed) dispatch({ type: "error-set", lane: "capture", value: errorText(reason) });
      });
    return () => { disposed = true; };
  }, [client, state.profile, state.sessionId, state.status]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let eventRefreshTimer: number | null = null;
    let eventRefreshInFlight = false;
    let eventRefreshDirty = false;
    const scheduleEventRefresh = () => {
      eventRefreshDirty = true;
      if (eventRefreshTimer !== null || eventRefreshInFlight || disposed) return;
      eventRefreshTimer = window.setTimeout(async () => {
        eventRefreshTimer = null;
        const sessionId = latestSession.current;
        if (disposed || !sessionId) return;
        eventRefreshInFlight = true;
        eventRefreshDirty = false;
        try {
          await load(sessionId, queryRef.current, endpointRef.current, 0, true, true);
        } catch (reason) {
          if (!disposed) dispatch({ type: "error-set", lane: "query", value: errorText(reason) });
        } finally {
          eventRefreshInFlight = false;
          if (eventRefreshDirty) scheduleEventRefresh();
        }
      }, 250);
    };
    client.subscribeCaptureStatus((snapshot) => {
      if (disposed) return;
      void acceptSnapshot(snapshot, false);
      if (!snapshot.sessionId || snapshot.status === "idle" || snapshot.status === "starting") return;
      // Coalesce sustained status revisions without starving the table or
      // invalidating every slow query. There is at most one refresh in flight
      // and one trailing refresh records everything that arrived meanwhile.
      scheduleEventRefresh();
    }).then((dispose) => {
      if (disposed) dispose(); else unlisten = dispose;
    }).catch(() => { /* polling remains the compatibility path */ });
    void refreshDevice(false);
    void pollStatus(true, true);
    const timer = window.setInterval(() => void pollStatus(false, true), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (eventRefreshTimer !== null) window.clearTimeout(eventRefreshTimer);
      unlisten?.();
    };
  }, [acceptSnapshot, client, load, pollStatus, refreshDevice]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(SIDEBAR_STORAGE, String(state.sidebarWidth)); } catch { /* unavailable storage */ }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [state.sidebarWidth]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(INSPECTOR_STORAGE, String(state.inspectorHeight)); } catch { /* unavailable storage */ }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [state.inspectorHeight]);
  useEffect(() => {
    const updateViewport = () => dispatch({ type: "viewport-resized", height: window.innerHeight });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const fallbackDevice = useMemo(() => ({
    name: state.device?.name ?? "USB iPhone",
    id: state.device?.id ?? "Device preflight required",
    available: state.device?.available === true,
  }), [state.device]);
  const error = state.errors.capture ?? state.errors.query ?? state.errors.detail ?? state.errors.preflight;
  const workspaceHeight = state.viewportHeight - 48 - 29 - (error ? 34 : 0);
  const inspectorMaximum = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, workspaceHeight - 285));
  const inspectorHeight = Math.min(state.inspectorHeight, inspectorMaximum);
  const workspaceStyle = {
    "--sidebar-width": `${state.sidebarWidth}px`,
    "--inspector-height": `${inspectorHeight}px`,
  } as CSSProperties;

  return (
    <main className="app-shell" aria-label="proxbot">
      <Toolbar
        busy={controlsBusy}
        status={state.status}
        device={state.device}
        profile={state.profile}
        query={state.query}
        onQuery={(query) => dispatch({ type: "patch", value: { query } })}
        onProfile={(profile) => dispatch({ type: "patch", value: { profile } })}
        onStart={startCapture}
        onStop={stopCapture}
        onRefresh={refreshCapture}
        onMarker={addMarker}
      />
      {error && <div className="error-banner" role="alert"><strong>Capture warning</strong><span>{error}</span><button type="button" aria-label="Dismiss warning" onClick={() => dispatch({ type: "errors-cleared" })}>×</button></div>}
      <div className={`workspace${error ? " has-error" : ""}`} style={workspaceStyle}>
        <EndpointSidebar device={fallbackDevice} endpoints={state.endpoints} total={state.deviceTotal} selected={state.endpoint} sources={state.sources} wireguardSetup={state.wireguardSetup} onSelect={selectEndpoint} />
        <WorkspaceSplitter orientation="vertical" label="Resize endpoint sidebar" value={state.sidebarWidth} minimum={SIDEBAR_MIN} maximum={SIDEBAR_MAX} onResize={(value) => dispatch({ type: "sidebar-resized", value })} />
        <RequestTable exchanges={state.page.exchanges} total={state.page.total} offset={state.offset} limit={PAGE_LIMIT} selectedId={state.selectedId} busy={busy} onSelect={(selectedId) => dispatch({ type: "patch", value: { selectedId } })} onPage={changePage} />
        <WorkspaceSplitter orientation="horizontal" label="Resize raw inspector" value={inspectorHeight} minimum={INSPECTOR_MIN} maximum={inspectorMaximum} onResize={(value) => dispatch({ type: "inspector-resized", value: Math.min(inspectorMaximum, value) })} />
        <RawInspector exchange={state.selectedDetail} sources={state.sources} />
      </div>
      <HealthStrip
        status={state.status}
        received={state.metrics.received}
        persisted={state.metrics.persisted}
        malformed={state.metrics.malformed}
        dropped={state.metrics.dropped}
        queueDepth={state.metrics.queueDepth}
        throughput={state.metrics.throughputPerSecond === null ? null : `${state.metrics.throughputPerSecond.toFixed(1)} evt/s`}
        drift={state.metrics.driftMs === null ? null : `${state.metrics.driftMs.toFixed(1)} ms`}
        reconnects={state.metrics.reconnects}
        lastEventAge={state.metrics.lastEventAgeMs === null ? null : `${state.metrics.lastEventAgeMs} ms`}
        sessionPath={state.sessionDir}
      />
    </main>
  );
}
