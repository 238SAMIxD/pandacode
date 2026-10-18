import type { Provider } from './types';
import { teamActive, type TeamSnapshot, type TeamWorker } from './architect-types';
import { icon } from './dom';
import { providerLogo } from './provider-logos';
import { fallbackModel } from './model-catalog';

const pending = (worker: TeamWorker): boolean => !worker.abandoned && ['running', 'waiting', 'queued'].includes(worker.status);
const workerLabels: Record<TeamWorker['status'], string> = {
  running: 'Working', waiting: 'Needs attention', queued: 'Queued', completed: 'Completed', failed: 'Failed', stopped: 'Stopped',
};

function heading(team: TeamSnapshot): string {
  if (team.status === 'completed') return 'Team complete';
  if (team.status === 'paused') return 'Team paused';
  if (team.status === 'interrupted') return 'Team interrupted';
  if (team.status === 'failed') return 'Team needs attention';
  const working = team.workers.filter(worker => !worker.abandoned && worker.status === 'running').length;
  if (working) return `${working} ${working === 1 ? 'worker' : 'workers'} working`;
  if (team.workers.some(worker => !worker.abandoned && worker.status === 'waiting')) return 'Workers need attention';
  if (team.workers.some(worker => !worker.abandoned && worker.status === 'queued')) return 'Workers queued';
  return 'Architect reviewing';
}

function text(root: Element, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector)!;
  if (element.textContent !== value) element.textContent = value;
}

/** Small, event-driven summary. Worker transcripts and saved diffs stay on demand. */
export function updateTeamProgress(host: HTMLElement, team: TeamSnapshot | null | undefined, providers: Provider[]): boolean {
  const visible = Boolean(team?.workers.length);
  host.hidden = !visible;
  if (!team || !visible) { host.replaceChildren(); return false; }
  let card = host.querySelector<HTMLElement>('.team-progress');
  if (!card || card.dataset.sessionId !== team.sessionId) {
    card = document.createElement('section');
    card.className = 'team-progress'; card.setAttribute('aria-label', 'Team progress');
    card.dataset.sessionId = team.sessionId;
    card.innerHTML = `<div class="team-progress-heading"><span class="team-progress-indicator" aria-hidden="true"></span><strong role="status"></strong><button type="button" data-action="open-team-progress">View workers${icon('chevron')}</button></div><div class="team-progress-list"></div><p class="team-progress-more" hidden></p>`;
    host.replaceChildren(card);
  }
  card.dataset.status = team.status;
  text(card, '.team-progress-heading strong', heading(team));
  // Keep active assignments visible and bound the card, even over a long run.
  const active = team.workers.filter(worker => pending(worker) && worker.status !== 'queued');
  const queued = team.workers.filter(worker => pending(worker) && worker.status === 'queued');
  const settled = team.workers.filter(worker => !pending(worker)).slice().reverse();
  const visibleIds = new Set([...active, ...queued, ...settled].slice(0, 6).map(worker => worker.id));
  const workers = team.workers.filter(worker => visibleIds.has(worker.id));
  const list = card.querySelector<HTMLElement>('.team-progress-list')!;
  const rows = new Map([...list.querySelectorAll<HTMLButtonElement>('.team-progress-worker')].map(row => [row.dataset.workerId!, row]));
  for (const [id, row] of rows) if (!visibleIds.has(id)) row.remove();
  workers.forEach((worker, index) => {
    let row = rows.get(worker.id);
    if (!row) {
      row = document.createElement('button'); row.type = 'button'; row.className = 'team-progress-worker';
      row.dataset.action = 'open-team-worker'; row.dataset.workerId = worker.id;
      row.innerHTML = `<span class="team-progress-logo"></span><span class="team-progress-description"><strong></strong><small></small></span><span class="team-progress-status"></span>${icon('chevron')}`;
    }
    if (row !== list.children[index]) list.insertBefore(row, list.children[index] ?? null);
    const profile = team.config.workers.find(profile => profile.id === worker.profileId);
    const provider = providers.find(provider => provider.id === worker.provider);
    const model = provider?.models.find(model => model.id === worker.model)?.name ?? fallbackModel(worker.provider, worker.model).name;
    const role = profile?.name !== worker.name ? profile?.name : '';
    const status = worker.abandoned ? 'Skipped' : !teamActive(team) && pending(worker) ? 'Paused' : workerLabels[worker.status];
    text(row, '.team-progress-description strong', worker.name);
    text(row, '.team-progress-description small', [role, provider?.name ?? worker.provider, model].filter(Boolean).join(' · '));
    text(row, '.team-progress-status', status);
    row.dataset.status = status;
    row.title = worker.assignment;
    if (row.dataset.provider !== worker.provider) {
      row.querySelector('.team-progress-logo')!.innerHTML = providerLogo(worker.provider);
      row.dataset.provider = worker.provider;
    }
  });
  const more = card.querySelector<HTMLElement>('.team-progress-more')!;
  const remaining = team.workers.length - workers.length;
  more.hidden = remaining === 0;
  text(card, '.team-progress-more', remaining ? `${remaining} more in View workers` : '');
  return true;
}
