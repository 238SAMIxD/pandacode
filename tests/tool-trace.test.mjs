import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTool, summaryIcons, summarizeTools, toolPreview, traceRowHtml, shellCommand, toolKind } from '../src/tool-trace.ts';

const tool = (name, input, extra = {}) => ({ name, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input), output: '', ...extra });

test('describes each kind as a verb, chip and object', () => {
  const cases = [
    [tool('Bash', { command: 'npm test -- --runInBand' }), 'shell', 'Ran', 'npm', 'test -- --runInBand'],
    [tool('Command', '/bin/zsh -lc "git status --short"\nWorking directory: /repo'), 'shell', 'Ran', 'git', 'status --short'],
    [tool('pandacode_vm_exec', { name: 'vm', command: 'uname -a' }), 'shell', 'Ran', 'uname', '-a · on vm'],
    [tool('Read', { file_path: '/repo/src/main.ts' }), 'read', 'Read', 'main.ts', ''],
    [tool('read', { path: 'src/dom.ts' }), 'read', 'Read', 'dom.ts', ''],
    [tool('Write', { file_path: 'a/b.md', content: 'one\ntwo' }), 'write', 'Wrote', 'b.md', '2 lines'],
    [tool('Grep', { pattern: 'icon\\(', path: 'src' }), 'search', 'Searched', 'src', 'for icon\\('],
    [tool('Glob', { pattern: '**/*.ts' }), 'search', 'Searched', 'workspace', 'for files matching **/*.ts'],
    [tool('WebSearch', { query: 'tauri updater' }), 'web', 'Searched', 'Web', 'for tauri updater'],
    [tool('WebFetch', { url: 'https://www.example.com/a', prompt: 'Summarize' }), 'fetch', 'Fetched', 'example.com', 'Summarize'],
    [tool('TodoWrite', { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] }), 'todo', 'Updated', undefined, 'the plan · 2 steps'],
    [tool('Task', { description: 'Find callers', subagent_type: 'Explore' }), 'agent', 'Started', 'Explore', 'Find callers'],
    [tool('Skill', { skill: 'hyperframes' }), 'skill', 'Loaded skill', 'hyperframes', ''],
    [tool('mcp__github__list_issues', {}), 'mcp', 'Used', 'github', 'list issues'],
    [tool('pandacode_dispatch_workers', { workers: [{}, {}] }), 'mcp', 'Dispatched', undefined, '2 workers'],
    [tool('pandacode_architect_pandacode_title', { title: 'Traces' }), 'mcp', 'Named', undefined, 'the task “Traces”'],
    [tool('docs · search', { query: 'x' }), 'mcp', 'Used', 'docs', 'search'],
    [tool('pandacode_mystery_tool', {}), 'mcp', 'Used', 'PandaCode', 'mystery tool'],
    [tool('Frobnicate', { path: 'x/y' }), 'tool', 'Used', 'Frobnicate', 'x/y'],
  ];
  for (const [input, kind, verb, chip, object] of cases) {
    const trace = describeTool(input);
    assert.equal(trace.kind, kind, input.name);
    assert.equal(trace.verb, verb, input.name);
    assert.equal(trace.chip?.label, chip, input.name);
    assert.equal(trace.object, object, input.name);
  }
  const edit = describeTool(tool('Edit', { file_path: 'src/x.ts', old_string: 'a', new_string: 'b\nc' }));
  assert.deepEqual([edit.kind, edit.verb, edit.chip.label, edit.chip.title, edit.added, edit.removed], ['edit', 'Edited', 'x.ts', 'src/x.ts', 2, 1]);
  const multi = describeTool(tool('edit', { path: 'y.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c\nd', newText: '' }] }));
  assert.deepEqual([multi.added, multi.removed], [1, 3]);
  assert.equal(shellCommand("bash -lc 'ls -la'", {}), 'ls -la');
  assert.equal(toolKind('MultiEdit'), 'edit');
});

test('running calls use present tense', () => {
  assert.equal(describeTool(tool('Bash', { command: 'ls' }, { status: 'running' })).verb, 'Running');
  assert.equal(describeTool(tool('Read', { file_path: 'a' }, { status: 'running' })).verb, 'Reading');
  assert.equal(describeTool(tool('WebSearch', { query: 'q' }, { status: 'running' })).verb, 'Searching');
  assert.equal(describeTool(tool('Read', { file_path: 'a' }, { status: 'failed' })).verb, "Couldn't read");
});

test('summaries pluralise, merge verbs and report running and failures', () => {
  const bash = tool('Bash', { command: 'ls' }), read = tool('Read', { file_path: 'a' });
  assert.equal(summarizeTools([bash, bash, bash, read, read, tool('Edit', {})]), 'Ran 3 commands, read 2 files +1 more');
  assert.equal(summarizeTools([tool('Grep', {}), tool('WebSearch', {}), read, read, read]), 'Ran 2 searches, read 3 files');
  assert.equal(summarizeTools([{ ...bash, status: 'running' }, { ...bash, status: 'running' }]), 'Running 2 commands…');
  assert.equal(summarizeTools([bash, { ...read, status: 'failed' }]), 'Ran 1 command · 1 failed');
  assert.equal(summarizeTools([{ ...read, status: 'failed' }, { ...bash, status: 'failed' }]), "Couldn't read 1 file, couldn't run 1 command · 2 failed");
  assert.equal(summarizeTools([bash, { ...bash, status: 'running' }, { ...read, status: 'failed' }]), 'Ran 1 command · 1 running · 1 failed');
  assert.equal(summarizeTools([undefined]), 'Used 1 tool');
  assert.equal(summarizeTools([tool('TodoWrite', {})]), 'Updated the plan');
});

test('cards show structured results', () => {
  const shell = toolPreview(tool('Command', 'ls', { output: 'Exit code: 2\nWall time: 1s\nOutput:\n' + Array.from({ length: 20 }, (_, i) => 'line ' + i).join('\n') }));
  assert.match(shell, /tool-trace-badge is-failed">exit 2</);
  assert.match(shell, /line 19/);
  assert.ok(!shell.includes('line 11\n'));
  const vm = toolPreview(tool('pandacode_vm_exec', { command: 'echo hi' }, { output: '{"exitCode":0,"stdout":"hi","stderr":""}' }));
  assert.match(vm, /tool-trace-badge">exit 0</);
  const read = toolPreview(tool('Read', 'src/a.ts', { output: 'one\ntwo\nthree' }));
  assert.match(read, /<b>a.ts<\/b>/);
  assert.match(read, /3 lines/);
  assert.match(toolPreview(tool('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' })), /<del>- x<\/del>\n<ins>\+ y<\/ins>/);
  const grep = toolPreview(tool('Grep', { pattern: 'x' }, { output: 'Found 8 files\n' + Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`).join('\n') }));
  assert.match(grep, /tool-trace-item-title" title="src\/f0.ts">f0.ts</);
  assert.match(grep, /\+2 more/);
  const web = toolPreview(tool('WebSearch', { query: 'q' }, { output: 'Web search results for query: "q"\n\nLinks: [{"title":"Docs","url":"https://docs.example.com/x"}]\n\nSummary' }));
  assert.match(web, /Docs<\/span><span class="tool-trace-item-meta">docs.example.com</);
  assert.match(toolPreview(tool('TodoWrite', { todos: [{ content: 'Ship', status: 'completed' }] })), /data-status="completed"/);
  assert.equal(toolPreview(tool('Read', 'a', { output: '[Non-text content omitted]' })).includes('Non-text'), false);
});

test('chips, objects and cards escape tool data', () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const html = traceRowHtml(describeTool(tool(unsafe, { path: unsafe })))
    + traceRowHtml(describeTool(tool('Read', { file_path: `/a/${unsafe}"` })))
    + toolPreview(tool('Bash', { command: unsafe }, { output: unsafe }))
    + toolPreview(tool('WebSearch', {}, { output: `Links: [{"title":"${unsafe.replace(/"/g, '')}","url":"javascript:${unsafe}"}]` }))
    + toolPreview(tool('Grep', {}, { output: unsafe }))
    + toolPreview(tool('TodoWrite', { todos: [{ content: unsafe, status: '"><b>' }] }));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('"><b>'));
  assert.match(html, /&lt;img/);
});

import { pandacodeTool, PANDACODE_TOOLS } from '../src/tool-trace-pandacode.ts';
import { renderToolActivity } from '../src/tool-activity.ts';

test('PandaCode tool names normalize across harness spellings', () => {
  for (const name of ['pandacode_send_team_message', 'mcp__pandacode_architect__pandacode_send_team_message', 'mcp__pandacode__send_team_message',
    'pandacode_architect_pandacode_send_team_message', 'pandacode_architect · pandacode_send_team_message', 'pandacode_architect.pandacode_send_team_message']) {
    assert.equal(pandacodeTool(name), 'send_team_message', name);
  }
  assert.equal(pandacodeTool('mcp__github__list_issues'), undefined);
  assert.equal(pandacodeTool('Bash'), undefined);
  assert.equal(toolKind('mcp__pandacode_architect__pandacode_vm_exec'), 'shell');
  assert.equal(describeTool(tool('mcp__pandacode_architect__pandacode_vm_exec', { command: 'ls' })).family, 'vm');
});

test('every PandaCode tool gets a specific verb, icon and family', () => {
  for (const name of PANDACODE_TOOLS) {
    const trace = describeTool(tool('pandacode_' + name, {}));
    assert.notEqual(trace.verb, 'Used', name);
    assert.ok(trace.family && trace.icon, name);
    assert.doesNotThrow(() => toolPreview(tool('pandacode_' + name, {}, { output: '{"a":1}' })), name);
    assert.doesNotThrow(() => toolPreview(tool('pandacode_' + name, '{', { output: 'not json', status: 'failed' })), name);
  }
});

test('PandaCode rows read as sentences', () => {
  const row = (name, input, output = '', status = 'completed') => {
    const t = describeTool({ name, input: JSON.stringify(input), output, status });
    return [t.verb, t.chip?.label, t.object].filter(Boolean).join(' ');
  };
  assert.equal(row('mcp__pandacode_architect__pandacode_dispatch_workers', { assignments: [{}, {}, {}] }), 'Dispatched 3 workers');
  assert.equal(row('pandacode_send_team_message', { recipient: 'worker-2', message: 'hi' }), 'Sent message to worker-2');
  assert.equal(row('pandacode_vm_screenshot', { name: 'macos-vm' }), 'Took screenshot of macos-vm');
  assert.equal(row('pandacode_vm_screenshot', { name: 'macos-vm' }, '', 'running'), 'Taking screenshot of macos-vm');
  assert.equal(row('pandacode_design_write', { name: 'Login.html', html: '<p>\n</p>' }), 'Wrote artboard Login 2 lines');
  assert.equal(row('pandacode_cloud_cli', { tool: 'wrangler', args: 'deploy' }), 'Ran wrangler deploy');
  assert.equal(row('pandacode_open_browser', { url: 'http://127.0.0.1:1420/' }), 'Opened preview :1420');
  assert.equal(row('pandacode_open_browser', { url: 'https://example.com/x' }), 'Opened example.com');
  assert.equal(row('pandacode_vm_control', { name: 'vm', action: 'click', x: 4, y: 5 }), 'Clicked vm at (4, 5)');
  assert.equal(row('pandacode_simulator_control', { action: 'type', text: 'hello' }), 'Typed Simulator “hello”');
  assert.equal(row('pandacode_vm_manage', { action: 'create', name: 'box', image: 'ubuntu' }), 'Created box from ubuntu');
  assert.equal(row('pandacode_vm_manage', { action: 'create', name: 'fedora-box', image: 'fedora' }, 'No disk', 'failed'), "Couldn't create fedora-box from fedora");
  assert.equal(row('pandacode_track_files', { action: 'complete', paths: ['a', 'b', 'c'] }), 'Tracked 3 files');
  assert.equal(row('pandacode_track_files', { action: 'begin', paths: ['a'] }, '', 'running'), 'Tracking changes to 1 file');
  assert.equal(row('pandacode_pin_task', { taskId: 'abc', pinned: false }), 'Unpinned abc');
  assert.equal(row('pandacode_track_files', { action: 'begin', paths: ['a', 'b'] }), 'Tracking changes to 2 files');
  assert.equal(row('pandacode_code_search', { query: 'icon(' }), 'Searched code for icon(');
  assert.equal(row('pandacode_read_team_mailbox', {}, '{"messages":[{"message":"x"}]}'), 'Checked mailbox · 1 message');
  assert.equal(row('Task', { subagent_type: 'Explore', description: 'Find callers' }), 'Started Explore Find callers');
  assert.equal(summaryIcons([tool('pandacode_vm_list', {}), tool('pandacode_design_list', {})]).join(), 'monitor,sketch');
});

test('PandaCode cards show rosters, bubbles, terminals and lists', () => {
  const dispatch = toolPreview(tool('pandacode_dispatch_workers', { assignments: [{ name: 'Tests', provider: 'codex', model: 'gpt-5', files: ['src/a.ts'], readOnly: true, prompt: 'Write tests' }] }, { output: '{"workerIds":[{"workerId":"w1","status":"running"}],"queued":true}' }));
  assert.match(dispatch, /tool-trace-roster/);
  assert.match(dispatch, /codex · gpt-5/);
  assert.match(dispatch, /read-only/);
  assert.match(dispatch, /<code title="src\/a.ts">src\/a.ts<\/code>/);
  assert.match(dispatch, /tool-trace-badge is-live">running</);
  const mail = toolPreview(tool('pandacode_read_team_mailbox', {}, { output: '{"messages":[{"sender":"architect","recipient":"w1","message":"Check scope","createdAt":1}]}' }));
  assert.match(mail, /tool-trace-bubble/);
  assert.match(mail, /Check scope/);
  const cli = toolPreview(tool('pandacode_cloud_cli', { tool: 'wrangler', args: 'deploy' }, { output: '{"exitCode":1,"stdout":"","stderr":"boom"}' }));
  assert.match(cli, /wrangler deploy/);
  assert.match(cli, /is-failed">exit 1</);
  const vms = toolPreview(tool('pandacode_vm_list', {}, { output: '{"vms":[{"name":"macos-vm","running":true,"diskGb":50}],"cloud":[{"id":"daytona:1","name":"sb","provider":"daytona","state":"stopped"}]}' }));
  assert.match(vms, /macos-vm/);
  assert.match(vms, /is-quiet">stopped</);
  assert.match(toolPreview(tool('pandacode_finish_team', { summary: 'All done' })), /tool-trace-prose">All done</);
  assert.match(toolPreview(tool('pandacode_code_search', { query: 'x' }, { output: '{"results":"src/a.ts:3:x"}' })), /a.ts/);
  assert.match(toolPreview(tool('pandacode_vm_list', {}, { output: 'Tart missing', status: 'failed' })), /is-error">Tart missing</);
  const mcp = toolPreview(tool('mcp__github__list_issues', { repo: 'a/b', labels: ['x', 'y'], filter: { state: 'open' } }, { output: '{"total":2,"items":[1,2]}' }));
  assert.match(mcp, /<dt>repo<\/dt><dd>a\/b<\/dd>/);
  assert.match(mcp, /<dd>x, y<\/dd>/);
  assert.match(mcp, /<dd>\{ state \}<\/dd>/);
  assert.match(mcp, /<dt>items<\/dt><dd>1, 2<\/dd>/);
  const agent = toolPreview(tool('Task', { subagent_type: 'Explore', prompt: 'Find callers' }, { output: 'Found 3' }));
  assert.match(agent, /Find callers/);
  assert.match(agent, /Found 3/);
  const row = renderToolActivity({ id: '1', name: 'pandacode_vm_list', status: 'completed', input: '{}', output: '' }, 'k');
  assert.match(row, /data-tool-family="vm"/);
});

test('PandaCode cards escape tool data', () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const html = [
    tool('pandacode_dispatch_workers', { assignments: [{ name: unsafe, model: unsafe, files: [unsafe], prompt: unsafe }] }, { output: JSON.stringify({ workerIds: [{ status: unsafe }], note: unsafe }) }),
    tool('pandacode_read_team_mailbox', {}, { output: JSON.stringify({ messages: [{ sender: unsafe, recipient: unsafe, message: unsafe }] }) }),
    tool('pandacode_send_team_message', { recipient: unsafe, message: unsafe }),
    tool('pandacode_list_tasks', {}, { output: JSON.stringify({ tasks: [{ id: unsafe, title: unsafe, stage: unsafe }] }) }),
    tool('pandacode_design_write', { name: unsafe, html: `<title>${unsafe}</title>` }),
    tool('pandacode_cloud_cli', { tool: unsafe, args: unsafe }, { output: JSON.stringify({ exitCode: 0, stdout: unsafe }) }),
    tool('pandacode_open_browser', { url: `javascript:${unsafe}` }, { output: JSON.stringify({ url: unsafe, title: unsafe, text: unsafe }) }),
    tool('pandacode_vm_list', {}, { output: unsafe, status: 'failed' }),
    tool(`mcp__${unsafe}__${unsafe}`, { [unsafe]: unsafe }, { output: JSON.stringify({ [unsafe]: unsafe }) }),
    tool('Task', { subagent_type: unsafe, prompt: unsafe }, { output: unsafe }),
  ].map(t => toolPreview(t) + traceRowHtml(describeTool(t)) + renderToolActivity({ id: '1', ...t }, 'k')).join('');
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
});

import { failedVerb } from '../src/tool-trace.ts';

test('failed rows lead with the failure', () => {
  const cases = { 'Creating task': "Couldn't create task", Running: "Couldn't run", 'Taking screenshot of': "Couldn't take screenshot of", 'Double-clicking': "Couldn't double-click",
    Cancelling: "Couldn't cancel", Controlling: "Couldn't control", Dragging: "Couldn't drag", Installing: "Couldn't install", 'Shutting down': "Couldn't shut down",
    'Queuing message for': "Couldn't queue message for", 'Going back': "Couldn't go back", Using: "Couldn't use", 'Messaging the user': "Couldn't message the user", Pressing: "Couldn't press" };
  for (const [running, failed] of Object.entries(cases)) assert.equal(failedVerb(running), failed);
  for (const name of PANDACODE_TOOLS) assert.match(describeTool(tool('pandacode_' + name, {}, { status: 'failed' })).verb, /^Couldn't [a-z]/, name);
  const html = renderToolActivity({ id: '1', name: 'pandacode_vm_manage', status: 'failed', input: '{"action":"create","name":"x"}', output: 'No disk' }, 'k');
  assert.ok(!html.includes('tool-activity-status'));
  assert.match(html, /is-error">No disk</);
});

test('badges separate success, running, neutral and failure', () => {
  const html = toolPreview(tool('pandacode_list_tasks', {}, { output: JSON.stringify({ tasks: ['completed', 'running', 'queued', 'failed', 'stopped'].map((status, i) => ({ id: String(i), title: 't', status })) }) }));
  assert.match(html, /tool-trace-badge">completed</);
  assert.match(html, /is-live">running</);
  assert.match(html, /is-quiet">queued</);
  assert.match(html, /is-failed">failed</);
  assert.match(html, /is-quiet">stopped</);
});

test('cards do not repeat the row, and full data appears only when the card is partial', () => {
  const card = (name, input, output = '') => toolPreview(tool(name, input, { output }));
  assert.equal(card('pandacode_vm_control', { name: 'vm', action: 'click', x: 1, y: 2 }), '');
  assert.match(card('pandacode_vm_control', { name: 'vm', action: 'scroll', direction: 'down', amount: 5 }), /<dt>amount<\/dt><dd>5<\/dd>/);
  assert.ok(!card('pandacode_vm_control', { name: 'vm', action: 'scroll', direction: 'down', amount: 5 }).includes('<dt>direction'));
  assert.equal(card('pandacode_bot_remember', { content: 'short' }), '');
  assert.equal(card('pandacode_bot_notify', { text: 'short' }), '');
  assert.ok(!card('pandacode_bot_schedule', { title: 'Digest', prompt: 'Summarize', kind: 'daily', timeOfDay: '08:00' }).includes('<dt>kind'));
  assert.equal(card('pandacode_vm_screenshot', { name: 'vm' }), '');
  assert.ok(!card('pandacode_track_files', { paths: ['a'] }, '{"captureId":"cap-1"}').includes('Capture cap-1'));
  const mcp = card('mcp__github__list_issues', { repo: 'a/b' }, '{"total":1}');
  assert.ok(!mcp.includes('tool-trace-chip'));
  assert.match(mcp, /<h5 class="tool-trace-label">Arguments<\/h5>/);
  assert.ok(!card('Task', { subagent_type: 'Explore', prompt: 'p' }, 'r').includes('tool-trace-chip'));
  const activity = (name, input, output) => renderToolActivity({ id: '1', name, status: 'completed', input: JSON.stringify(input), output }, 'k');
  assert.ok(!activity('pandacode_vm_list', {}, '{"vms":[]}').includes('tool-trace-raw'));
  assert.match(activity('mcp__x__y', {}, 'line\n'.repeat(20)), /Full tool data/);
  assert.ok(!activity('Bash', { command: 'ls' }, 'a').includes('Full tool data'));
  assert.match(activity('Bash', { command: 'ls' }, 'line\n'.repeat(20)), /Full tool data/);
  assert.match(activity('Read', { file_path: 'a' }, 'x\n'.repeat(20)), /Full tool data/);
  assert.ok(!activity('Read', { file_path: 'a' }, 'one\ntwo').includes('Full tool data'));
  assert.match(activity('pandacode_open_terminal', {}, ''), /data-static><div class="tool-trace-summary"/);
  assert.ok(!activity('pandacode_open_terminal', {}, '').includes('<details'));
  assert.ok(!renderToolActivity({ id: '1', name: 'Bash', status: 'running', input: '{"command":"ls"}', output: '' }, 'k').includes('Waiting for output'));
  assert.match(toolPreview(tool('pandacode_vm_screenshot', { name: 'vm' }, { output: 'Screenshot 1280×800' })), /^<p data-trace-kind="mcp" class="tool-trace-inline tool-trace-note">Screenshot 1280×800<\/p>$/);
  assert.equal(card('pandacode_set_task_stage', { taskId: 't', stage: 'review' }, '{"id":"t","title":"T","stage":"review"}'), '<!--trace-complete-->');
  assert.match(activity('pandacode_set_task_stage', { taskId: 't', stage: 'review' }, '{"id":"t","title":"T","stage":"review"}'), /data-static/);
  const one = card('pandacode_create_task', { title: 'T', description: 'Do it' }, '{"id":"t","title":"T","description":"Do it"}');
  assert.equal(one.match(/Do it/g)?.length, 1);
  assert.ok(!activity('pandacode_open_terminal', {}, '').includes('No output was returned'));
  assert.ok(!activity('Bash', { command: 'true' }, '').includes('No output was returned'));
});

test('summaries keep finished work in past tense, name PandaCode families and count nonzero exits', () => {
  const bash = tool('Bash', { command: 'ls' });
  assert.equal(summarizeTools([bash, { ...bash, status: 'running' }]), 'Ran 1 command · 1 running');
  assert.equal(summarizeTools([tool('pandacode_send_team_message', {}), tool('pandacode_read_team_mailbox', {}), tool('pandacode_vm_list', {})]), 'Coordinated 2 team steps, operated 1 VM action');
  assert.equal(summarizeTools([tool('pandacode_cloud_cli', {}), bash]), 'Ran 1 cloud command and 1 command');
  const failing = tool('Bash', { command: 'npm test' }, { output: 'Exit code: 1\nOutput:\nfail' });
  assert.equal(summarizeTools([failing, bash]), 'Ran 1 command · 1 failed');
  const trace = describeTool(failing);
  assert.equal(trace.exit, 1);
  assert.match(traceRowHtml(trace), /is-failed">exit 1</);
  assert.match(renderToolActivity({ id: '1', ...failing }, 'k'), /data-tool-failed/);
  assert.ok(!renderToolActivity({ id: '1', ...bash, output: 'Exit code: 0\nOutput:\nok' }, 'k').includes('data-tool-failed'));
});

test('search keeps line numbers; generic arrays of objects become item lists; directory marks you', () => {
  assert.match(toolPreview(tool('Grep', { pattern: 'x' }, { output: 'src/a.ts:12:const x = 1' })), /a\.ts:12</);
  const mcp = toolPreview(tool('mcp__github__list_issues', {}, { output: JSON.stringify({ total: 2, items: [{ number: 812, title: 'Rows wrap' }, { number: 815, title: 'Dark chips' }] }) }));
  assert.match(mcp, /<h5 class="tool-trace-label">items<\/h5>/);
  assert.match(mcp, /Rows wrap<\/span><span class="tool-trace-item-meta">#812</);
  assert.ok(!mcp.includes('2 items'));
  const dir = toolPreview(tool('pandacode_team_directory', {}, { output: JSON.stringify({ you: 'w1', workers: [{ id: 'w1', name: 'Traces' }, { id: 'w2', name: 'Audit' }] }) }));
  assert.ok(!dir.includes('You are'));
  assert.match(dir, /Traces<\/b><span class="tool-trace-badge is-quiet">you</);
});

test('subagent cards: compact while running, result first with the prompt behind a disclosure', () => {
  const running = toolPreview(tool('Task', { subagent_type: 'Explore', prompt: 'Find callers' }, { status: 'running' }));
  assert.equal(running, '');
  const withModel = toolPreview(tool('Task', { subagent_type: 'Explore', prompt: 'Find callers', model: 'haiku' }, { status: 'running' }));
  assert.match(withModel, /haiku<\/span><span class="tool-trace-badge is-live">running</);
  assert.ok(!withModel.includes('Find callers'));
  const done = toolPreview(tool('Task', { subagent_type: 'Explore', prompt: 'Find callers' }, { output: 'Found 3' }));
  assert.ok(done.indexOf('Found 3') < done.indexOf('tool-trace-aside'));
  assert.match(done, /<details class="tool-trace-aside"><summary>.*Prompt<\/summary><p class="tool-trace-prompt">Find callers<\/p><\/details>/);
});

test('vm_exec rows name their machine; created tasks keep the input description', async () => {
  const { toolPreview } = await import('../src/tool-trace.ts');
  const vm = describeTool(tool('pandacode_vm_exec', { name: 'ubuntu-dev', command: 'uname -a' }));
  assert.equal(vm.object, '-a · on ubuntu-dev');
  const created = toolPreview(tool('pandacode_create_task', { title: 'Polish', description: 'Tighten the onboarding copy' }, { output: JSON.stringify({ task: { id: 't1', title: 'Polish' } }) }));
  assert.match(created, /Tighten the onboarding copy/);
});
