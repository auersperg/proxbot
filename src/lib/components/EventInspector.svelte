<script lang="ts">
  import type { ProviderEvent } from "$lib/contracts";

  interface Props { event: ProviderEvent | null; }
  let { event }: Props = $props();
</script>

<aside class="inspector" aria-label="Event inspector">
  <header><strong>Inspector</strong><span>{event ? `#${event.sequence}` : "—"}</span></header>
  {#if event}
    <div class="summary-grid">
      <div class="field">Evidence<strong class={`evidence-${event.evidence}`}>{event.evidence.toUpperCase()}</strong></div>
      <div class="field">Provider<strong>{event.providerId} · {event.providerVersion}</strong></div>
      <div class="field">Process<strong>{event.processName ?? "—"} {event.processId ? `(${event.processId})` : ""}</strong></div>
      <div class="field">Kind<strong>{event.kind}</strong></div>
      <div class="field">Parse status<strong>{event.parseStatus}</strong></div>
      <div class="field">Device<strong>{event.deviceId ?? "—"}</strong></div>
    </div>
    <section>
      <h2>Raw provider payload</h2>
      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
    </section>
    <section>
      <h2>Correlation coordinates</h2>
      <dl>
        <div><dt>Source</dt><dd>{event.sourceTimeNs}</dd></div>
        <div><dt>Host</dt><dd>{event.hostTimeNs}</dd></div>
        <div><dt>Monotonic</dt><dd>{event.monotonicTimeNs ?? "—"}</dd></div>
      </dl>
    </section>
  {:else}
    <div class="inspector-empty">Select an event to inspect its raw provider record.</div>
  {/if}
</aside>

<style>
  .inspector { min-width: 0; height: 100%; overflow: auto; background: var(--panel); border-left: 1px solid var(--border); }
  header { height: 34px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid var(--border); }
  header strong { font-size: 11px; color: var(--text-strong); }
  header span { color: var(--muted); font: 10px var(--mono); }
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 14px 12px; border-bottom: 1px solid var(--border); }
  .field { color: var(--muted); font-size: 9px; letter-spacing: .06em; text-transform: uppercase; }
  .field strong { display: block; margin-top: 4px; color: var(--text); font: 10px/1.35 var(--mono); letter-spacing: 0; text-transform: none; overflow-wrap: anywhere; }
  .evidence-observed { color: var(--observed); }
  .evidence-enriched { color: var(--enriched); }
  .evidence-inferred { color: var(--inferred); }
  section { padding: 12px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0 0 9px; color: var(--muted); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
  pre { margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--code); color: var(--code-text); font: 10px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  dl { margin: 0; display: grid; gap: 6px; }
  dl div { display: flex; justify-content: space-between; gap: 12px; }
  dt { color: var(--muted); font-size: 10px; }
  dd { margin: 0; color: var(--text); font: 10px var(--mono); }
  .inspector-empty { padding: 40px 24px; color: var(--muted); text-align: center; font-size: 11px; line-height: 1.6; }
</style>
