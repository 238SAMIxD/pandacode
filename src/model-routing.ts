/* Settings → Agents → Model routing: Panda Router picks each worker's model for a task. */
import './model-routing.css';
import { escape } from './dom';
import { trackSegment } from './motion';
import { installedCatalog } from './team-catalog';
import { infoMark } from './tooltip';
import type { ProviderId, ProviderModel } from './types';

export type RoutingMode = 'balanced' | 'cheapest' | 'quality';
export interface RoutingStatus { enabled: boolean; mode: RoutingMode; minP: number; profiler: 'ready' | 'missing' | 'downloading' | 'failed' | 'unavailable'; error: string | null }
export interface RoutedModel { provider: ProviderId; model: string; name: string; cardId: string; pSuccess: number; estCostUsd: number; estLatencyMs: number }
export interface RouteResult { pick: RoutedModel | null; ranking: RoutedModel[]; unrated: { provider: ProviderId; model: string; name: string }[]; difficulty: number; category: string; profiler: 'onnx' | 'heuristic'; latencyMs: number }

export interface ModelRoutingOptions {
  providers: { id: ProviderId; name: string; installed: boolean; models: ProviderModel[] }[];
  loadModels(provider: ProviderId): Promise<ProviderModel[]>;
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const MODES: [RoutingMode, string][] = [['cheapest', 'Cheap'], ['balanced', 'Balanced'], ['quality', 'Best']];
const MIN_P = 30, MAX_P = 90, DEFAULT_P = 50;
const HELP = 'Panda Router runs locally. For each worker it predicts which of your installed models is likely to succeed and picks one by your mode. Balanced weighs success against cost; Cheap takes the lowest cost above the minimum chance of success and moves up only if review fails; Best takes the likeliest to succeed. The Team button in the prompt box sets the same mode. The first use downloads a 35 MB profiler from GitHub.';
const money = (usd: number) => usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
const percent = (p: number) => `${Math.round(p * 100)}%`;

export function mountModelRouting(host: HTMLElement, options: ModelRoutingOptions): () => void {
  host.innerHTML = `<div class="settings-group model-routing">
    <div class="setting-row"><div><strong>Model routing ${infoMark(HELP, 'About model routing')}</strong></div></div>
    <div class="setting-row"><div><strong>Pick worker models with Panda Router</strong></div><input type="checkbox" class="settings-switch routing-enabled" aria-label="Pick worker models with Panda Router"></div>
    <div class="setting-row"><div><strong>Mode</strong></div><div class="routing-modes" role="radiogroup" aria-label="Routing mode">${MODES.map(([id, label]) => `<button type="button" role="radio" aria-checked="false" tabindex="-1" data-mode="${id}">${label}</button>`).join('')}</div></div>
    <div class="setting-row routing-minp-row" hidden><div><strong>Minimum chance of success</strong></div><input type="number" class="routing-minp" aria-label="Minimum chance of success in percent" min="${MIN_P}" max="${MAX_P}" step="1"></div>
    <div class="setting-row"><div><strong>Profiler</strong><small class="routing-status" role="status"></small></div><button type="button" class="secondary-button routing-prepare" hidden></button></div>
    <div class="routing-try"><p class="routing-off" hidden>Routing is off. Turn it on to try it.</p><textarea class="routing-text" aria-label="Task to route" rows="3" spellcheck="false" placeholder="Describe a task to see which model Panda Router would pick."></textarea>
      <div class="routing-try-actions"><button type="button" class="secondary-button routing-route">Route</button></div>
      <div class="routing-result" role="status" aria-live="polite" hidden></div></div>
  </div>`;
  const $ = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const enabled = $<HTMLInputElement>('.routing-enabled'), minP = $<HTMLInputElement>('.routing-minp'), minRow = $('.routing-minp-row');
  const statusText = $('.routing-status'), prepare = $<HTMLButtonElement>('.routing-prepare');
  const text = $<HTMLTextAreaElement>('.routing-text'), routeButton = $<HTMLButtonElement>('.routing-route'), result = $('.routing-result');
  const modes = $('.routing-modes'), off = $('.routing-off');
  let disposed = false, status: RoutingStatus | null = null, polling = 0, latest = 0, writing = 0;
  // Only the reply to the newest request renders, so an older one never undoes a later change; a read
  // (status poll) also yields to a change still in flight, and a replaced request's failure stays quiet.
  const request = (command: string, args?: Record<string, unknown>, write = false) => {
    const ticket = write ? ++latest : latest;
    if (write) writing++;
    return options.call<RoutingStatus>(command, args).then(
      next => { if (!disposed && ticket === latest && (write || !writing)) render(next); },
      cause => { if (ticket === latest) throw cause; },
    ).finally(() => { if (write) writing--; });
  };
  // A download started elsewhere (a team turning on) finishes on its own; follow it.
  const poll = () => {
    if (polling || disposed) return;
    polling = window.setTimeout(() => {
      polling = 0;
      request('model_routing_status').catch(() => { if (!disposed) poll(); });
    }, 1000);
  };

  const render = (next: RoutingStatus) => {
    status = next;
    // The composer's Team button follows every status shown here.
    window.dispatchEvent(new CustomEvent('pandacode:routing', { detail: next }));
    enabled.checked = next.enabled;
    modes.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      const on = b.dataset.mode === next.mode;
      b.setAttribute('aria-checked', String(on)); b.classList.toggle('selected', on); b.tabIndex = on ? 0 : -1;
    });
    trackSegment(modes, modes.querySelector<HTMLElement>('.selected'));
    minRow.hidden = next.mode !== 'cheapest';
    if (document.activeElement !== minP) minP.value = String(Math.round(next.minP * 100));
    off.hidden = next.enabled; text.disabled = routeButton.disabled = !next.enabled;
    if (next.profiler === 'downloading') poll();
    statusText.textContent = { ready: 'Ready', downloading: 'Downloading…', missing: 'Not downloaded', failed: `Failed: ${next.error ?? 'unknown error'}`, unavailable: `Keyword heuristic: ${next.error ?? 'the profiler cannot run here'}` }[next.profiler];
    prepare.hidden = next.profiler === 'ready' || next.profiler === 'downloading' || next.profiler === 'unavailable';
    prepare.textContent = next.profiler === 'failed' ? 'Retry' : 'Download';
  };
  const fail = (cause: unknown) => { if (!disposed) { result.hidden = false; result.textContent = cause instanceof Error ? cause.message : String(cause); } };
  const configure = (patch: Record<string, unknown>) => request('model_routing_configure', patch, true).catch(fail);

  enabled.addEventListener('change', () => void configure({ enabled: enabled.checked }));
  modes.addEventListener('click', event => {
    const mode = (event.target as Element).closest<HTMLElement>('[data-mode]')?.dataset.mode;
    if (mode) void configure({ mode });
  });
  modes.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const buttons = [...modes.querySelectorAll<HTMLButtonElement>('button')];
    const next = buttons[(buttons.findIndex(b => b.classList.contains('selected')) + step + buttons.length) % buttons.length];
    next.focus(); void configure({ mode: next.dataset.mode });
  });
  minP.addEventListener('change', () => {
    const value = Math.min(MAX_P, Math.max(MIN_P, Math.round(Number(minP.value)) || DEFAULT_P));
    minP.value = String(value);
    void configure({ minP: value / 100 });
  });
  prepare.addEventListener('click', () => {
    prepare.disabled = true;
    if (status) render({ ...status, profiler: 'downloading', error: null });
    request('model_routing_prepare').catch(fail).finally(() => { prepare.disabled = false; });
  });
  routeButton.addEventListener('click', async () => {
    const task = text.value.trim();
    if (!task || routeButton.disabled) return;
    routeButton.disabled = true; result.hidden = false; result.textContent = 'Routing…';
    try {
      const { catalog: pool } = await installedCatalog(options.providers, options.loadModels);
      const route = await options.call<RouteResult>('model_routing_route', { text: task, pool });
      if (disposed) return;
      const row = (m: RoutedModel, label: string) => `<li><span class="routing-label">${label}</span><span class="routing-name">${escape(m.name)}</span><span>${percent(m.pSuccess)}</span><span>${money(m.estCostUsd)}</span></li>`;
      const alternatives = route.ranking.filter(m => !route.pick || m.cardId !== route.pick.cardId).slice(0, 4);
      result.innerHTML = `<p class="routing-summary">Difficulty ${route.difficulty}/10 · ${escape(route.category)} · ${route.profiler === 'onnx' ? 'ONNX profiler' : 'keyword heuristic'} · ${Math.round(route.latencyMs)} ms</p>`
        + (route.pick ? `<ul class="routing-ranking" aria-label="Routed models">${row(route.pick, 'Pick')}${alternatives.map(m => row(m, 'Also')).join('')}</ul>` : '<p>No rated model fits. The lead will choose.</p>');
    } catch (cause) { fail(cause); }
    finally { routeButton.disabled = !status?.enabled; }
  });

  void request('model_routing_status').catch(fail);
  return () => { disposed = true; clearTimeout(polling); };
}
