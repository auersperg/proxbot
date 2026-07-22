import { useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import EndpointSidebar from "./components/EndpointSidebar";
import HealthStrip from "./components/HealthStrip";
import RawInspector from "./components/RawInspector";
import RequestTable from "./components/RequestTable";
import Toolbar from "./components/Toolbar";
import { api, type ApiClient } from "./lib/api";
import type { CaptureSummary, EndpointFilter, EndpointSummary, ExchangePage, FridaPreflight } from "./lib/contracts";
import "./styles.css";

const PAGE_LIMIT = 200;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const INSPECTOR_MIN = 210;
const INSPECTOR_MAX = 520;
const SIDEBAR_STORAGE = "proxbot.layout.sidebarWidth";
const INSPECTOR_STORAGE = "proxbot.layout.inspectorHeight";

type CaptureStatus = "idle" | "capturing" | "ready" | "error" | "degraded";
type ErrorLane = "capture" | "query" | "preflight" | "detail";

interface WorkspaceState {
  operations: string[];
  status: CaptureStatus;
  device: FridaPreflight | null;
  summary: CaptureSummary | null;
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
    status: "idle",
    device: null,
    summary: null,
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
  const operationSequence = useRef(0);
  const lastQueryKey = useRef<string | null>(null);
  const busy = state.operations.length > 0;

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

  const runPreflight = async () => {
    const token = beginOperation("preflight");
    dispatch({ type: "error-set", lane: "preflight", value: null });
    try {
      const result = await client.fridaPreflight();
      dispatch({ type: "patch", value: { device: result } });
      dispatch({ type: "error-set", lane: "preflight", value: result.available ? null : result.error ?? "USB iPhone is unavailable." });
    } catch (reason) {
      dispatch({ type: "error-set", lane: "preflight", value: errorText(reason) });
    } finally {
      finishOperation(token);
    }
  };

  const runCapture = async () => {
    const epoch = ++captureEpoch.current;
    requestEpoch.current += 1;
    detailEpoch.current += 1;
    const token = beginOperation("capture");
    dispatch({
      type: "patch",
      value: {
        status: "capturing",
        endpoint: null,
        query: "",
        summary: null,
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
      const nextSummary = await client.createDemoSession(161);
      if (epoch !== captureEpoch.current) return;
      dispatch({ type: "patch", value: { summary: nextSummary } });
      lastQueryKey.current = `${nextSummary.sessionId}\u0000`;
      await load(nextSummary.sessionId, "", null, 0, true, true);
      if (epoch === captureEpoch.current) dispatch({ type: "patch", value: { status: "ready" } });
    } catch (reason) {
      if (epoch === captureEpoch.current) {
        dispatch({ type: "patch", value: { status: "error" } });
        dispatch({ type: "error-set", lane: "capture", value: errorText(reason) });
      }
    } finally {
      finishOperation(token);
    }
  };

  const selectEndpoint = useCallback(async (nextEndpoint: EndpointFilter | null) => {
    dispatch({ type: "patch", value: { endpoint: nextEndpoint } });
    dispatch({ type: "error-set", lane: "query", value: null });
    if (!state.summary) return;
    try {
      await load(state.summary.sessionId, state.query, nextEndpoint, 0, false, false);
    } catch (reason) {
      dispatch({ type: "error-set", lane: "query", value: errorText(reason) });
    }
  }, [load, state.query, state.summary]);

  const changePage = useCallback(async (nextOffset: number) => {
    if (!state.summary) return;
    dispatch({ type: "error-set", lane: "query", value: null });
    try {
      await load(state.summary.sessionId, state.query, state.endpoint, nextOffset, false, false);
    } catch (reason) {
      dispatch({ type: "error-set", lane: "query", value: errorText(reason) });
    }
  }, [load, state.endpoint, state.query, state.summary]);

  useEffect(() => {
    if (!state.summary) return;
    const key = `${state.summary.sessionId}\u0000${state.query}`;
    if (lastQueryKey.current === key) return;
    lastQueryKey.current = key;
    const timer = window.setTimeout(() => {
      load(state.summary!.sessionId, state.query, state.endpoint, 0, true, true)
        .catch((reason) => dispatch({ type: "error-set", lane: "query", value: errorText(reason) }));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [load, state.endpoint, state.query, state.summary]);

  useEffect(() => {
    if (!state.summary || !state.selectedId) {
      detailEpoch.current += 1;
      dispatch({ type: "patch", value: { selectedDetail: null } });
      return;
    }
    const epoch = ++detailEpoch.current;
    dispatch({ type: "patch", value: { selectedDetail: null } });
    dispatch({ type: "error-set", lane: "detail", value: null });
    const sessionId = state.summary.sessionId;
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
  }, [client, state.selectedId, state.summary]);

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
      <Toolbar busy={busy} status={state.status} device={state.device} query={state.query} onQuery={(query) => dispatch({ type: "patch", value: { query } })} onPreflight={runPreflight} onStart={runCapture} />
      {error && <div className="error-banner" role="alert"><strong>Capture warning</strong><span>{error}</span><button type="button" aria-label="Dismiss warning" onClick={() => dispatch({ type: "errors-cleared" })}>×</button></div>}
      <div className={`workspace${error ? " has-error" : ""}`} style={workspaceStyle}>
        <EndpointSidebar device={fallbackDevice} endpoints={state.endpoints} total={state.deviceTotal} selected={state.endpoint} onSelect={selectEndpoint} />
        <WorkspaceSplitter orientation="vertical" label="Resize endpoint sidebar" value={state.sidebarWidth} minimum={SIDEBAR_MIN} maximum={SIDEBAR_MAX} onResize={(value) => dispatch({ type: "sidebar-resized", value })} />
        <RequestTable exchanges={state.page.exchanges} total={state.page.total} offset={state.offset} limit={PAGE_LIMIT} selectedId={state.selectedId} busy={busy} onSelect={(selectedId) => dispatch({ type: "patch", value: { selectedId } })} onPage={changePage} />
        <WorkspaceSplitter orientation="horizontal" label="Resize raw inspector" value={inspectorHeight} minimum={INSPECTOR_MIN} maximum={inspectorMaximum} onResize={(value) => dispatch({ type: "inspector-resized", value: Math.min(inspectorMaximum, value) })} />
        <RawInspector exchange={state.selectedDetail} />
      </div>
      <HealthStrip status={state.status} received={null} persisted={state.summary?.eventCount ?? null} malformed={null} dropped={null} queueDepth={null} throughput={null} drift={null} reconnects={null} lastEventAge={null} sessionPath={state.summary?.sessionDir ?? null} />
    </main>
  );
}
