import type { ToolActivity } from './types';
import { escape, icon } from './dom.ts';
import { pandacodeCard, pandacodeFamily, pandacodeTool, pandacodeTrace } from './tool-trace-pandacode.ts';

/** Sentence-style tool traces: `Verb [chip] object` rows, result cards and group summaries. Pure and escaped. */
export type TraceKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'fetch' | 'todo' | 'agent' | 'skill' | 'mcp' | 'tool';
export type TraceChip = { icon: string; label: string; title: string };
/** `family` tints the row icon (PandaCode tool families, `agent`, `mcp`); `icon` overrides the kind's icon. */
export type Trace = { kind: TraceKind; verb: string; chip?: TraceChip; object: string; mono?: boolean; added?: number; removed?: number; family?: string; icon?: string; exit?: number };
export type Tool = Pick<ToolActivity, 'name' | 'status' | 'input' | 'output'>;
export type Fields = Record<string, unknown>;

const MAX_SCAN = 20_000;
const MAX_TEXT = 140;
const LIST_ITEMS = 6;
const PREVIEW_LINES = 8;
const DIFF_LINES = 14;
const OMITTED = '[Non-text content omitted]';

// [running verb, finished verb, row icon, summary noun singular, plural]
const KINDS: Record<TraceKind, [string, string, string, string, string]> = {
  shell: ['Running', 'Ran', 'terminal', 'command', 'commands'],
  read: ['Reading', 'Read', 'file', 'file', 'files'],
  edit: ['Editing', 'Edited', 'edit', 'file', 'files'],
  write: ['Writing', 'Wrote', 'plus', 'file', 'files'],
  search: ['Searching', 'Searched', 'search', 'search', 'searches'],
  web: ['Searching', 'Searched', 'globe', 'search', 'searches'],
  fetch: ['Fetching', 'Fetched', 'external', 'page', 'pages'],
  todo: ['Updating', 'Updated', 'check', 'plan', 'plans'],
  agent: ['Starting', 'Started', 'bot', 'agent', 'agents'],
  skill: ['Loading', 'Loaded', 'spark', 'skill', 'skills'],
  mcp: ['Using', 'Used', 'server', 'tool', 'tools'],
  tool: ['Using', 'Used', 'command', 'tool', 'tools'],
};
// Summary phrasing: searches read as "Ran 2 searches" like the reference, the rest keep their row verb.
const SUMMARY_VERB: Partial<Record<TraceKind, [string, string]>> = { search: ['Running', 'Ran'], web: ['Running', 'Ran'] };

export function kindIcon(kind: TraceKind): string { return KINDS[kind][2]; }
export function traceIcon(trace: Trace): string { return trace.icon ?? kindIcon(trace.kind); }

/** Like clip, but keeps line breaks for multi-line prose. */
export function clipText(value: string, limit: number): string {
  const trimmed = value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > limit ? trimmed.slice(0, limit - 1) + '…' : trimmed;
}
export function clip(value: string, limit = MAX_TEXT): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat;
}
export function basename(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
export function text(value: unknown): string { return typeof value === 'string' ? value : Array.isArray(value) && value.every(part => typeof part === 'string') ? value.join(' ') : ''; }
export function field(fields: Fields, ...keys: string[]): string {
  for (const key of keys) { const value = text(fields[key]); if (value) return value; }
  return '';
}
export function lines(value: string): string[] { return value ? value.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n') : []; }
function cleanOutput(output: string): string { return output.trim() === OMITTED ? '' : output.slice(0, MAX_SCAN); }

export function parseFields(input: string): Fields {
  const value = input.slice(0, MAX_SCAN).trim();
  if (!value.startsWith('{')) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Fields : {};
  } catch { return {}; }
}

/** Any JSON value, or undefined for text. */
export function parseJson(value: string): unknown {
  const trimmed = value.slice(0, MAX_SCAN).trim();
  if (!/^[[{]/.test(trimmed)) return;
  try { return JSON.parse(trimmed); } catch { return; }
}

export function toolKind(name: string): TraceKind {
  const own = pandacodeTool(name);
  if (own) return own === 'vm_exec' ? 'shell' : 'mcp';
  const n = name.toLowerCase();
  if (/^(bash|shell|command|exec_command|local_shell|run_terminal_cmd)$/.test(n)) return 'shell';
  if (/^(read|read_file|view|readfile)$/.test(n)) return 'read';
  if (/^(edit|multiedit|multi_edit|str_replace\w*|apply_patch|patch)$/.test(n)) return 'edit';
  if (/^(write|write_file|create|create_file)$/.test(n)) return 'write';
  if (/^(grep|glob|search|find|ls|list|list_dir|codebase_search|file_search)$/.test(n)) return 'search';
  if (/^web_?search$/.test(n)) return 'web';
  if (/^(web_?fetch|fetch)$/.test(n)) return 'fetch';
  if (/^(todowrite|todo_write|update_plan)$/.test(n)) return 'todo';
  if (/^(task|agent|subagent|spawn_?agent|spawnagent)$/.test(n)) return 'agent';
  if (n === 'skill') return 'skill';
  if (n.startsWith('mcp__') || n.includes(' · ')) return 'mcp';
  return 'tool';
}

/** Codex records plain text: `/bin/zsh -lc "cmd"\nWorking directory: …`. */
export function shellCommand(input: string, fields: Fields): string {
  const command = field(fields, 'command', 'cmd') || (input.trim().startsWith('{') ? '' : input.trim().split('\n', 1)[0] ?? '');
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (wrapped ? wrapped[2] : command).trim();
}

export function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return clip(url, 60); }
}

function editLines(fields: Fields): { old: string; new: string }[] {
  const edits = Array.isArray(fields.edits) ? fields.edits as Fields[] : [fields];
  return edits.filter(edit => edit && typeof edit === 'object')
    .map(edit => ({ old: field(edit, 'old_string', 'oldText', 'old_str'), new: field(edit, 'new_string', 'newText', 'new_str', 'content') }));
}
function diffCounts(fields: Fields): { added: number; removed: number } {
  return editLines(fields).reduce((sum, edit) => ({ added: sum.added + lines(edit.new).length, removed: sum.removed + lines(edit.old).length }), { added: 0, removed: 0 });
}

function filePath(input: string, fields: Fields): string {
  return field(fields, 'file_path', 'path', 'filePath', 'target_file') || (input.trim().startsWith('{') ? '' : input.trim().split('\n', 1)[0] ?? '');
}

function fileChip(path: string): TraceChip | undefined {
  return path ? { icon: 'file', label: basename(path), title: path } : undefined;
}

/** `mcp__server__tool` (Claude) and `server · tool` (Codex). */
export function mcpParts(name: string): { server: string; tool: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^(.+?) · (.+)$/.exec(name);
  if (mcp) return { server: mcp[1], tool: mcp[2] };
  return { server: 'MCP', tool: name };
}

function describeFields(kind: TraceKind, name: string, input: string, fields: Fields, running: boolean, output: string): Omit<Trace, 'kind' | 'verb'> & { verb?: string } {
  switch (kind) {
    case 'shell': {
      const command = shellCommand(input, fields);
      const [program = '', ...rest] = command.split(/\s+/);
      // A VM command names its machine, so identical commands on different machines stay apart.
      const target = /vm_exec$/.test(name) ? field(fields, 'name', 'vm', 'id') : '';
      const where = target ? ` · on ${target}` : '';
      return program ? { chip: { icon: 'terminal', label: basename(program), title: command }, object: clip(rest.join(' ')) + where, mono: true } : { object: field(fields, 'description') + where };
    }
    case 'read': case 'write': {
      const path = filePath(input, fields);
      const content = field(fields, 'content', 'contents');
      return { chip: fileChip(path), object: kind === 'write' && content ? `${lines(content).length} lines` : '' };
    }
    case 'edit': {
      const path = field(fields, 'file_path', 'path', 'filePath', 'target_file');
      return { chip: fileChip(path), object: '', ...diffCounts(fields) };
    }
    case 'search': {
      const where = field(fields, 'path', 'directory', 'target_directory');
      const pattern = field(fields, 'pattern', 'query', 'glob', 'regex');
      const glob = /glob|ls|list/.test(name.toLowerCase());
      return { chip: { icon: glob ? 'folder' : 'search', label: where ? basename(where) : 'workspace', title: where || 'workspace' }, object: pattern ? `${glob ? 'for files matching' : 'for'} ${clip(pattern, 80)}` : '' };
    }
    case 'web': return { chip: { icon: 'globe', label: 'Web', title: 'Web search' }, object: field(fields, 'query', 'q') ? `for ${clip(field(fields, 'query', 'q'))}` : '' };
    case 'fetch': {
      const url = field(fields, 'url');
      return { chip: url ? { icon: 'globe', label: domain(url), title: url } : undefined, object: clip(field(fields, 'prompt'), 90) };
    }
    case 'todo': {
      const todos = Array.isArray(fields.todos) ? fields.todos.length : Array.isArray(fields.plan) ? fields.plan.length : 0;
      return { object: todos ? `the plan · ${todos} ${todos === 1 ? 'step' : 'steps'}` : 'the plan' };
    }
    case 'agent': {
      const type = field(fields, 'subagent_type', 'agent_type', 'agent', 'name');
      return { family: 'agent', chip: { icon: 'bot', label: type || 'agent', title: type || 'agent' }, object: clip(field(fields, 'description', 'objective', 'prompt', 'message') || (input.trim().startsWith('{') ? '' : input), 90) };
    }
    case 'skill': {
      const skill = field(fields, 'skill', 'name', 'command');
      return { verb: running ? 'Loading skill' : 'Loaded skill', chip: skill ? { icon: 'spark', label: skill, title: skill } : undefined, object: '' };
    }
    case 'mcp': {
      const own = pandacodeTool(name);
      if (own) return pandacodeTrace(own, fields, output, running) ?? { family: 'pandacode', chip: { icon: 'server', label: 'PandaCode', title: name }, object: own.replace(/_/g, ' ') };
      const { server, tool } = mcpParts(name);
      return { family: 'mcp', chip: { icon: 'server', label: server, title: name }, object: tool.replace(/_/g, ' ') };
    }
    default: return { chip: { icon: 'command', label: name || 'Tool', title: name || 'Tool' }, object: inputHint(input) };
  }
}

export function inputHint(input: string): string {
  const fields = parseFields(input);
  const value = input.trim().startsWith('{')
    ? field(fields, 'command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'url', 'pattern', 'description')
    : input.trim().split('\n', 1)[0] ?? '';
  return clip(value, 96);
}

// `-ing` stems that need their `e` back, and doubled `l`s that English does not double.
const E_STEM = /^(creat|sav|mov|renam|nam|archiv|queu|remov|resolv|writ|typ|us|clos|captur|prepar|schedul|choos|updat|restor|tak|manag|delet|execut|leav|receiv|shar|describ|stag|pars|messag|coordinat|delegat|navigat|swip|generat|validat|complet|configur|chang|replac|enabl|disabl|invok|provid|decid|merg|serv|mak|giv|hid|guid|analyz|summariz)$/i;
const LL_STEM: Record<string, string> = { cancell: 'cancel', controll: 'control', labell: 'label', modell: 'model', travell: 'travel', signall: 'signal' };
/** `Creating task` → `Couldn't create task`; failure-first wording for failed rows. */
export function failedVerb(running: string): string {
  const [first = '', ...rest] = running.split(' ');
  const match = /^(.*?)ing$/i.exec(first);
  if (!match) return `Couldn't ${running.charAt(0).toLowerCase()}${running.slice(1)}`;
  const [, prefix, word] = /^(.*-)?(.*)$/.exec(match[1].toLowerCase()) ?? [];
  let stem = word ?? '';
  if (LL_STEM[stem]) stem = LL_STEM[stem];
  else if (/([bdgmnpt])\1$/.test(stem)) stem = stem.slice(0, -1);
  else if (E_STEM.test(stem)) stem += 'e';
  return ["Couldn't", (prefix ?? '') + stem, ...rest].join(' ');
}

export function describeTool(tool: Tool): Trace {
  const kind = toolKind(tool.name);
  const failed = tool.status === 'failed';
  const present = tool.status === 'running' || failed;
  const fields = parseFields(tool.input);
  const described = describeFields(kind, tool.name, tool.input, fields, present, cleanOutput(tool.output));
  const vm = kind === 'shell' && pandacodeTool(tool.name) === 'vm_exec' ? { family: 'vm' } : {};
  const verb = described.verb ?? KINDS[kind][present ? 0 : 1];
  const code = !failed && toolFailed(tool) ? exitCode(cleanOutput(tool.output)).code : undefined;
  return { ...described, ...vm, kind, verb: failed ? failedVerb(verb) : verb, ...(code !== undefined ? { exit: code } : {}) };
}

/** One escaped sentence for a row's summary: verb, chip, object and edit delta. */
export function traceRowHtml(trace: Trace): string {
  const chip = trace.chip ? `<span class="tool-trace-chip" title="${escape(trace.chip.title)}">${icon(trace.chip.icon)}<b>${escape(trace.chip.label)}</b></span>` : '';
  const object = trace.object ? `<span class="tool-trace-object${trace.mono ? ' is-mono' : ''}">${escape(trace.object)}</span>` : '';
  const delta = trace.added !== undefined ? `<span class="tool-trace-delta"><ins>+${trace.added}</ins> <del>−${trace.removed ?? 0}</del></span>` : '';
  const exit = trace.exit !== undefined ? `<span class="tool-trace-badge is-failed">exit ${trace.exit}</span>` : '';
  return `<span class="tool-trace-verb">${escape(trace.verb)}</span>${chip}${object}${delta}${exit}`;
}

function joinPhrases(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** `Ran 3 commands, read 2 files and edited 1 file` (present tense while any call runs; failures appended). */
// PandaCode tool families in summaries: [running verb, finished verb, singular, plural].
const FAMILY_NOUNS: Record<string, [string, string, string, string]> = {
  team: ['Coordinating', 'Coordinated', 'team step', 'team steps'],
  task: ['Managing', 'Managed', 'task action', 'task actions'],
  vm: ['Operating', 'Operated', 'VM action', 'VM actions'],
  simulator: ['Operating', 'Operated', 'simulator action', 'simulator actions'],
  design: ['Updating', 'Updated', 'design step', 'design steps'],
  browser: ['Using', 'Used', 'preview tool', 'preview tools'],
  cloud: ['Running', 'Ran', 'cloud command', 'cloud commands'],
  code: ['Using', 'Used', 'code tool', 'code tools'],
  moodboard: ['Reading', 'Read', 'moodboard', 'moodboards'],
  bot: ['Updating', 'Updated', 'bot action', 'bot actions'],
  jev: ['Running', 'Ran', 'Jev check', 'Jev checks'],
  meta: ['Updating', 'Updated', 'task detail', 'task details'],
};
function summaryNoun(tool: Tool | undefined): { key: string; noun: [string, string, string, string] } {
  const kind = tool ? toolKind(tool.name) : 'tool';
  const family = kind === 'mcp' && tool ? pandacodeFamily(tool.name) : undefined;
  if (family && FAMILY_NOUNS[family]) return { key: family, noun: FAMILY_NOUNS[family] };
  const [present, past, , one, many] = KINDS[kind];
  const [sPresent, sPast] = SUMMARY_VERB[kind] ?? [present, past];
  return { key: kind === 'web' ? 'search' : kind, noun: [sPresent, sPast, one, many] };
}

const SUMMARY_PHRASES = 2;
type GroupSummary = { sentence: string; running: number; failed: number };

/** Totals of completed calls (`Operated 4 VM actions`), at most two phrases then `+N more`; running and failed are counted apart.
 *  With nothing completed yet, the running calls lead in present tense; with only failures, `Couldn't …`. */
export function summarizeGroup(tools: (Tool | undefined)[]): GroupSummary {
  const failed = tools.filter(tool => tool && toolFailed(tool));
  const running = tools.filter(tool => tool?.status === 'running');
  const done = tools.filter(tool => !tool || tool.status === 'completed' && !toolFailed(tool));
  const [lead, tense] = done.length ? [done, 1] as const : running.length ? [running, 0] as const : [failed, 0] as const;
  const entries = new Map<string, { verb: string; noun: [string, string, string, string]; count: number }>();
  for (const tool of lead) {
    const { key, noun } = summaryNoun(tool);
    const verb = lead === failed ? failedVerb(noun[0]) : noun[tense];
    entries.set(key, { verb, noun, count: (entries.get(key)?.count ?? 0) + 1 });
  }
  const shown = [...entries].slice(0, SUMMARY_PHRASES);
  const byVerb = new Map<string, string[]>();
  for (const [key, { verb, noun, count }] of shown) byVerb.set(verb, [...(byVerb.get(verb) ?? []), key === 'todo' ? 'the plan' : `${count} ${noun[count === 1 ? 2 : 3]}`]);
  const phrases = [...byVerb].map(([verb, nouns]) => `${verb.toLowerCase()} ${joinPhrases(nouns)}`);
  const hidden = [...entries].slice(SUMMARY_PHRASES).reduce((sum, [, entry]) => sum + entry.count, 0);
  let sentence = phrases.join(', ') + (hidden > 0 ? ` +${hidden} more` : '');
  if (!done.length && running.length) sentence += '…';
  return {
    sentence: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    running: done.length ? running.length : 0,
    failed: failed.length,
  };
}

/** The group sentence with its state counts: `Operated 4 VM actions · 1 running · 1 failed`. */
export function summarizeTools(tools: (Tool | undefined)[]): string {
  const { sentence, running, failed } = summarizeGroup(tools);
  return sentence + (running ? ` · ${running} running` : '') + (failed ? ` · ${failed} failed` : '');
}

export function summaryIcons(tools: (Tool | undefined)[], limit = 4): string[] {
  return [...new Set(tools.map(tool => tool ? traceIcon(describeTool(tool)) : kindIcon('tool')))].slice(0, limit);
}

// --- Cards ---------------------------------------------------------------

const LONE_NOTE = /^(<!--trace-partial-->)?<p class="tool-trace-note( is-error)?">[^<]{0,120}<\/p>$/;
/** A card; a lone short note (a screenshot size, an error line) stays an inline result without the bordered plate. */
function card(kind: TraceKind, body: string): string {
  if (!body || body === COMPLETE) return body;
  return LONE_NOTE.test(body) ? body.replace('<p class="tool-trace-note', '<p data-trace-kind="' + kind + '" class="tool-trace-inline tool-trace-note') : `<div class="tool-trace-card" data-trace-kind="${kind}">${body}</div>`;
}
const BADGE_DONE = /^(completed?|done|saved|succeeded|success|resolved|booted|connected|available|delivered|true|passed)$/i;
const BADGE_LIVE = /^(running|in[_ ]progress|starting|working|active|waiting)$/i;
const BADGE_FAIL = /^(failed|error|errored|abandoned|cancell?ed|interrupted|blocked|false)$/i;
/** Status pill: success green, running accent with a still dot, failed red, everything else (queued, stopped, open) neutral. */
export function badge(label: string): string {
  if (!label) return '';
  const tone = BADGE_FAIL.test(label) ? ' is-failed' : BADGE_LIVE.test(label) ? ' is-live' : BADGE_DONE.test(label) ? '' : ' is-quiet';
  return `<span class="tool-trace-badge${tone}">${escape(clip(label.replace(/_/g, ' '), 24))}</span>`;
}
export function head(main: string, meta = ''): string {
  return `<div class="tool-trace-card-head">${main}${meta ? `<span class="tool-trace-card-meta">${escape(meta)}</span>` : ''}</div>`;
}
export function linesPre(value: string[], label: string): string {
  return value.length ? `${value.some(line => line.length > 400) ? PARTIAL : ''}<pre class="tool-trace-lines" tabindex="0" aria-label="${escape(label)}">${escape(value.map(line => line.slice(0, 400)).join('\n'))}</pre>` : '';
}
export type ListItem = { title: string; meta?: string; hint?: string; badge?: string };
export function list(items: ListItem[], total = items.length): string {
  if (!items.length) return '';
  const rows = items.slice(0, LIST_ITEMS).map(item => `<li><span class="tool-trace-item-title"${item.hint ? ` title="${escape(item.hint)}"` : ''}>${escape(clip(item.title, 120))}</span>${item.meta ? `<span class="tool-trace-item-meta">${escape(clip(item.meta, 80))}</span>` : ''}${item.badge ? badge(item.badge) : ''}</li>`).join('');
  const more = total - Math.min(items.length, LIST_ITEMS);
  const clipped = more > 0 || items.some(item => item.title.length > 120 || (item.meta?.length ?? 0) > 80);
  return `${clipped ? PARTIAL : ''}<ul class="tool-trace-list">${rows}${more > 0 ? `<li class="tool-trace-more">+${more} more</li>` : ''}</ul>`;
}

function exitCode(output: string): { code?: number; body: string } {
  const codex = /^Exit code: (-?\d+)\n?/.exec(output);
  if (codex) return { code: Number(codex[1]), body: output.slice(codex[0].length).replace(/^Wall time:.*\n?/, '').replace(/^Output:\n?/, '') };
  const json = parseFields(output);
  if (typeof json.exitCode === 'number') return { code: json.exitCode, body: [text(json.stdout), text(json.stderr)].filter(Boolean).join('\n') };
  return { body: output };
}

function shellCard(tool: Tool, fields: Fields): string {
  return terminalCard(shellCommand(tool.input, fields), cleanOutput(tool.output), tool.status);
}

/** A failed call, or a command that exited nonzero. */
export function toolFailed(tool: Tool): boolean {
  if (tool.status === 'failed') return true;
  if (tool.status !== 'completed') return false;
  const kind = toolKind(tool.name);
  if (kind !== 'shell' && pandacodeTool(tool.name) !== 'cloud_cli') return false;
  const { code } = exitCode(cleanOutput(tool.output));
  return code !== undefined && code !== 0;
}

/** Command line, exit badge and the output's last lines (Codex text or `{exitCode, stdout, stderr}`). */
export function terminalCard(command: string, output: string, status: Tool['status']): string {
  const { code, body } = exitCode(output);
  const failed = code !== undefined ? code !== 0 : status === 'failed';
  const pill = code !== undefined || status === 'failed'
    ? `<span class="tool-trace-badge${failed ? ' is-failed' : ''}">${escape(code !== undefined ? `exit ${code}` : 'failed')}</span>` : '';
  const all = lines(body.trimEnd());
  if (!command) return '';
  if (status === 'completed' && !all.length && !pill && command.length <= 120) return COMPLETE;
  const partial = all.length > PREVIEW_LINES ? PARTIAL : '';
  return `${partial || command.length > 400 ? PARTIAL : ''}${head(`<code class="tool-trace-command">${escape(clip(command, 400))}</code>${pill}`)}${linesPre(all.slice(-PREVIEW_LINES), 'Command output, last lines')}`;
}

function fileCard(path: string, meta: string, preview: string[], partial = false): string {
  return path ? `${partial ? PARTIAL : ''}${head(`<span class="tool-trace-chip" title="${escape(path)}">${icon('file')}<b>${escape(basename(path))}</b></span>`, meta)}${linesPre(preview, 'File preview')}` : '';
}

function diffCard(tool: Tool, fields: Fields): string {
  const rows: string[] = [];
  for (const edit of editLines(fields)) {
    for (const line of lines(edit.old)) rows.push(`<del>- ${escape(line.slice(0, 300))}</del>`);
    for (const line of lines(edit.new)) rows.push(`<ins>+ ${escape(line.slice(0, 300))}</ins>`);
  }
  const { added, removed } = diffCounts(fields);
  const shown = rows.slice(0, DIFF_LINES).join('\n');
  const clipped = rows.length > DIFF_LINES || editLines(fields).some(edit => lines(edit.old + '\n' + edit.new).some(line => line.length > 300));
  const more = rows.length > DIFF_LINES ? `<p class="tool-trace-more">+${rows.length - DIFF_LINES} more lines</p>` : '';
  const path = field(fields, 'file_path', 'path', 'filePath', 'target_file');
  return (clipped ? PARTIAL : '') + (path ? fileCard(path, `+${added} −${removed}`, []) : '') + (shown ? `<pre class="tool-trace-diff" tabindex="0" aria-label="Edit preview">${shown}</pre>${more}` : '');
}

export function searchCard(output: string): string {
  const found = lines(output).map(line => line.trim()).filter(line => line && !/^Found \d+ (files?|matches?)/i.test(line) && !/^No (files|matches) found/i.test(line));
  if (!found.length) return output.trim() ? `${output.trim().length > 200 ? PARTIAL : ''}<p class="tool-trace-note">${escape(clip(output, 200))}</p>` : '';
  return list(found.slice(0, LIST_ITEMS).map(line => {
    const [path, ...match] = line.split(':');
    const lineNo = match.length && /^\d+$/.test(match[0] ?? '') ? match[0] : '';
    const meta = lineNo ? match.slice(1).join(':') : match.join(':');
    return { title: basename(path) + (lineNo ? `:${lineNo}` : ''), meta: [path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', meta.trim()].filter(Boolean).join(' · '), hint: line };
  }), found.length);
}

function webResults(output: string): { title: string; url: string }[] {
  const at = output.indexOf('Links:');
  if (at < 0) return [];
  const start = output.indexOf('[', at);
  const end = output.indexOf(']\n', start) > 0 ? output.indexOf(']\n', start) + 1 : output.lastIndexOf(']') + 1;
  try {
    const value: unknown = JSON.parse(output.slice(start, end));
    return Array.isArray(value) ? value.filter((item): item is { title: string; url: string } => typeof item?.title === 'string' && typeof item?.url === 'string') : [];
  } catch { return []; }
}

function webCard(output: string): string {
  const results = webResults(output);
  // The search summary after the links is not shown.
  if (results.length) return PARTIAL + list(results.map(result => ({ title: result.title, meta: domain(result.url), hint: result.url })), results.length);
  return excerptCard(output);
}

function fetchCard(fields: Fields, output: string): string {
  const url = field(fields, 'url');
  const prompt = field(fields, 'prompt');
  const top = url ? head(`<span class="tool-trace-chip" title="${escape(url)}">${icon('globe')}<b>${escape(domain(url))}</b></span>`) : '';
  return (output.length > 600 || prompt.length > 240 ? PARTIAL : '') + top + (prompt ? `<p class="tool-trace-prompt">${escape(clip(prompt, 240))}</p>` : '') + (output.trim() ? `<p class="tool-trace-note">${escape(clip(output, 600))}</p>` : '');
}

function todoCard(fields: Fields): string {
  const todos = (Array.isArray(fields.todos) ? fields.todos : Array.isArray(fields.plan) ? fields.plan : []) as Fields[];
  const items = todos.filter(todo => todo && typeof todo === 'object').slice(0, 12).map(todo => {
    const status = field(todo, 'status');
    return `<li data-status="${escape(status)}">${icon(status === 'completed' ? 'check' : status === 'in_progress' ? 'activity' : 'circle')}<span>${escape(clip(field(todo, 'content', 'step', 'title'), 160))}</span></li>`;
  }).join('');
  const clipped = todos.length > 12 || todos.some(todo => todo && typeof todo === 'object' && field(todo, 'content', 'step', 'title').length > 160);
  return items ? `${clipped ? PARTIAL : ''}<ul class="tool-trace-todos">${items}</ul>` : '';
}

/** Marks a card that shows less than the record, so the row keeps its `Full tool data` disclosure. */
export const PARTIAL = '<!--trace-partial-->';
/** A deliberately empty card: the row already says everything, so there is nothing to expand. */
export const COMPLETE = '<!--trace-complete-->';
export function excerptCard(output: string): string {
  const all = lines(output.trim());
  const pre = linesPre(all.slice(0, PREVIEW_LINES), 'Result preview');
  return pre && all.length > PREVIEW_LINES ? PARTIAL + pre : pre;
}

/** One short value: strings clipped, arrays and objects summarized, never raw nested JSON. */
export function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return clip(value, 120) || '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.length && value.every(item => typeof item === 'string' || typeof item === 'number')
      ? clip(value.join(', '), 120) : `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  }
  const keys = Object.keys(value as object);
  return `{ ${clip(keys.join(', '), 100)} }`;
}

/** Compact key/value table for arguments and JSON results. */
export function kvTable(fields: Fields, label: string, limit = 8): string {
  const entries = Object.entries(fields).filter(([key, value]) => !key.startsWith('_') && value !== undefined && value !== '');
  if (!entries.length) return '';
  const rows = entries.slice(0, limit).map(([key, value]) => `<dt>${escape(clip(key, 40))}</dt><dd>${escape(summarizeValue(value))}</dd>`).join('');
  const more = entries.length > limit ? `<dt class="tool-trace-more">+${entries.length - limit} more</dt><dd></dd>` : '';
  const partial = entries.length > limit || entries.some(([, value]) => value !== null && typeof value === 'object' || typeof value === 'string' && value.length > 120);
  return `${partial ? PARTIAL : ''}<dl class="tool-trace-kv" aria-label="${escape(label)}">${rows}${more}</dl>`;
}

/** A JSON object as a key table, an array as a list, anything else as a text excerpt. */
function isRecord(value: unknown): value is Fields { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
const TITLE_KEYS = ['name', 'title', 'label', 'summary', 'id'];
/** One generic JSON object as a list row: its best title, then up to two other short scalars. */
function objectItem(item: Fields): ListItem {
  const key = TITLE_KEYS.find(k => typeof item[k] === 'string' && item[k]);
  const meta = Object.entries(item).filter(([k, v]) => k !== key && (typeof v === 'string' && v.length <= 80 || typeof v === 'number'))
    .slice(0, 2).map(([k, v]) => k === 'number' || k === 'id' ? `#${v}` : String(v));
  return { title: key ? String(item[key]) : summarizeValue(item), meta: meta.join(' · ') };
}
function itemList(values: unknown[]): string {
  return list(values.slice(0, LIST_ITEMS).map(item => isRecord(item) ? objectItem(item) : { title: summarizeValue(item) }), values.length);
}
/** A JSON object as a key table (arrays of objects as short item lists), an array as a list, anything else as a text excerpt. */
export function resultCard(output: string): string {
  const json = parseJson(output);
  if (Array.isArray(json)) return PARTIAL + itemList(json);
  if (!isRecord(json)) return excerptCard(output);
  const lists = Object.entries(json).filter(([, v]) => Array.isArray(v) && v.length && v.some(isRecord));
  const scalars = Object.fromEntries(Object.entries(json).filter(([k]) => !lists.some(([l]) => l === k)));
  return kvTable(scalars, 'Result') + (lists.length ? PARTIAL : '') + lists.map(([key, values]) => section(key.replace(/_/g, ' '), itemList(values as unknown[]))).join('');
}

export function section(label: string, body: string): string {
  return body ? `<section class="tool-trace-section"><h5 class="tool-trace-label">${escape(label)}</h5>${body}</section>` : '';
}

function mcpCard(tool: Tool, fields: Fields, output: string): string {
  const own = pandacodeTool(tool.name);
  if (own) return pandacodeCard(own, fields, output, tool.status) ?? section('Result', resultCard(output));
  const failed = tool.status === 'failed' && output.trim() && parseJson(output) === undefined;
  return section('Arguments', kvTable(fields, 'Arguments')) + (failed ? `${output.length > 400 ? PARTIAL : ''}<p class="tool-trace-note is-error">${escape(clip(output, 400))}</p>` : section('Result', resultCard(output)));
}

function agentCard(tool: Tool, fields: Fields, output: string): string {
  const prompt = field(fields, 'prompt', 'message', 'objective', 'description') || (tool.input.trim().startsWith('{') ? '' : tool.input);
  const model = field(fields, 'model');
  const clipped = prompt.length > 400 || output.length > 600 ? PARTIAL : '';
  // Running: one compact line of model, state and prompt. Finished: the result first, the prompt one click away.
  if (tool.status === 'running') {
    // The row already shows the description; only the model adds anything while it runs.
    return model ? head(`<span class="tool-trace-route">${escape(clip(model, 40))}</span>${badge('running')}`) : '';
  }
  const top = model ? head(`<span class="tool-trace-route">${escape(clip(model, 40))}</span>`) : '';
  const result = output.trim()
    ? tool.status === 'failed' ? `<p class="tool-trace-note is-error">${escape(clipText(output, 600))}</p>` : `<p class="tool-trace-prose">${escape(clipText(output, 600))}</p>`
    : '';
  const promptBox = prompt ? `<details class="tool-trace-aside"><summary>${icon('chevron')}Prompt</summary><p class="tool-trace-prompt">${escape(clipText(prompt, 400))}</p></details>` : '';
  return clipped + top + result + promptBox;
}

function previewBody(kind: TraceKind, tool: Tool, fields: Fields, output: string): string {
  switch (kind) {
    case 'shell': return shellCard(tool, fields);
    case 'read': {
      const path = filePath(tool.input, fields);
      const all = lines(output);
      return fileCard(path, all.length ? `${all.length} ${all.length === 1 ? 'line' : 'lines'}` : '', all.slice(0, PREVIEW_LINES), all.length > PREVIEW_LINES);
    }
    case 'write': {
      const content = lines(field(fields, 'content', 'contents'));
      return fileCard(field(fields, 'file_path', 'path', 'filePath'), `New file · ${content.length} lines`, content.slice(0, PREVIEW_LINES), content.length > PREVIEW_LINES);
    }
    case 'edit': return diffCard(tool, fields);
    case 'search': return searchCard(output);
    case 'web': return webCard(output);
    case 'fetch': return fetchCard(fields, output);
    case 'todo': return todoCard(fields);
    case 'agent': return agentCard(tool, fields, output);
    case 'mcp': return mcpCard(tool, fields, output);
    default: return excerptCard(output);
  }
}

/** Structured, escaped result card for an expanded row; empty when there is nothing better than the raw record. */
export function toolPreview(tool: Tool): string {
  const kind = toolKind(tool.name);
  const body = previewBody(kind, tool, parseFields(tool.input), cleanOutput(tool.output));
  return card(kind, body && tool.output.length > MAX_SCAN ? PARTIAL + body : body);
}
