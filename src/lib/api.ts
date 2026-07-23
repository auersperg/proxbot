import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CaptureMarker,
  CaptureSnapshot,
  EndpointSummary,
  ExchangePage,
  ExchangeQuery,
  ExchangeRow,
  DevicePreflight,
  StartCaptureRequest,
  WireGuardSetup,
} from "./contracts";

export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type Listen = <T>(event: string, handler: (payload: T) => void) => Promise<UnlistenFn>;

const listenPayload: Listen = <T,>(event: string, handler: (payload: T) => void) =>
  tauriListen<T>(event, ({ payload }) => handler(payload));

export function createApi(invoke: Invoke = tauriInvoke, listen: Listen = listenPayload) {
  return {
    startCapture: (request: StartCaptureRequest) =>
      invoke<CaptureSnapshot>("start_capture", { profile: request.profile, deviceId: request.deviceId }),
    stopCapture: () => invoke<CaptureSnapshot>("stop_capture"),
    getCaptureStatus: () => invoke<CaptureSnapshot>("get_capture_status"),
    getWireGuardSetup: () => invoke<WireGuardSetup>("get_wireguard_setup"),
    addMarker: (label: string | null = null) =>
      invoke<CaptureMarker>("add_capture_marker", { label }),
    subscribeCaptureStatus: (handler: (snapshot: CaptureSnapshot) => void) =>
      listen<CaptureSnapshot>("capture://status", handler),
    devicePreflight: (deviceId: string | null = null) =>
      invoke<DevicePreflight>("device_preflight", { deviceId }),
    listEndpoints: (sessionId: string, query: string, limit: number) =>
      invoke<EndpointSummary[]>("list_endpoints", { sessionId, query, limit }),
    pageExchanges: (sessionId: string, filter: ExchangeQuery) =>
      invoke<ExchangePage>("page_exchanges", {
        sessionId,
        query: filter.query,
        endpointKind: filter.endpoint?.kind ?? null,
        endpointValue: filter.endpoint?.value ?? null,
        offset: filter.offset,
        limit: filter.limit,
      }),
    getExchange: (sessionId: string, requestId: string) =>
      invoke<ExchangeRow | null>("get_exchange", { sessionId, requestId }),
  };
}

export const api = createApi();
export type ApiClient = ReturnType<typeof createApi>;
