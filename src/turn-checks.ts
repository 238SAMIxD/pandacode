//! Optional turn-end project checks: Settings → Agents turns them on, and a
//! failing check queues one fix-it message through the ordinary message
//! queue, where the user sees and can edit or cancel it. One repair per run:
//! a repair turn's own failure waits for the user instead of looping.

const KEY = 'pandacode.turnChecks';
const repaired = new Set<string>();

export function enabled(): boolean {
  try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
}

export function setEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, String(on)); } catch { /* Kept for this window only. */ }
}

/** A message the user sent themselves restarts the repair budget for that task. */
export function noteManualSend(sessionId: string): void {
  repaired.delete(sessionId);
}

export interface CheckReport {
  checked: boolean;
  name?: string;
  ok?: boolean;
  output?: string;
  reason?: string;
}

/** Pure decision: checks on, the check ran, it failed, and this run has no repair yet. */
export function shouldRepair(input: { on: boolean; report: CheckReport; alreadyRepaired: boolean }): boolean {
  return input.on && input.report.checked === true && input.report.ok === false && !input.alreadyRepaired;
}

/** The queued repair text; the failure output is already bounded natively. */
export function repairPrompt(report: CheckReport): string {
  const name = report.name ?? 'project checks';
  const output = (report.output ?? '').trim();
  return `Project checks failed after your last turn (${name}). Fix the failures before anything else; do not start new work.${output ? `\n\n\`\`\`\n${output}\n\`\`\`` : ''}`;
}

export interface ChecksContext {
  call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  /** The finished task, when it is an ordinary project task. */
  task: { id: string } | undefined;
  isTeam: boolean;
  isBot: boolean;
  isRunning: boolean;
  queued: number;
  /** Called after the repair joins the queue, so the idle task starts on it. */
  onQueued(sessionId: string): void;
  onError(error: unknown): void;
}

/** Runs the checkout's fast check after a clean turn and queues one repair on failure. */
export async function afterRun(sessionId: string, context: ChecksContext): Promise<void> {
  if (!enabled() || !context.task || context.isTeam || context.isBot || context.isRunning || context.queued > 0) return;
  let report: CheckReport;
  try {
    report = await context.call<CheckReport>('run_turn_checks', { sessionId });
  } catch (error) {
    context.onError(error);
    return;
  }
  if (report.checked && report.ok) repaired.delete(sessionId);
  if (!shouldRepair({ on: enabled(), report, alreadyRepaired: repaired.has(sessionId) })) return;
  repaired.add(sessionId);
  try {
    await context.call('queue_add', { sessionId, text: repairPrompt(report), attachments: [] });
    context.onQueued(sessionId);
  } catch (error) {
    repaired.delete(sessionId);
    context.onError(error);
  }
}
