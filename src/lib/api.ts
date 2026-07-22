import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  CaptureSummary,
  EndpointSummary,
  EventPage,
  ExchangePage,
  ExchangeQuery,
  ExchangeRow,
  FridaPreflight,
} from "./contracts";

export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function createApi(invoke: Invoke = tauriInvoke) {
  return {
    createDemoSession: (count: number) =>
      invoke<CaptureSummary>("create_demo_session", { count }),
    pageEvents: (sessionId: string, offset: number, limit: number) =>
      invoke<EventPage>("page_events", { sessionId, offset, limit }),
    fridaPreflight: () => invoke<FridaPreflight>("frida_preflight"),
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
