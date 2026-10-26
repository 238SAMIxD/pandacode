// Wire shapes from docs/remote-access.md and src-tauri/src/remote/host.rs.

export interface Account { id: string; login: string; avatarUrl: string }

/** A presence row (also `GET /v1/devices`). */
export interface Device { id: string; name: string; platform: string; publicKey: string; host: boolean; online: boolean; lastSeen: number }

export interface Project { id: string; name: string; repo: string | null }

export type TaskStatus = 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed' | 'stopped' | (string & {});

export interface TaskSummary extends HostActivity {
  sessionId: string; title: string; status: TaskStatus; projectId: string; projectName: string;
  provider: string; model: string; effort: string | null; mode: string; pinned: boolean;
  updatedAt: number; lastPromptAt: number | null; branch?: string; chat?: boolean;
  /** A bot's conversation: listed under Bots, not its project. */
  botId?: string; botName?: string;
  /** Approvals and questions waiting on the host now. */
  pending?: PendingRequest[];
  /** The newest message id, from hosts that send it (prefetch skips threads already current). */
  lastId?: number;
  /** Set on rows drawn from the inbox cache at launch: when this state was last confirmed. A live list replaces them. */
  seenAt?: number;
}

/** Newer hosts: when the run's newest event came and when it started (ms), and its subagents.
 * `team` (architect tasks only, checked by decodeTeamRun in src/store/team.ts): `{ status, activeWorkers }`. */
export interface HostActivity { lastEventAt?: number | null; runStartedAt?: number | null; subagents?: unknown; team?: unknown }

export interface TasksList { tasks: TaskSummary[]; projects: Project[] }

/** An approval or input request waiting on the host, from a subscribe reply. */
export interface PendingRequest { kind: 'approval' | 'input_request' | (string & {}); requestId: string; text: string; data?: unknown; tool?: ToolActivity }

export interface SubscribedTask extends HostActivity { sessionId: string; status: TaskStatus; lastId: number; title: string; pending?: PendingRequest[] }

/** `attachments`: newer hosts' rows (checked by parseAttachments in src/store/attachments.ts). */
export interface Message { id: number; role: string; content: string; createdAt: number; turnDurationMs: number | null; attachments?: unknown }
/** `hasMore`: newer messages follow the page; `hasOlder` (newer hosts, tail/beforeId pages): older ones precede it. */
export interface MessagePage { messages: Message[]; hasMore: boolean; title: string; hasOlder?: boolean; lastId?: number | null }

export interface ReasoningEffort { id: string; name: string; description: string }
export interface ProviderModel { id: string; name: string; description: string; reasoningEfforts?: ReasoningEffort[]; defaultReasoningEffort?: string | null; contextWindow?: number | null }
export interface Provider { id: string; name: string; installed: boolean; path?: string | null; version?: string | null; models: ProviderModel[] }

export interface ToolActivity { id: string; name: string; status: 'running' | 'completed' | 'failed'; input: string; output: string }

/** The host's raw AgentEvent (src/types.ts). */
export interface AgentEvent { sessionId: string; kind: string; text: string; requestId?: string; data?: unknown; tool?: ToolActivity }

/** Newer hosts, architect tasks: `status` as tasks.list shows it ('running' while the team works),
 * `team` (`{ status, activeWorkers }`), and `teamSettled` on the extra run.finished sent when the team settles. */
export interface RunFinished { sessionId: string; successful: boolean; stopped: boolean; text: string; status?: TaskStatus; team?: unknown; teamSettled?: boolean }

export interface StartParams {
  repo?: string; projectId?: string; branch?: string; worktree: boolean; prompt: string;
  provider: string; model: string; mode?: string; effort?: string;
}

export interface ConfigureParams { sessionId: string; provider?: string; model?: string; effort?: string | null; mode?: string }

// ---- Pull requests, changes and bots (newer hosts; older ones answer 'Unknown method.') ----

export interface PullCheck { name: string; state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral' | (string & {}); url: string }
export interface PullFile { path: string; additions: number; deletions: number }
export interface PullCommit { oid: string; headline: string; author: string; date: string }
export interface PullComment { kind: 'comment' | 'review' | (string & {}); author: string; body: string; state: string; createdAt: string }
export interface PullDetail {
  number: number; title: string; body: string; bodyTruncated: boolean; state: string; url: string; author: string;
  base: string; head: string; additions: number; deletions: number; changedFiles: number;
  createdAt: string; updatedAt: string; mergedAt: string; mergeable: string; reviewDecision: string;
  labels: string[]; checks: PullCheck[]; files: PullFile[]; commits: PullCommit[]; timeline: PullComment[]; truncated?: boolean;
}
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface ChangedFile { path: string; status: string; staged: boolean }
export interface Changes { branch: string; ahead: number; behind: number; files: ChangedFile[] }
export interface Diff { text: string; truncated: boolean }

export interface Bot { id: string; name: string; avatar: string | null; state: 'paused' | 'working' | 'ready' | (string & {}); paused: boolean; desktopSession: string | null; projectId: string }
