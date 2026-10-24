// The inbox: every computer's tasks in one list, grouped by what they need from you.
// Pure (tested in node): screens pass store slices in and render the result.
import type { Bot, TaskSummary, TasksList } from '../connect/types.ts';
import type { Live } from './reduce.ts';

export const SETTLED_MS = 24 * 3600_000;

export type Section = 'needs' | 'working' | 'recent' | 'unsent' | 'snoozed' | 'settled';
export type Badge = 'approval' | 'question' | 'working' | 'failed' | 'unsent' | null;

export interface InboxRow {
  /** taskKey */
  key: string;
  deviceId: string;
  computer: string;
  task: TaskSummary;
  badge: Badge;
  /** Sort time: the last prompt or update. */
  at: number;
  pinned: boolean;
  /** Outbox entry id and message text for Unsent rows. */
  outboxId?: string;
  text?: string;
}

export interface OutboxEntry { id: string; deviceId: string; sessionId: string; text: string; createdAt: number; error?: string }

export interface InboxInput {
  hosts: readonly { id: string; name: string }[];
  tasks: Readonly<Record<string, TasksList | undefined>>;
  live: Readonly<Record<string, Live | undefined>>;
  /** taskKey → snoozed until (ms). */
  snoozed: Readonly<Record<string, number>>;
  /** taskKey → pinned on this phone. */
  pins: Readonly<Record<string, boolean>>;
  outbox: readonly OutboxEntry[];
  now: number;
}

export type Inbox = Record<Section, InboxRow[]>;

function badgeOf(task: TaskSummary, live: Live | undefined): Badge {
  const approvals = live?.approvals.length ?? task.pending?.filter(p => p.kind === 'approval').length ?? 0;
  const inputs = live?.inputs.length ?? task.pending?.filter(p => p.kind === 'input_request').length ?? 0;
  if (approvals) return 'approval';
  if (inputs) return 'question';
  // A live view that went idle (run.finished) is newer than the last list.
  const status = live && live.status !== 'idle' ? live.status : task.status;
  if (status === 'waiting') return 'approval';
  if (status === 'running') return 'working';
  if (status === 'failed') return 'failed';
  return null;
}

const byTime = (a: InboxRow, b: InboxRow) => Number(b.pinned) - Number(a.pinned) || b.at - a.at;

export function inboxSections({ hosts, tasks, live, snoozed, pins, outbox, now }: InboxInput): Inbox {
  const out: Inbox = { needs: [], working: [], recent: [], unsent: [], snoozed: [], settled: [] };
  const index = new Map<string, InboxRow>();
  for (const host of hosts) {
    for (const task of tasks[host.id]?.tasks ?? []) {
      if (task.botId) continue; // under Bots (botRows)
      const key = `${host.id}/${task.sessionId}`;
      const badge = badgeOf(task, live[key]);
      const at = Math.max(task.lastPromptAt ?? 0, task.updatedAt);
      const row: InboxRow = { key, deviceId: host.id, computer: host.name, task, badge, at, pinned: !!pins[key] || task.pinned };
      index.set(key, row);
      if ((snoozed[key] ?? 0) > now) out.snoozed.push(row);
      else if (badge === 'approval' || badge === 'question') out.needs.push(row);
      else if (badge === 'working') out.working.push(row);
      else if (!row.pinned && now - at > SETTLED_MS) out.settled.push(row);
      else out.recent.push(row);
    }
  }
  for (const entry of outbox) {
    const row = index.get(`${entry.deviceId}/${entry.sessionId}`);
    if (row) out.unsent.push({ ...row, key: `outbox/${entry.id}`, badge: 'unsent', at: entry.createdAt, outboxId: entry.id, text: entry.text });
  }
  for (const section of Object.keys(out) as Section[]) if (section !== 'unsent') out[section].sort(byTime);
  return out;
}

/** Drops snoozes that have ended, so the stored map doesn't grow. */
export const activeSnoozes = (snoozed: Readonly<Record<string, number>>, now: number) =>
  Object.fromEntries(Object.entries(snoozed).filter(([, until]) => until > now));

/** Tomorrow at 8:00 local time. */
export function tomorrowMorning(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

/** How long a row has been working or waiting, for the Duo sidebar: `<1m`, `6m`, `1h 5m`, `3d`. */
export function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Rows whose title, project, branch or computer contains `query` (case-insensitive). */
export function filterRows(rows: readonly InboxRow[], query: string): InboxRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(r => [r.task.title, r.task.chat ? 'Chat' : r.task.projectName, r.task.branch, r.computer].some(v => v?.toLowerCase().includes(q)));
}

/** A bot in the inbox's Bots section: `at` is its conversations' latest activity (0 if none listed). */
export interface BotRow { key: string; deviceId: string; computer: string; bot: Bot; at: number }

/** Every computer's bots, most recently active first, then by name. */
export function botRows(hosts: readonly { id: string; name: string }[], bots: Readonly<Record<string, readonly Bot[] | undefined>>, tasks: InboxInput['tasks']): BotRow[] {
  const rows: BotRow[] = [];
  for (const host of hosts) {
    const latest = new Map<string, number>();
    for (const t of tasks[host.id]?.tasks ?? []) if (t.botId) latest.set(t.botId, Math.max(latest.get(t.botId) ?? 0, t.lastPromptAt ?? 0, t.updatedAt));
    for (const bot of bots[host.id] ?? []) rows.push({ key: `${host.id}/bot/${bot.id}`, deviceId: host.id, computer: host.name, bot, at: latest.get(bot.id) ?? 0 });
  }
  return rows.sort((a, b) => b.at - a.at || a.bot.name.localeCompare(b.bot.name));
}

/** The bot whose conversation this task is: its listed botId, or the bot's desktop conversation. */
export function botOf(bots: readonly Bot[] | undefined, task: Pick<TaskSummary, 'botId'> | undefined, sessionId: string): Bot | undefined {
  return bots?.find(b => b.id === task?.botId || b.desktopSession === sessionId);
}

/** Bot rows whose name or computer contains `query`. */
export function filterBots(rows: readonly BotRow[], query: string): BotRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter(r => [r.bot.name, r.computer].some(v => v.toLowerCase().includes(q))) : [...rows];
}
