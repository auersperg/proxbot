<script lang="ts">
  import type { ProviderEvent } from "$lib/contracts";

  interface Props {
    events: ProviderEvent[];
    selectedSequence: number | null;
    onSelect: (event: ProviderEvent) => void;
  }

  let { events, selectedSequence, onSelect }: Props = $props();

  function onKeyDown(keyboardEvent: KeyboardEvent, event: ProviderEvent) {
    if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
      keyboardEvent.preventDefault();
      onSelect(event);
    }
  }

  function formatTime(nanoseconds: string) {
    const milliseconds = Number(BigInt(nanoseconds) / 1_000_000n);
    return new Date(milliseconds).toISOString().slice(11, 23);
  }
</script>

<section class="timeline" aria-label="Capture timeline">
  <header class="timeline-header">
    <span>Time</span>
    <span>Evidence</span>
    <span>Process</span>
    <span>Event</span>
    <span>Sequence</span>
  </header>
  <div class="timeline-scroll">
    {#each events as event (`${event.providerId}:${event.sequence}`)}
      <button
        type="button"
        class:selected={selectedSequence === event.sequence}
        class="timeline-row"
        aria-label={`${event.kind} from ${event.processName ?? event.providerId}`}
        onclick={() => onSelect(event)}
        onkeydown={(keyboardEvent) => onKeyDown(keyboardEvent, event)}
      >
        <span class="mono time">{formatTime(event.hostTimeNs)}</span>
        <span class={`badge evidence-${event.evidence}`}>{event.evidence.toUpperCase()}</span>
        <span class="truncate">{event.processName ?? "—"}</span>
        <span class="event-kind truncate">{event.kind}</span>
        <span class="mono sequence">#{event.sequence}</span>
      </button>
    {:else}
      <div class="empty-timeline">Start a capture to populate the evidence timeline.</div>
    {/each}
  </div>
</section>

<style>
  .timeline {
    min-width: 0;
    height: 100%;
    display: grid;
    grid-template-rows: 34px minmax(0, 1fr);
    background: var(--panel);
  }

  .timeline-header,
  .timeline-row {
    display: grid;
    grid-template-columns: 112px 88px minmax(110px, 0.7fr) minmax(180px, 1.5fr) 74px;
    align-items: center;
    column-gap: 10px;
  }

  .timeline-header {
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .timeline-scroll {
    min-height: 0;
    overflow: auto;
  }

  .timeline-row {
    width: 100%;
    min-height: 36px;
    padding: 0 12px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 58%, transparent);
    background: transparent;
    color: var(--text);
    text-align: left;
    font: inherit;
    cursor: default;
  }

  .timeline-row:hover {
    background: var(--hover);
  }

  .timeline-row.selected {
    background: var(--selection);
    box-shadow: inset 2px 0 var(--accent);
  }

  .timeline-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .badge {
    width: fit-content;
    border-radius: 4px;
    padding: 2px 5px;
    font-size: 9px;
    font-weight: 750;
    letter-spacing: 0.05em;
  }

  .evidence-observed { color: var(--observed); background: color-mix(in srgb, var(--observed) 14%, transparent); }
  .evidence-enriched { color: var(--enriched); background: color-mix(in srgb, var(--enriched) 14%, transparent); }
  .evidence-inferred { color: var(--inferred); background: color-mix(in srgb, var(--inferred) 14%, transparent); }
  .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .time, .sequence { color: var(--muted); }
  .event-kind { color: var(--text-strong); }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty-timeline { padding: 32px; color: var(--muted); text-align: center; }
</style>
