<script lang="ts">
  interface Props {
    status: string;
    eventCount: number;
    droppedCount: number;
    providerCount: number;
    sessionPath: string | null;
  }

  let { status, eventCount, droppedCount, providerCount, sessionPath }: Props = $props();
</script>

<footer class="health-strip">
  <div><span class={`health-dot ${droppedCount > 0 ? "danger" : "healthy"}`}></span>Capture {status}</div>
  <div><small>PROVIDERS</small><strong>{providerCount}</strong></div>
  <div><small>PERSISTED</small><strong>{eventCount.toLocaleString()}</strong></div>
  <div><small>DROPPED</small><strong class:danger-text={droppedCount > 0}>{droppedCount}</strong></div>
  <div class="path" title={sessionPath ?? ""}><small>SESSION</small><strong>{sessionPath ?? "No session"}</strong></div>
  <div class="evidence-key"><span class="observed"></span>Observed <span class="enriched"></span>Enriched <span class="inferred"></span>Inferred</div>
</footer>

<style>
  .health-strip { height: 30px; display: flex; align-items: center; gap: 22px; padding: 0 12px; border-top: 1px solid var(--border); background: var(--panel); color: var(--muted); font-size: 10px; }
  .health-strip > div { display: flex; align-items: center; gap: 6px; min-width: 0; }
  small { font-size: 8px; letter-spacing: .07em; }
  strong { color: var(--text); font-family: var(--mono); font-size: 10px; font-weight: 550; }
  .health-dot { width: 6px; height: 6px; border-radius: 50%; }
  .healthy { background: var(--success); }
  .danger { background: var(--danger); }
  .danger-text { color: var(--danger); }
  .path { flex: 1; overflow: hidden; }
  .path strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .evidence-key { margin-left: auto; }
  .evidence-key span { width: 6px; height: 6px; border-radius: 2px; margin-left: 4px; }
  .evidence-key .observed { background: var(--observed); }
  .evidence-key .enriched { background: var(--enriched); }
  .evidence-key .inferred { background: var(--inferred); }
</style>
