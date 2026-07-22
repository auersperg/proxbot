import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { CaptureSummary, EventPage, FridaPreflight } from "./contracts";

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
  };
}

export const api = createApi();
