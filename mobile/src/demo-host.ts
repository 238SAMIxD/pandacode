// The fake computer behind demo mode (src/demo.ts): client.ts sends every host call here instead
// of the relay, so sends, steers, approvals, answers and stops act on the local demo data and
// nothing touches the network. Pure apart from the injected timer (tested in node).
import { OFFLINE, type Method } from './connect/rpc.ts';
import type { ConfigureParams, Message, StartParams, TaskSummary } from './connect/types.ts';
import type { ConnectState } from './store/index.ts';
import { idleLive, lastId } from './store/reduce.ts';

export const REPLY_MS = 1500;
export const DEMO_REPLY = 'This is the demo, so nothing ran. On your own computer the agent would work on this now: its tools, approvals and reply would stream in here as it goes.';

type Patch = Partial<ConnectState>;

export interface DemoHost {
  get: () => ConnectState;
  set: (update: (s: ConnectState) => Patch) => void;
  later: (run: () => void, ms: number) => void;
  now: () => number;
}

const key = (deviceId: string, sessionId: string) => `${deviceId}/${sessionId}`;

const append = (list: readonly Message[] | undefined, role: string, content: string, now: number, turnDurationMs: number | null = null): Message[] =>
  [...(list ?? []), { id: lastId(list) + 1, role, content, createdAt: now, turnDurationMs }];

function withTask(s: ConnectState, deviceId: string, sessionId: string, change: Partial<TaskSummary>): ConnectState['tasks'] {
  const list = s.tasks[deviceId];
  if (!list) return s.tasks;
  return { ...s.tasks, [deviceId]: { ...list, tasks: list.tasks.map(t => (t.sessionId === sessionId ? { ...t, ...change } : t)) } };
}

/** A prompt joins the transcript and the task runs until the canned reply. */
export function sent(s: ConnectState, deviceId: string, sessionId: string, text: string, now: number): Patch {
  const k = key(deviceId, sessionId);
  return {
    messages: { ...s.messages, [k]: append(s.messages[k], 'user', text, now) },
    live: { ...s.live, [k]: { ...idleLive(), status: 'running', activity: 'Generating response' } },
    tasks: withTask(s, deviceId, sessionId, { status: 'running', updatedAt: now, lastPromptAt: now }),
  };
}

/** The canned reply ends a run that is still going; a stopped or waiting run gets none. */
export function replied(s: ConnectState, deviceId: string, sessionId: string, now: number): Patch {
  const k = key(deviceId, sessionId);
  if (s.live[k]?.status !== 'running') return {};
  return {
    messages: { ...s.messages, [k]: append(s.messages[k], 'assistant', DEMO_REPLY, now, REPLY_MS) },
    live: { ...s.live, [k]: idleLive() },
    tasks: withTask(s, deviceId, sessionId, { status: 'idle', updatedAt: now, pending: [] }),
  };
}

export function stopped(s: ConnectState, deviceId: string, sessionId: string, now: number): Patch {
  const k = key(deviceId, sessionId);
  return { live: { ...s.live, [k]: { ...idleLive(), status: 'stopped' } }, tasks: withTask(s, deviceId, sessionId, { status: 'stopped', updatedAt: now, pending: [] }) };
}

export function started(s: ConnectState, deviceId: string, sessionId: string, params: StartParams, now: number): Patch {
  const list = s.tasks[deviceId] ?? { tasks: [], projects: [], loadedAt: now };
  const projectId = params.projectId ?? params.repo ?? 'demo';
  const task: TaskSummary = {
    sessionId, title: params.prompt.split('\n')[0].slice(0, 80) || 'New task', status: 'running',
    projectId, projectName: list.projects.find(p => p.id === projectId)?.name ?? projectId,
    provider: params.provider, model: params.model, effort: params.effort ?? null, mode: params.mode ?? 'ask',
    pinned: false, updatedAt: now, lastPromptAt: now, branch: params.branch,
  };
  return {
    tasks: { ...s.tasks, [deviceId]: { ...list, tasks: [task, ...list.tasks] } },
    messages: { ...s.messages, [key(deviceId, sessionId)]: append([], 'user', params.prompt, now) },
  };
}

/** Answers one host call from the demo data, as the real host would. */
export async function demoCall(host: DemoHost, deviceId: string, method: Method, params: any): Promise<unknown> {
  const s = host.get();
  if (!s.devices.find(d => d.id === deviceId)?.online) throw new Error(OFFLINE);
  const reply = (sessionId: string) => host.later(() => host.set(next => replied(next, deviceId, sessionId, host.now())), REPLY_MS);
  switch (method) {
    case 'tasks.list': {
      const list = s.tasks[deviceId];
      return { tasks: list?.tasks ?? [], projects: list?.projects ?? [] };
    }
    case 'task.messages': return { messages: [], hasMore: false, title: '' };
    case 'subscribe': return { tasks: [] };
    case 'providers.list': return s.providers[deviceId] ?? [];
    case 'providers.models': return s.models[`${deviceId}/${params?.provider}`] ?? [];
    case 'task.send':
    case 'task.steer':
      host.set(next => sent(next, deviceId, params.sessionId, String(params.text ?? ''), host.now()));
      reply(params.sessionId);
      return method === 'task.send' ? { queued: false } : {};
    case 'task.stop':
      host.set(next => stopped(next, deviceId, params.sessionId, host.now()));
      return {};
    case 'approval.respond':
    case 'input.respond':
      reply(params.sessionId); // client.ts clears the request and marks the run going again
      return {};
    case 'task.configure': {
      const { sessionId, ...change } = params as ConfigureParams;
      const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
      host.set(next => ({ tasks: withTask(next, deviceId, sessionId, defined) }));
      return {};
    }
    case 'task.start': {
      const sessionId = `demo-${host.now().toString(36)}`;
      host.set(next => started(next, deviceId, sessionId, params as StartParams, host.now()));
      reply(sessionId);
      return { sessionId };
    }
    default:
      throw new Error('Unknown method.'); // projects.icons: the demo's one icon is seeded
  }
}
