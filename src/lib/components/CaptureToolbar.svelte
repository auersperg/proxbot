<script lang="ts">
  import type { FridaPreflight } from "$lib/contracts";

  interface Props {
    busy: boolean;
    status: "idle" | "capturing" | "ready" | "error";
    fridaDevice: FridaPreflight | null;
    onStart: () => void;
    onPreflight: () => void;
  }

  let { busy, status, fridaDevice, onStart, onPreflight }: Props = $props();
</script>

<header class="toolbar">
  <div class="brand" aria-label="proxbot">
    <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
    <div>
      <strong>proxbot</strong>
      <small>iOS Evidence Capture</small>
    </div>
  </div>

  <div class="device-pill" class:connected={fridaDevice?.available === true}>
    <span class="device-dot"></span>
    <div>
      <small>IOS USB</small>
      <strong>
        {#if fridaDevice?.available}
          {fridaDevice.name ?? "iPhone"}
        {:else if fridaDevice?.error}
          Unavailable
        {:else}
          Not checked
        {/if}
      </strong>
    </div>
  </div>

  <div class="toolbar-spacer"></div>
  <div class={`status status-${status}`}><span></span>{status}</div>
  <button class="secondary" type="button" disabled={busy} onclick={onPreflight}>
    Check iPhone
  </button>
  <button class="primary" type="button" disabled={busy} onclick={onStart}>
    {#if busy}<span class="spinner"></span>{/if}
    {busy ? "Capturing…" : "Run verified demo"}
  </button>
</header>

<style>
  .toolbar {
    height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--panel) 96%, black);
    -webkit-app-region: drag;
  }
  button { -webkit-app-region: no-drag; }
  .brand { display: flex; align-items: center; gap: 9px; min-width: 174px; }
  .brand strong, .brand small, .device-pill strong, .device-pill small { display: block; }
  .brand strong { color: var(--text-strong); font-size: 14px; line-height: 16px; }
  .brand small { color: var(--muted); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
  .brand-mark { width: 25px; height: 25px; border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--border)); border-radius: 7px; display: flex; align-items: end; justify-content: center; gap: 2px; padding: 5px; background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .brand-mark span { width: 3px; border-radius: 2px; background: var(--accent); }
  .brand-mark span:nth-child(1) { height: 7px; opacity: .55; }
  .brand-mark span:nth-child(2) { height: 13px; }
  .brand-mark span:nth-child(3) { height: 10px; opacity: .75; }
  .device-pill { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel-2); min-width: 130px; }
  .device-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 3px color-mix(in srgb, var(--muted) 12%, transparent); }
  .connected .device-dot { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 13%, transparent); }
  .device-pill small { color: var(--muted); font-size: 8px; letter-spacing: .08em; }
  .device-pill strong { color: var(--text); font-size: 11px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toolbar-spacer { flex: 1; }
  .status { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
  .status span { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .status-capturing { color: var(--warning); }
  .status-ready { color: var(--success); }
  .status-error { color: var(--danger); }
  button { height: 32px; border-radius: 6px; padding: 0 12px; font: inherit; font-size: 11px; font-weight: 650; border: 1px solid var(--border); color: var(--text); background: var(--panel-2); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--text-strong); }
  button:disabled { opacity: .55; cursor: default; }
  .primary { border-color: color-mix(in srgb, var(--accent) 65%, var(--border)); background: var(--accent); color: #06131c; }
  .primary:hover:not(:disabled) { color: #06131c; filter: brightness(1.08); }
  .spinner { width: 10px; height: 10px; display: inline-block; margin-right: 6px; border: 1.5px solid #06131c55; border-top-color: #06131c; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -1px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
