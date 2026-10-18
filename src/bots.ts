import './bots.css';
import './bots-page.css';
import { escape, icon } from './dom';
import { trackSegment } from './motion';
import { providerLogo } from './provider-logos';
import { infoMark } from './tooltip';
import type { Provider, ProviderId } from './types';
import { connectInput, guideToggled } from './bots-connect';
import { mountChat, type ChatView, type LiveTurn } from './bots-chat';
import { renderPanel, panelClick, panelSubmit, panelChange, invalidateActivity, type PanelContext, type Tab } from './bots-panels';

export interface Bot {
  id: string; name: string; role: string; instructions: string; goals: string; avatar: string; projectId: string;
  provider: ProviderId; model: string; mode: string; heartbeatMinutes: number; nextHeartbeatAt: number | null;
  paused: boolean; memoryVersion: number; notifyChannelId: string | null; notifyThread: string | null; createdAt: number; updatedAt: number;
  /** The bot's conversation in this app, once it exists. */
  desktopSession?: string | null;
}
export interface BotInput { name: string; role: string; instructions: string; goals: string; avatar: string; provider: ProviderId; model: string; mode: string; heartbeatMinutes: number; }
export interface Memory { id: string; content: string; source: 'user' | 'bot'; createdAt: number; }
export interface Schedule { id: string; botId: string; title: string; prompt: string; kind: 'once' | 'interval' | 'daily' | 'weekdays'; intervalMinutes: number | null; timeOfDay: string | null; nextRunAt: number | null; lastRunAt: number | null; enabled: boolean; createdBy: 'user' | 'bot'; createdAt: number; }
export type ChannelKind = 'web' | 'telegram' | 'slack' | 'discord' | 'whatsapp';
export interface Channel { id: string; botId: string; kind: ChannelKind; label: string; config: Record<string, unknown>; enabled: boolean; status: string; secrets: string[]; }
export interface Pairing { channelId: string; senderId: string; senderName: string; status: 'pending' | 'approved' | 'blocked'; code: string; createdAt: number; }
export interface Thread { channelId: string; externalId: string; sessionId: string; updatedAt: number; }
export interface Rule { id: string; pattern: string; decision: 'allow' | 'ask' | 'deny'; createdAt: number; }
export interface Activity { id: number; kind: string; summary: string; detail: Record<string, unknown>; at: number; }
export interface BotDetail { bot: Bot; memories: Memory[]; schedules: Schedule[]; channels: Channel[]; pairings: Pairing[]; threads: Thread[]; rules: Rule[]; serverPort: number; }

export interface BotsOptions {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  providers: Provider[];
  defaultModel(provider: ProviderId): string;
  /** True while a task's agent is working. */
  running(sessionId: string): boolean;
  openTask(sessionId: string): void;
  notify(text: string): void;
  live(sessionId: string): LiveTurn | null;
  approve(sessionId: string, requestId: string, approved: boolean): Promise<void>;
  /** Open on this bot, or on the New bot form. */
  initialBot?: string;
  startNew?: boolean;
  /** `page`: one bot's chat filling the workspace, with settings in a side panel. */
  layout?: 'window' | 'page';
  /** Page layout: the bot was deleted, so the page should go away. */
  onDeleted?(): void;
}
export interface BotsView { dispose(): void; refresh(): void; agent(sessionId: string, kind: string): void; }

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Chat' }, { id: 'memory', label: 'Memory' }, { id: 'schedules', label: 'Schedules' },
  { id: 'channels', label: 'Channels' }, { id: 'rules', label: 'Rules' }, { id: 'activity', label: 'Activity' },
];
const MODES = [{ id: 'ask', label: 'Ask before acting' }, { id: 'auto', label: 'Auto-approve edits' }, { id: 'plan', label: 'Plan only' }, { id: 'full', label: 'Full access' }];
const CHECK_INS = [{ minutes: 0, label: 'Off' }, { minutes: 30, label: 'Every 30 minutes' }, { minutes: 60, label: 'Every hour' }, { minutes: 180, label: 'Every 3 hours' }, { minutes: 360, label: 'Every 6 hours' }, { minutes: 1440, label: 'Once a day' }];

/** Starting points, in the spirit of the named bots this feature follows. */
export const TEMPLATES: { id: string; avatar: string; name: string; role: string; instructions: string; goals: string; heartbeatMinutes: number }[] = [
  { id: 'chief', avatar: '🧭', name: 'Chief of Staff', role: 'Keeps my week on track', instructions: 'Track my commitments and follow-ups. Summarize what changed since we last talked. Ask before sending anything on my behalf.', goals: 'Nothing I promised slips.\nI start each day knowing my top three priorities.', heartbeatMinutes: 360 },
  { id: 'research', avatar: '🔭', name: 'Researcher', role: 'Digs into questions and reports back', instructions: 'Research thoroughly using the web and local files. Cite sources with links. Lead with the answer, then the evidence.', goals: '', heartbeatMinutes: 0 },
  { id: 'oncall', avatar: '🛟', name: 'Dev On-call', role: 'Watches my projects and fixes small things', instructions: 'Work in this workspace. Before changing code, explain the plan. Run tests before saying something works.', goals: 'Keep the build green.\nTell me about failing tests or broken dependencies early.', heartbeatMinutes: 180 },
  { id: 'inbox', avatar: '📬', name: 'Inbox Triage', role: 'Sorts what needs me from what does not', instructions: 'When I forward messages or notifications, sort them into: needs me today, can wait, ignore. Draft short replies for the first group but never send them yourself.', goals: 'I only look at what actually needs me.', heartbeatMinutes: 0 },
  { id: 'watch', avatar: '📈', name: 'Watcher', role: 'Keeps an eye on things and tells me when they change', instructions: 'Check the sources I give you. Only message me when something meaningfully changed, with the before and after and a link.', goals: '', heartbeatMinutes: 60 },
  { id: 'blank', avatar: '✨', name: '', role: '', instructions: '', goals: '', heartbeatMinutes: 0 },
];

export function age(at: number | null, now = Date.now()): string {
  if (!at) return '';
  const minutes = Math.round((at - now) / 60000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  if (Math.abs(minutes) < 1) return at > now ? 'in a moment' : 'just now';
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / 1440), 'day');
}
export function avatar(bot: Pick<Bot, 'avatar' | 'name'>, cls = ''): string {
  const glyph = bot.avatar.trim() || bot.name.trim().slice(0, 1).toUpperCase() || '·';
  return `<span class="bot-avatar ${cls}" aria-hidden="true">${escape(glyph)}</span>`;
}

export function mountBots(host: HTMLElement, options: BotsOptions): BotsView {
  let bots: Bot[] = [];
  let detail: BotDetail | null = null;
  let selected = options.initialBot ?? '';
  let tab: Tab = 'chat';
  let editing: 'new' | 'edit' | null = options.startNew ? 'new' : null;
  let template = TEMPLATES[0];
  let confirming: { title: string; text: string; button: string; action: () => Promise<void> } | null = null;
  let loading = true, busy = false, disposed = false, request = 0;
  let error = '';
  let chat: { view: ChatView; key: string; host: HTMLElement } | null = null;
  // The chat remounts only when something it shows changes: the bot, pause, or its composer chips.
  const chatKey = (bot: Bot) => [bot.id, bot.paused, bot.provider, bot.model, bot.mode, bot.heartbeatMinutes].join('|');
  const desktopThread = () => detail?.threads.find(thread => thread.channelId === 'desktop')?.sessionId ?? null;
  const installed = () => options.providers.filter(provider => provider.installed);
  const page = options.layout === 'page';
  // Page layout: settings tab and whether the side panel is open survive re-renders and reloads.
  let settingsTab: Tab | 'profile' = 'memory';
  let moreOpen = false;
  let settingsOpen = (() => { try { return localStorage.getItem('pandacode.botSettings') !== 'closed'; } catch { return true; } })();
  host.classList.add('bots');
  host.classList.toggle('bots-page', page);
  host.innerHTML = page
    ? '<section class="bots-detail bots-page-detail"><div class="bots-page-body"><div class="bots-page-chat"><div class="bots-page-top"></div><div class="bots-chat-host"></div></div><aside class="bots-page-settings" aria-label="Bot settings"></aside></div></section>'
    : '<aside class="bots-list" aria-label="Bots"></aside><section class="bots-detail" aria-live="polite"></section>';
  const list = host.querySelector<HTMLElement>('.bots-list');
  const pane = host.querySelector<HTMLElement>('.bots-detail')!;

  const context: PanelContext = {
    call: options.call, notify: options.notify, openTask: id => options.openTask(id), running: options.running,
    detail: () => detail, reload: () => load(), rerender: () => render(),
    work: action => work(action),
    confirm: (title, text, button, action) => { confirming = { title, text, button, action }; render(); pane.querySelector<HTMLButtonElement>('.bots-confirm .secondary-button')?.focus(); },
  };

  async function load(): Promise<void> {
    const id = ++request;
    invalidateActivity();
    try {
      const next = await options.call<Bot[]>('bots_list');
      if (disposed || id !== request) return;
      bots = next;
      if (!bots.some(bot => bot.id === selected)) selected = bots[0]?.id ?? '';
      detail = selected ? await options.call<BotDetail>('bot_detail', { botId: selected }) : null;
      if (disposed || id !== request) return;
      if (!bots.length && editing !== 'edit') editing ??= 'new';
      // A background refresh keeps a message the user has not acted on yet; the next action clears it.
    } catch (cause) { error = message(cause); }
    loading = false;
    render();
  }
  async function work(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return;
    busy = true; error = ''; host.setAttribute('aria-busy', 'true');
    try { await action(); } catch (cause) { error = message(cause); render(); } finally { busy = false; host.removeAttribute('aria-busy'); }
  }
  function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
  function working(bot: Bot): boolean { return bot.id === detail?.bot.id && detail.threads.some(thread => options.running(thread.sessionId)); }

  function renderList(): void {
    if (!list) return;
    const rows = bots.map(bot => `<button type="button" class="bots-row" data-bot="${escape(bot.id)}" aria-current="${bot.id === selected && editing !== 'new'}">${avatar(bot)}<span class="bots-row-text"><b>${escape(bot.name)}</b><small>${escape(bot.paused ? 'Paused' : working(bot) ? 'Working…' : bot.role || 'Ready')}</small></span>${bot.paused ? `<span class="bots-dot paused" title="Paused"></span>` : working(bot) ? '<span class="bots-dot working" title="Working"></span>' : ''}</button>`).join('');
    list.innerHTML = `<div class="bots-list-head"><span>Bots</span><button type="button" class="icon-button" data-bots-action="new" aria-label="New bot" title="New bot">${icon('plus')}</button></div><div class="bots-rows">${rows || '<p class="bots-empty-note">No bots yet.</p>'}</div>`;
  }

  function renderForm(bot: Bot | null): string {
    const source = bot ?? { ...template, provider: (installed()[0]?.id ?? 'claude') as ProviderId, model: '', mode: 'ask' };
    const providers = installed().length ? installed() : options.providers;
    const provider = providers.find(item => item.id === source.provider) ?? providers[0];
    const model = source.model || (provider ? options.defaultModel(provider.id) : '');
    const models = provider?.models ?? [];
    const templates = bot ? '' : `<div class="bots-templates" role="group" aria-label="Start from">${TEMPLATES.map(item => `<button type="button" data-template="${item.id}" aria-pressed="${item.id === template.id}"><span aria-hidden="true">${item.avatar}</span>${escape(item.name || 'Blank')}</button>`).join('')}</div>`;
    return `<form class="bots-form" novalidate>
      ${bot ? '' : '<h3>New bot</h3><p class="bots-lede">A bot is an agent that lives on this computer. It remembers, works on a schedule, and answers you here, in a browser, or in Telegram, Slack, Discord and WhatsApp.</p>'}
      ${templates}
      <div class="bots-grid"><label class="bots-field bots-avatar-field"><span>Icon</span><input name="avatar" maxlength="4" value="${escape(source.avatar)}" aria-label="Icon" autocomplete="off"></label>
      <label class="bots-field"><span>Name</span><input name="name" maxlength="60" required value="${escape(source.name)}" placeholder="Scout" autocomplete="off"></label></div>
      <label class="bots-field"><span>Job</span><input name="role" maxlength="200" value="${escape(source.role)}" placeholder="What it's for, in a few words" autocomplete="off"></label>
      <label class="bots-field"><span>Instructions</span><textarea name="instructions" rows="4" maxlength="16000" placeholder="How it should work, what to always or never do">${escape(source.instructions)}</textarea></label>
      <label class="bots-field"><span>Standing goals</span><textarea name="goals" rows="3" maxlength="16000" placeholder="One per line. Check-ins work toward these.">${escape(source.goals)}</textarea></label>
      <div class="bots-grid three"><label class="bots-field"><span>Harness</span><select name="provider">${providers.map(item => `<option value="${item.id}" ${item.id === provider?.id ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select></label>
      <label class="bots-field"><span>Model</span><select name="model">${models.length ? models.map(item => `<option value="${escape(item.id)}" ${item.id === model ? 'selected' : ''}>${escape(item.name)}</option>`).join('') : `<option value="${escape(model)}">${escape(model || 'Default')}</option>`}</select></label>
      <label class="bots-field"><span>Permissions</span><select name="mode">${MODES.map(item => `<option value="${item.id}" ${item.id === source.mode ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label></div>
      <label class="bots-field"><span>Check-ins ${infoMark('On each check-in the bot reviews its goals and memory using read-only steps, and messages you only when something needs attention.', 'About check-ins')}</span><select name="heartbeatMinutes">${CHECK_INS.map(item => `<option value="${item.minutes}" ${item.minutes === source.heartbeatMinutes ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label>
      <div class="dialog-footer">${bots.length ? '<button type="button" class="secondary-button" data-bots-action="cancel-edit">Cancel</button>' : ''}<button type="submit" class="primary-button">${bot ? 'Save' : 'Create bot'}</button></div>
    </form>`;
  }

  function readForm(form: HTMLFormElement): BotInput {
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    return { name: text('name'), role: text('role'), instructions: text('instructions'), goals: text('goals'), avatar: text('avatar'), provider: text('provider') as ProviderId, model: text('model'), mode: text('mode'), heartbeatMinutes: Number(text('heartbeatMinutes')) || 0 };
  }

  /** Page layout: one toolbar row. Identity and live state on the left, everyday actions on the
   * right, and the rare destructive ones one level down in More. */
  function renderPageHeader(bot: Bot): string {
    const harness = options.providers.find(item => item.id === bot.provider);
    const live = working(bot);
    const state = bot.paused ? 'Paused' : live ? 'Working' : 'Ready';
    const next = bot.heartbeatMinutes && bot.nextHeartbeatAt && !bot.paused ? `check-in ${age(bot.nextHeartbeatAt)}` : '';
    const meta = [bot.role, harness?.name, next].filter(Boolean).map(item => escape(item!)).join('<i aria-hidden="true">·</i>');
    return `<header class="bp-bar ${live ? 'is-working' : ''} ${bot.paused ? 'is-paused' : ''}"><span class="bots-ring bp-ring">${avatar(bot)}</span>
      <div class="bp-id"><div class="bp-name-row"><h3 class="bp-name">${escape(bot.name)}</h3><span class="bp-state" data-state="${state.toLowerCase()}">${state}</span></div><p class="bp-meta">${meta}</p></div>
      <div class="bp-actions">
        <button type="button" class="icon-button" data-bots-action="pause" aria-label="${bot.paused ? 'Resume' : 'Pause'}" title="${bot.paused ? 'Resume: schedules, check-ins and channels continue' : 'Pause: stop work and hold schedules and messages'}" aria-pressed="${bot.paused}">${icon(bot.paused ? 'play' : 'pause')}</button>
        <button type="button" class="icon-button" data-bots-action="edit" aria-label="Edit bot" title="Name, instructions, goals, model and check-ins" aria-pressed="${settingsOpen && settingsTab === 'profile'}">${icon('edit')}</button>
        <button type="button" class="icon-button" data-bots-action="toggle-settings" aria-label="Settings" title="Memory, schedules, channels and rules" aria-pressed="${settingsOpen && settingsTab !== 'profile'}" aria-controls="bot-page-settings">${icon('panel')}</button>
        <span class="bp-more"><button type="button" class="icon-button" data-bots-action="more" aria-label="More" title="More" aria-haspopup="menu" aria-expanded="${moreOpen}">${icon('more')}</button>
        ${moreOpen ? `<span class="bp-menu" role="menu"><button type="button" role="menuitem" data-bots-action="reset" aria-label="Reset bot">${icon('reset')}Reset…<small>Forget conversations, memories and schedules</small></button><button type="button" role="menuitem" class="danger" data-bots-action="delete" aria-label="Delete bot">${icon('trash')}Delete…<small>Remove the bot and its channels</small></button></span>` : ''}</span>
      </div></header>`;
  }
  function renderHeader(bot: Bot): string {
    const harness = options.providers.find(item => item.id === bot.provider);
    const meta = [harness ? `${providerLogo(bot.provider)}<span>${escape(harness.name)}</span>` : '', bot.heartbeatMinutes ? `<span>${icon('refresh')}Check-ins ${escape(CHECK_INS.find(item => item.minutes === bot.heartbeatMinutes)?.label.toLowerCase() ?? `every ${bot.heartbeatMinutes} min`)}</span>` : ''].filter(Boolean).join('');
    const live = working(bot);
    const online = detail!.channels.filter(channel => channel.enabled).length;
    const stats = [
      [String(detail!.memories.length), detail!.memories.length === 1 ? 'memory' : 'memories'],
      [String(detail!.schedules.filter(item => item.enabled).length), 'schedules'],
      [String(online), online === 1 ? 'channel' : 'channels'],
      ...(bot.nextHeartbeatAt && bot.heartbeatMinutes && !bot.paused ? [[age(bot.nextHeartbeatAt).replace(/^in /, ''), 'to check-in']] : []),
    ].map(([value, label]) => `<span><b>${escape(value)}</b>${escape(label)}</span>`).join('');
    return `<header class="bots-head ${live ? 'is-working' : ''} ${bot.paused ? 'is-paused' : ''}"><span class="bots-ring">${avatar(bot, 'large')}</span><div class="bots-title"><h3>${escape(bot.name)}</h3><p>${escape(bot.role || 'No job description yet')}</p><div class="bots-meta">${meta}</div></div><div class="bots-stats" aria-label="At a glance">${stats}</div>
      <div class="bots-head-actions"><button type="button" class="secondary-button" data-bots-action="pause" aria-pressed="${bot.paused}">${icon(bot.paused ? 'play' : 'stop')}<span>${bot.paused ? 'Resume' : 'Pause'}</span></button>
      ${page ? `<button type="button" class="icon-button" data-bots-action="edit" aria-label="Edit bot" title="Name, instructions, goals, model and check-ins" aria-pressed="${settingsOpen && settingsTab === 'profile'}">${icon('edit')}</button><button type="button" class="icon-button" data-bots-action="toggle-settings" aria-label="Settings" title="Memory, schedules, channels and rules" aria-pressed="${settingsOpen && settingsTab !== 'profile'}" aria-controls="bot-page-settings">${icon('panel')}</button>` : `<button type="button" class="icon-button" data-bots-action="edit" aria-label="Edit bot" title="Edit bot">${icon('edit')}</button>`}
      <button type="button" class="icon-button" data-bots-action="reset" aria-label="Reset bot" title="Reset: forget conversations, memories and schedules">${icon('reset')}</button>
      <button type="button" class="icon-button" data-bots-action="delete" aria-label="Delete bot" title="Delete bot">${icon('trash')}</button></div></header>
      ${bot.paused ? '<p class="bots-banner">Paused. Schedules, check-ins and channel messages wait until you resume.</p>' : ''}`;
  }

  /** The composer's chips: what the bot runs on, its permissions and check-ins. Each opens the profile. */
  function chatToolbar(): string {
    const bot = detail?.bot;
    if (!bot) return '';
    const harness = options.providers.find(item => item.id === bot.provider);
    const model = harness?.models.find(item => item.id === bot.model)?.name || bot.model || (harness ? `${harness.name} default` : 'Default model');
    const mode = MODES.find(item => item.id === bot.mode)?.label ?? bot.mode;
    const checkIn = CHECK_INS.find(item => item.minutes === bot.heartbeatMinutes)?.label ?? `Every ${bot.heartbeatMinutes} min`;
    const chip = (focus: string, title: string, body: string) => `<button type="button" class="bots-chip-button" data-bots-action="edit" data-focus="${focus}" title="${escape(title)}">${body}</button>`;
    return [
      chip('provider', 'Harness and model', `<span class="provider-small">${providerLogo(bot.provider)}</span><span class="bots-chip-text">${escape(model)}</span>`),
      '<span class="composer-separator" aria-hidden="true"></span>',
      chip('mode', 'Permissions', `${icon('unlock')}<span class="bots-chip-text">${escape(mode)}</span>`),
      bot.heartbeatMinutes ? chip('heartbeatMinutes', 'Check-ins', `${icon('refresh')}<span class="bots-chip-text">${escape(checkIn)}</span>`) : '',
    ].join('');
  }

  function render(): void {
    if (disposed) return;
    if (page) { renderPage(); return; }
    renderList();
    const confirm = confirming ? `<div class="bots-confirm" role="alertdialog" aria-label="${escape(confirming.title)}"><b>${escape(confirming.title)}</b><p>${escape(confirming.text)}</p><div class="dialog-footer"><button type="button" class="secondary-button" data-bots-action="confirm-cancel">Cancel</button><button type="button" class="primary-button danger" data-bots-action="confirm-run">${escape(confirming.button)}</button></div></div>` : '';
    const alert = error ? `<p class="bots-error" role="alert">${escape(error)}</p>` : '';
    if (loading) { pane.innerHTML = '<p class="dialog-loading" role="status">Loading bots…</p>'; return; }
    if (editing === 'new' || !detail) { pane.innerHTML = alert + renderForm(null); return; }
    if (editing === 'edit') { pane.innerHTML = `${renderHeader(detail.bot)}${alert}${renderForm(detail.bot)}`; return; }
    const tabs = `<div class="bots-tabs" role="tablist" aria-label="Bot sections">${TABS.map(item => `<button type="button" role="tab" data-tab="${item.id}" aria-selected="${item.id === tab}">${item.label}${badge(item.id)}</button>`).join('')}</div>`;
    pane.innerHTML = `${renderHeader(detail.bot)}${confirm}${alert}${tabs}<div class="bots-panel" role="tabpanel" aria-label="${escape(TABS.find(item => item.id === tab)!.label)}">${renderPanel(tab, detail, context)}</div>`;
    const group = pane.querySelector<HTMLElement>('.bots-tabs');
    if (group) trackSegment(group, group.querySelector<HTMLElement>('[aria-selected="true"]'));
    mountChatIfShown();
  }
  const side = () => pane.querySelector<HTMLElement>('.bots-page-settings');
  const SETTINGS: { id: Tab | 'profile'; label: string }[] = [
    { id: 'memory', label: 'Memory' }, { id: 'schedules', label: 'Schedules' }, { id: 'channels', label: 'Channels' },
    { id: 'rules', label: 'Rules' }, { id: 'activity', label: 'Activity' },
  ];
  const settingsLabel = (id: Tab | 'profile') => id === 'profile' ? 'Profile' : SETTINGS.find(item => item.id === id)!.label;
  /** Page layout: the header and settings refresh; the chat stays mounted so typing and scroll are never lost. */
  function renderPage(): void {
    const top = pane.querySelector<HTMLElement>('.bots-page-top')!;
    const side = pane.querySelector<HTMLElement>('.bots-page-settings')!;
    const confirm = confirming ? `<div class="bots-confirm" role="alertdialog" aria-label="${escape(confirming.title)}"><b>${escape(confirming.title)}</b><p>${escape(confirming.text)}</p><div class="dialog-footer"><button type="button" class="secondary-button" data-bots-action="confirm-cancel">Cancel</button><button type="button" class="primary-button danger" data-bots-action="confirm-run">${escape(confirming.button)}</button></div></div>` : '';
    const alert = error ? `<p class="bots-error" role="alert">${escape(error)}</p>` : '';
    if (loading || !detail) { top.innerHTML = loading ? '<p class="dialog-loading" role="status">Loading…</p>' : alert; side.innerHTML = ''; return; }
    top.innerHTML = renderPageHeader(detail.bot) + confirm + alert;
    side.id = 'bot-page-settings';
    side.hidden = !settingsOpen;
    pane.classList.toggle('settings-open', settingsOpen);
    if (settingsOpen) {
      // Keep a half-typed setting (a new memory, a schedule prompt) through background refreshes.
      const typing = side.contains(document.activeElement) ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : null;
      const kept = typing && 'value' in typing ? { name: typing.name || typing.getAttribute('aria-label') || '', value: typing.value } : null;
      const counts: Partial<Record<Tab, number>> = { memory: detail.memories.length, schedules: detail.schedules.filter(item => item.enabled).length, channels: detail.channels.filter(item => item.enabled).length, rules: detail.rules.length };
      const count = (id: Tab) => badge(id) || (counts[id] ? `<span class="bots-count">${counts[id]}</span>` : '');
      const tabs = `<div class="bots-tabs bots-settings-tabs" role="tablist" aria-label="Bot settings">${SETTINGS.map(item => `<button type="button" role="tab" data-settings-tab="${item.id}" aria-selected="${item.id === settingsTab}">${item.label}${count(item.id as Tab)}</button>`).join('')}</div>`;
      const body = settingsTab === 'profile' ? renderForm(detail.bot) : renderPanel(settingsTab, detail, context);
      const heading = settingsTab === 'profile'
        ? `<div class="bots-settings-heading"><b>Profile</b><button type="button" class="bots-text-button" data-settings-tab="memory">${icon('back')}Back to settings</button></div>`
        : `<div class="bots-settings-heading"><b>Settings</b><button type="button" class="icon-button" data-bots-action="hide-settings" aria-label="Hide panel" title="Hide panel">${icon('close')}</button></div>${tabs}`;
      side.innerHTML = `${heading}<div class="bots-panel" role="tabpanel" aria-label="${escape(settingsLabel(settingsTab))}">${body}</div>`;
      const group = side.querySelector<HTMLElement>('.bots-tabs');
      if (group) trackSegment(group, group.querySelector<HTMLElement>('[aria-selected="true"]'));
      if (kept?.name) {
        const again = [...side.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].find(field => (field.name || field.getAttribute('aria-label')) === kept.name);
        if (again) { again.value = kept.value; again.focus(); }
      }
    } else side.innerHTML = '';
    // Remount only when the bot or its paused state changes; otherwise the chat keeps its draft and scroll.
    if (!chat || chat.key !== chatKey(detail.bot)) mountChatIfShown();
    else chat.view.update();
  }
  /** Setup steps for an empty conversation, each opening the setting that completes it. */
  function setupSteps(): { id: string; label: string; detail: string; done: boolean }[] {
    if (!detail) return [];
    return [
      { id: 'profile', label: 'Give it instructions', detail: 'How it should work, and its standing goals', done: Boolean(detail.bot.instructions.trim()) },
      { id: 'memory', label: 'Tell it what to remember', detail: 'Preferences and facts it keeps across chats', done: detail.memories.length > 0 },
      { id: 'schedules', label: 'Schedule recurring work', detail: 'A morning digest, a weekly review', done: detail.schedules.length > 0 },
      { id: 'channels', label: 'Reach it from your phone', detail: 'Telegram, Slack, Discord, WhatsApp or a browser', done: detail.channels.length > 0 },
    ];
  }
  function openSetup(id: string): void {
    if (page) {
      settingsTab = id as Tab | 'profile'; settingsOpen = true;
      try { localStorage.setItem('pandacode.botSettings', 'open'); } catch { /* A per-device preference only. */ }
    } else if (id === 'profile') editing = 'edit';
    else tab = id as Tab;
    render();
    (page ? side() : pane)?.querySelector<HTMLElement>('input:not([type=checkbox]),textarea')?.focus();
  }
  function mountChatIfShown(): void {
    const slot = pane.querySelector<HTMLElement>('.bots-chat-host');
    const focused = chat?.host.contains(document.activeElement) ?? false;
    chat?.view.dispose(); chat = null;
    if (!slot || !detail) return;
    const bot = detail.bot;
    chat = { key: chatKey(bot), host: slot, view: mountChat(slot, bot, desktopThread(), {
      call: options.call, running: options.running, live: options.live, notify: options.notify, openTask: options.openTask, approve: options.approve,
      showOpen: !page, started: () => { void load(); }, setup: setupSteps, openSetup, toolbar: chatToolbar,
    }) };
    if (focused) slot.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }
  function badge(id: Tab): string {
    const count = id === 'channels' ? detail?.pairings.filter(item => item.status === 'pending').length ?? 0 : 0;
    return count ? `<span class="bots-badge" aria-label="${count} waiting">${count}</span>` : '';
  }

  const click = (event: MouseEvent) => {
    // A click anywhere outside the More menu closes it, like any menu.
    if (moreOpen && !(event.target instanceof Element && event.target.closest('.bp-more'))) { moreOpen = false; render(); }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button,[data-bot]') : null;
    if (!target || !host.contains(target) || (target as HTMLButtonElement).disabled) return;
    if (target.dataset.bot) { selected = target.dataset.bot; editing = null; confirming = null; tab = 'chat'; void load(); return; }
    if (target.dataset.tab) { tab = target.dataset.tab as Tab; confirming = null; render(); return; }
    if (target.dataset.settingsTab) { settingsTab = target.dataset.settingsTab as Tab | 'profile'; confirming = null; render(); return; }
    if (target.dataset.template) {
      template = TEMPLATES.find(item => item.id === target.dataset.template) ?? TEMPLATES[0];
      render(); pane.querySelector<HTMLInputElement>('input[name=name]')?.focus(); return;
    }
    const action = target.dataset.botsAction;
    const bot = detail?.bot;
    // Any choice closes the More menu.
    if (moreOpen && action !== 'more') moreOpen = false;
    if (action === 'new') { editing = 'new'; template = TEMPLATES[0]; confirming = null; render(); pane.querySelector<HTMLInputElement>('input[name=name]')?.focus(); }
    else if (action === 'cancel-edit') { editing = null; if (page) settingsTab = 'memory'; render(); }
    else if (action === 'more') { moreOpen = !moreOpen; render(); if (moreOpen) pane.querySelector<HTMLElement>('.bp-menu [role=menuitem]')?.focus(); }
    else if (action === 'toggle-settings') {
      // From the profile, the toggle returns to the settings tabs rather than closing.
      if (settingsOpen && settingsTab === 'profile') { settingsTab = 'memory'; render(); return; }
      settingsOpen = !settingsOpen;
      try { localStorage.setItem('pandacode.botSettings', settingsOpen ? 'open' : 'closed'); } catch { /* A per-device preference only. */ }
      render();
    }
    else if (action === 'hide-settings') { settingsOpen = false; try { localStorage.setItem('pandacode.botSettings', 'closed'); } catch { /* A per-device preference only. */ } render(); }
    else if (action === 'edit' && bot) {
      if (page) { settingsTab = 'profile'; settingsOpen = true; } else editing = 'edit';
      render();
      (page ? side() : pane)?.querySelector<HTMLElement>(`.bots-form [name="${target.dataset.focus ?? 'name'}"]`)?.focus();
    }
    else if (action === 'pause' && bot) void work(async () => { await options.call('bot_set_paused', { botId: bot.id, paused: !bot.paused }); options.notify(bot.paused ? `${bot.name} resumed` : `${bot.name} paused`); await load(); });
    else if (action === 'reset' && bot) context.confirm(`Reset ${bot.name}?`, 'This deletes its conversations, memories, schedules and activity. Its instructions, channels and rules stay.', 'Reset', async () => { await options.call('bot_reset', { botId: bot.id }); options.notify(`${bot.name} was reset`); await load(); });
    else if (action === 'delete' && bot) context.confirm(`Delete ${bot.name}?`, 'This removes the bot, its conversations and its channel connections. Its workspace folder stays on disk.', 'Delete', async () => { await options.call('bot_delete', { botId: bot.id }); selected = ''; options.notify(`${bot.name} was deleted`); if (page) { options.onDeleted?.(); return; } await load(); });
    else if (action === 'confirm-cancel') { confirming = null; render(); }
    else if (action === 'confirm-run' && confirming) { const run = confirming.action; confirming = null; render(); void work(run); }
    else panelClick(target, page ? settingsTab as Tab : tab, context);
  };
  const submit = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement;
    if (!host.contains(form)) return;
    event.preventDefault();
    if (!form.matches('.bots-form')) { panelSubmit(form, page ? settingsTab as Tab : tab, context); return; }
    const input = readForm(form);
    if (!input.name) { error = 'Give the bot a name.'; render(); return; }
    void work(async () => {
      if ((editing === 'edit' || page) && detail) { await options.call('bot_update', { botId: detail.bot.id, input }); options.notify('Bot saved'); }
      else { const bot = await options.call<Bot>('bot_create', { input }); selected = bot.id; tab = 'chat'; options.notify(`${bot.name} is ready`); }
      editing = null; await load();
    });
  };
  const change = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target.matches('.bots-form select[name=provider]')) {
      const provider = options.providers.find(item => item.id === (target as HTMLSelectElement).value);
      const select = pane.querySelector<HTMLSelectElement>('.bots-form select[name=model]');
      if (provider && select) {
        const model = options.defaultModel(provider.id);
        select.innerHTML = provider.models.length ? provider.models.map(item => `<option value="${escape(item.id)}" ${item.id === model ? 'selected' : ''}>${escape(item.name)}</option>`).join('') : `<option value="${escape(model)}">${escape(model || 'Default')}</option>`;
      }
      return;
    }
    panelChange(target, page ? settingsTab as Tab : tab, context);
  };
  host.addEventListener('click', click);
  host.addEventListener('submit', submit);
  host.addEventListener('change', change);
  const typed = (event: Event) => connectInput(event.target as HTMLElement);
  host.addEventListener('input', typed);
  // `toggle` does not bubble, so listen while capturing.
  const toggled = (event: Event) => { if (event.target instanceof HTMLDetailsElement) guideToggled(event.target); };
  host.addEventListener('toggle', toggled, true);
  const keys = (event: KeyboardEvent) => { if (event.key === 'Escape' && moreOpen) { event.preventDefault(); event.stopPropagation(); moreOpen = false; render(); pane.querySelector<HTMLElement>('[data-bots-action="more"]')?.focus(); } };
  host.addEventListener('keydown', keys);
  render();
  void load();
  return {
    refresh: () => { if (!busy) void load(); },
    agent: (sessionId, kind) => {
      if (!detail?.threads.some(thread => thread.sessionId === sessionId)) return;
      if (kind === 'done') { void load(); if (page) void chat?.view.reload(); return; }
      if (sessionId === desktopThread()) chat?.view.update();
      if (kind === 'turn_start' || kind === 'status') renderList();
    },
    dispose: () => { disposed = true; chat?.view.dispose(); chat = null; host.removeEventListener('click', click); host.removeEventListener('submit', submit); host.removeEventListener('change', change); host.removeEventListener('input', typed); host.removeEventListener('toggle', toggled, true); host.removeEventListener('keydown', keys); },
  };
}
