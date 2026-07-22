<script lang="ts">
  import CaptureToolbar from "$lib/components/CaptureToolbar.svelte";
  import EventInspector from "$lib/components/EventInspector.svelte";
  import HealthStrip from "$lib/components/HealthStrip.svelte";
  import Timeline from "$lib/components/Timeline.svelte";
  import { api } from "$lib/api";
  import type {
    CaptureSummary,
    EventPage,
    FridaPreflight,
    ProviderEvent,
  } from "$lib/contracts";

  type CaptureStatus = "idle" | "capturing" | "ready" | "error";

  let busy = $state(false);
  let status = $state<CaptureStatus>("idle");
  let fridaDevice = $state<FridaPreflight | null>(null);
  let summary = $state<CaptureSummary | null>(null);
  let page = $state<EventPage>({ events: [], total: 0 });
  let selected = $state<ProviderEvent | null>(null);
  let errorMessage = $state<string | null>(null);
  let query = $state("");
  let offset = $state(0);
  const pageLimit = 200;

  let filteredEvents = $derived(
    page.events.filter((event) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [
        event.kind,
        event.providerId,
        event.processName ?? "",
        event.evidence,
        JSON.stringify(event.payload),
      ].some((value) => value.toLowerCase().includes(needle));
    }),
  );

  let pageNumber = $derived(Math.floor(offset / pageLimit) + 1);
  let pageCount = $derived(Math.max(1, Math.ceil(page.total / pageLimit)));

  function describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function redactIdentifier(identifier?: string) {
    if (!identifier) return "—";
    if (identifier.length <= 12) return identifier;
    return `${identifier.slice(0, 4)}…${identifier.slice(-4)}`;
  }

  async function checkFrida() {
    busy = true;
    errorMessage = null;
    try {
      fridaDevice = await api.fridaPreflight();
      if (!fridaDevice.available) {
        errorMessage = fridaDevice.error ?? "USB iPhone is unavailable.";
      }
    } catch (error) {
      fridaDevice = { available: false, error: describeError(error) };
      errorMessage = describeError(error);
    } finally {
      busy = false;
    }
  }

  async function loadPage(nextOffset: number) {
    if (!summary) return;
    page = await api.pageEvents(summary.sessionId, nextOffset, pageLimit);
    offset = nextOffset;
    selected = page.events[0] ?? null;
  }

  async function startDemoCapture() {
    busy = true;
    status = "capturing";
    errorMessage = null;
    query = "";
    try {
      summary = await api.createDemoSession(30);
      await loadPage(0);
      status = "ready";
    } catch (error) {
      status = "error";
      errorMessage = describeError(error);
    } finally {
      busy = false;
    }
  }

  async function changePage(nextOffset: number) {
    busy = true;
    errorMessage = null;
    try {
      await loadPage(nextOffset);
    } catch (error) {
      errorMessage = describeError(error);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>proxbot — iOS Evidence Capture</title>
  <meta
    name="description"
    content="Loss-aware iOS application capture, Frida instrumentation, and protocol analysis."
  />
</svelte:head>

<div class="application-shell">
  <CaptureToolbar
    {busy}
    {status}
    {fridaDevice}
    onStart={startDemoCapture}
    onPreflight={checkFrida}
  />

  {#if errorMessage}
    <div class="error-banner" role="alert">
      <strong>Capture warning</strong>
      <span>{errorMessage}</span>
      <button type="button" aria-label="Dismiss warning" onclick={() => (errorMessage = null)}>×</button>
    </div>
  {/if}

  <main class="workspace">
    <aside class="sidebar" aria-label="Capture navigator">
      <section class="sidebar-section device-section">
        <header><h2>Device</h2><span>{fridaDevice?.available ? "READY" : "OFFLINE"}</span></header>
        <div class="device-card">
          <div class="phone-glyph" aria-hidden="true"><span></span></div>
          <div>
            <strong>{fridaDevice?.name ?? "USB iPhone"}</strong>
            <small>{fridaDevice?.type ?? "Device preflight required"}</small>
            <code>{redactIdentifier(fridaDevice?.id)}</code>
          </div>
        </div>
      </section>

      <section class="sidebar-section">
        <header><h2>Session</h2><span>{summary ? "1" : "0"}</span></header>
        {#if summary}
          <button class="session-card active" type="button">
            <span class="session-icon"></span>
            <span>
              <strong>Verified provider capture</strong>
              <small>{summary.eventCount} persisted events</small>
              <code>{summary.sessionId.slice(0, 8)}</code>
            </span>
          </button>
        {:else}
          <p class="sidebar-empty">No session captured yet.</p>
        {/if}
      </section>

      <section class="sidebar-section sources">
        <header><h2>Evidence sources</h2></header>
        <div><span class="source-dot ready"></span><strong>Session core</strong><small>lossless</small></div>
        <div><span class={`source-dot ${fridaDevice?.available ? "ready" : "idle"}`}></span><strong>iPhone USB</strong><small>{fridaDevice?.available ? "paired" : "unchecked"}</small></div>
        <div><span class="source-dot ready"></span><strong>Fake provider</strong><small>verified IPC</small></div>
        <div><span class="source-dot ready"></span><strong>USB PCAP</strong><small>provider ready</small></div>
      </section>

      <section class="sidebar-section scope-note">
        <header><h2>Evidence semantics</h2></header>
        <p><b>Observed</b> records come directly from a provider. Enrichment and inference remain visibly separate.</p>
      </section>
    </aside>

    <section class="capture-panel">
      <div class="capture-controls">
        <div class="search-wrap">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Filter timeline"
            placeholder="Filter process, kind, evidence, or payload…"
            bind:value={query}
          />
          {#if query}<button type="button" aria-label="Clear filter" onclick={() => (query = "")}>×</button>{/if}
        </div>
        <div class="page-controls">
          <span>{filteredEvents.length} shown · {page.total} total</span>
          <button type="button" disabled={busy || offset === 0} onclick={() => changePage(Math.max(0, offset - pageLimit))}>‹</button>
          <code>{pageNumber}/{pageCount}</code>
          <button type="button" disabled={busy || offset + pageLimit >= page.total} onclick={() => changePage(offset + pageLimit)}>›</button>
        </div>
      </div>
      <Timeline
        events={filteredEvents}
        selectedSequence={selected?.sequence ?? null}
        onSelect={(event) => (selected = event)}
      />
    </section>

    <EventInspector event={selected} />
  </main>

  <HealthStrip
    status={status}
    eventCount={summary?.eventCount ?? 0}
    droppedCount={0}
    providerCount={fridaDevice?.available ? 3 : 2}
    sessionPath={summary?.sessionDir ?? null}
  />
</div>

<style>
  :global(*) { box-sizing: border-box; }
  :global(:root) {
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    color: #c8d1dc;
    background: #090d12;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
    --background: #090d12;
    --panel: #0f151d;
    --panel-2: #141c26;
    --code: #0a0f15;
    --code-text: #b7c7d9;
    --border: #25303d;
    --text: #bdc8d5;
    --text-strong: #eef5fc;
    --muted: #718091;
    --accent: #46b7e8;
    --hover: #16212c;
    --selection: #163247;
    --observed: #50c8f3;
    --enriched: #bb8cff;
    --inferred: #efb65f;
    --success: #55d69c;
    --warning: #efb65f;
    --danger: #f16f79;
    --mono: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
  }
  :global(html), :global(body) { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--background); }
  :global(body) { font-size: 12px; }
  :global(button), :global(input) { font: inherit; }
  .application-shell { width: 100vw; height: 100vh; display: grid; grid-template-rows: 52px auto minmax(0, 1fr) 30px; background: var(--background); }
  .workspace { min-height: 0; display: grid; grid-template-columns: 232px minmax(460px, 1fr) minmax(270px, 340px); }
  .sidebar { min-height: 0; overflow: auto; border-right: 1px solid var(--border); background: var(--panel); }
  .sidebar-section { border-bottom: 1px solid var(--border); padding-bottom: 10px; }
  .sidebar-section > header { height: 34px; padding: 0 11px; display: flex; align-items: center; justify-content: space-between; }
  .sidebar-section h2 { margin: 0; color: var(--muted); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
  .sidebar-section header > span { color: var(--muted); font: 9px var(--mono); }
  .device-card { margin: 0 9px; padding: 10px; display: flex; gap: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); }
  .phone-glyph { width: 25px; height: 39px; flex: 0 0 auto; border: 1.5px solid var(--muted); border-radius: 5px; padding: 3px; }
  .phone-glyph span { display: block; height: 100%; border-radius: 2px; background: linear-gradient(145deg, #16334a, #0c1720); }
  .device-card strong, .device-card small, .device-card code { display: block; }
  .device-card strong { color: var(--text-strong); font-size: 11px; }
  .device-card small { margin-top: 2px; color: var(--muted); font-size: 9px; }
  .device-card code { margin-top: 5px; color: var(--accent); font: 9px var(--mono); }
  .session-card { width: calc(100% - 18px); margin: 0 9px; padding: 9px; display: flex; gap: 9px; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: transparent; text-align: left; cursor: default; }
  .session-card.active { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); background: color-mix(in srgb, var(--accent) 7%, var(--panel)); }
  .session-card strong, .session-card small, .session-card code { display: block; }
  .session-card strong { color: var(--text-strong); font-size: 10px; }
  .session-card small { margin-top: 3px; color: var(--muted); font-size: 9px; }
  .session-card code { margin-top: 4px; color: var(--muted); font: 8px var(--mono); }
  .session-icon { width: 8px; height: 8px; margin-top: 3px; border-radius: 2px; background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent); }
  .sidebar-empty { margin: 4px 12px 8px; color: var(--muted); font-size: 10px; }
  .sources > div { height: 28px; display: grid; grid-template-columns: 10px 1fr auto; gap: 7px; align-items: center; padding: 0 11px; }
  .sources strong { font-size: 10px; font-weight: 500; }
  .sources small { color: var(--muted); font-size: 8px; }
  .source-dot { width: 6px; height: 6px; border-radius: 50%; }
  .source-dot.ready { background: var(--success); }
  .source-dot.idle { background: var(--muted); }
  .scope-note p { margin: 0 11px 4px; color: var(--muted); font-size: 9px; line-height: 1.5; }
  .scope-note b { color: var(--observed); }
  .capture-panel { min-width: 0; min-height: 0; display: grid; grid-template-rows: 40px minmax(0, 1fr); border-right: 1px solid var(--border); }
  .capture-controls { display: flex; gap: 12px; align-items: center; padding: 0 10px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .search-wrap { min-width: 180px; max-width: 520px; flex: 1; height: 27px; display: flex; align-items: center; gap: 7px; padding: 0 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--code); color: var(--muted); }
  .search-wrap:focus-within { border-color: color-mix(in srgb, var(--accent) 70%, var(--border)); }
  .search-wrap input { min-width: 0; flex: 1; border: 0; outline: 0; color: var(--text); background: transparent; font-size: 10px; }
  .search-wrap input::placeholder { color: #536171; }
  .search-wrap button { border: 0; padding: 0; color: var(--muted); background: transparent; cursor: pointer; }
  .page-controls { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 9px; }
  .page-controls button { width: 24px; height: 24px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--panel-2); cursor: pointer; }
  .page-controls button:disabled { opacity: .35; }
  .page-controls code { min-width: 34px; text-align: center; font: 9px var(--mono); }
  .error-banner { min-height: 34px; display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); color: #ffc1c6; background: color-mix(in srgb, var(--danger) 10%, var(--panel)); font-size: 10px; }
  .error-banner strong { color: var(--danger); }
  .error-banner span { flex: 1; }
  .error-banner button { border: 0; color: var(--danger); background: transparent; font-size: 16px; cursor: pointer; }
  @media (max-width: 1180px) { .workspace { grid-template-columns: 205px minmax(420px, 1fr) 290px; } }
</style>
