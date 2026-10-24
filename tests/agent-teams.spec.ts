import { expect, test, type Page } from '@playwright/test';

// Settings → Agent teams: the classic Team setup switch, and named agent teams that appear in the
// model picker and orchestrate only their own models.
const errors = new WeakMap<Page, string[]>();
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => (window as any).__agentTeams.calls.filter((entry: any) => entry.command === command), command);
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
const modelButton = (page: Page) => page.getByRole('button', { name: 'Choose harness and model', exact: true });

test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

async function install(page: Page): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      (window.__agentTeams ??= { calls: [] }).calls.push({ command, args: structuredClone(args) });
      if (command === 'list_provider_models') await window.__agentTeams.modelGate;
      if (command === 'architect_configure') {
        await window.__agentTeams.configureGate;
        if (window.__agentTeams.configureError) throw new Error(window.__agentTeams.configureError);
      }
      return invokePreview(command, args);
    }
    async function invokePreview(command, args) {`) + '\nwindow.__teamInvoke = invoke; window.__teamEmit = emit;\n' });
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
}

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agent teams', exact: true }).click();
}
async function closeSettings(page: Page): Promise<void> {
  await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings(page)).toBeHidden();
}

/** Builds a team from the first two listed models; the second one leads. */
async function createTeam(page: Page, name: string): Promise<{ lead: string; other: string }> {
  await settings(page).getByRole('button', { name: 'New team' }).click();
  await settings(page).getByRole('textbox', { name: 'Team name', exact: true }).fill(name);
  const boxes = settings(page).getByRole('group', { name: 'Team models' }).getByRole('checkbox');
  await expect(boxes.first()).toBeVisible();
  const [other, lead] = [(await boxes.nth(0).getAttribute('aria-label'))!.replace('Include ', ''), (await boxes.nth(1).getAttribute('aria-label'))!.replace('Include ', '')];
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await settings(page).getByRole('radio', { name: `${lead} leads`, exact: true }).check();
  await expect(settings(page).getByText('2 models', { exact: true })).toBeVisible();
  await settings(page).getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(settings(page).getByRole('listitem').filter({ hasText: name })).toBeVisible();
  return { lead, other };
}

test.describe('Agent teams', () => {
test('Team gives immediate feedback while cold model discovery and saving are pending', async ({ page }) => {
  await install(page);
  const team = page.getByRole('button', { name: 'Team', exact: true });
  const prompt = page.locator('#prompt');
  await prompt.fill('Review this project');
  const idleBackground = await team.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => {
    const state = (window as any).__agentTeams;
    state.modelGate = new Promise(resolve => { state.releaseModels = resolve; });
    state.configureGate = new Promise(resolve => { state.releaseConfigure = resolve; });
  });
  await team.click();
  await expect(team).toHaveAttribute('aria-busy', 'true', { timeout: 500 });
  await expect(team).toBeDisabled();
  expect(await team.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(idleBackground);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(modelButton(page)).toBeDisabled();
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('Review this project');
  expect(await calls(page, 'send_message')).toHaveLength(0);
  await expect.poll(async () => (await calls(page, 'list_provider_models')).length).toBeGreaterThan(0);
  expect(await calls(page, 'architect_configure')).toHaveLength(0);
  await page.mouse.move(0, 0);
  await expect(page.locator('.tip-bubble')).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('#composer').screenshot({ path: `test-results/team-toggle-pending-${theme}.png` });
  }
  await page.setViewportSize({ width: 600, height: 940 });
  await expect(team.locator('.support-spinner')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.evaluate(() => (window as any).__agentTeams.releaseModels());
  await expect.poll(async () => (await calls(page, 'architect_configure')).length).toBe(1);
  await expect(team).toHaveAttribute('aria-busy', 'true');
  await expect(team).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => (window as any).__agentTeams.releaseConfigure());
  await expect(team).toHaveAttribute('aria-busy', 'false');
  await expect(team).toHaveAttribute('aria-pressed', 'true');
  await expect(team).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(prompt).toHaveValue('Review this project');
  await team.click();
  await expect(team).toHaveAttribute('aria-pressed', 'false');
  await expect(team).toBeEnabled();
});

test('Team recovers from a failed save without changing its state or losing the prompt', async ({ page }) => {
  await install(page);
  const team = page.getByRole('button', { name: 'Team', exact: true });
  await page.locator('#prompt').fill('Keep this draft');
  for (const enabled of [false, true]) {
    await page.evaluate(() => { (window as any).__agentTeams.configureError = 'Team save failed'; });
    await team.click();
    await expect(page.getByRole('status')).toHaveText('Team save failed');
    await expect(team).toHaveAttribute('aria-busy', 'false');
    await expect(team).toHaveAttribute('aria-pressed', String(enabled));
    await expect(team).toBeEnabled();
    await expect(modelButton(page)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(page.locator('#prompt')).toHaveValue('Keep this draft');
    await page.evaluate(() => { delete (window as any).__agentTeams.configureError; });
    await team.click();
    await expect(team).toHaveAttribute('aria-pressed', String(!enabled));
    await expect(team).toBeEnabled();
  }
});

test('Team pending feedback belongs to its task and leaving cancels unsaved setup', async ({ page }) => {
  await install(page);
  const team = page.getByRole('button', { name: 'Team', exact: true });
  await page.locator('#prompt').fill('Draft for the first task');
  await page.evaluate(() => {
    const state = (window as any).__agentTeams;
    state.modelGate = new Promise(resolve => { state.releaseModels = resolve; });
  });
  await team.click();
  await expect(team).toHaveAttribute('aria-busy', 'true');
  await expect.poll(async () => (await calls(page, 'list_provider_models')).length).toBeGreaterThan(0);
  await page.locator('.task-item[data-id="session-3"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-3');
  await expect(team).toBeEnabled();
  await expect(team).toHaveAttribute('aria-busy', 'false');
  await page.locator('#prompt').fill('Draft for the other task');
  await page.evaluate(() => (window as any).__agentTeams.releaseModels());
  // A fresh toggle uses the settled catalog; only the current task may be configured.
  await team.click();
  await expect(team).toHaveAttribute('aria-pressed', 'true');
  await expect(team).toBeEnabled();
  const configured = await calls(page, 'architect_configure');
  expect(configured).toHaveLength(1);
  expect(configured[0].args.sessionId).toBe('session-3');
  await expect(page.locator('#prompt')).toHaveValue('Draft for the other task');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveValue('Draft for the first task');
  await expect(team).toHaveAttribute('aria-busy', 'false');
  await expect(team).toHaveAttribute('aria-pressed', 'false');
  await expect(team).toBeEnabled();
});

test('choosing a bot cannot release the pending Team lock', async ({ page }) => {
  await install(page);
  await page.evaluate(() => (window as any).__teamInvoke('bot_create', { input: {
    name: 'Test bot', role: 'Reviewer', instructions: 'Review code', provider: 'codex', model: '', mode: 'ask', heartbeatMinutes: 0,
  } }));
  const bot = page.getByRole('button', { name: 'Bot: No bot', exact: true });
  await expect(bot).toBeVisible();
  await page.locator('#prompt').fill('Do not send before Team is ready');
  await page.evaluate(() => {
    const state = (window as any).__agentTeams;
    state.modelGate = new Promise(resolve => { state.releaseModels = resolve; });
  });
  const team = page.getByRole('button', { name: 'Team', exact: true });
  await team.click();
  await expect(team).toHaveAttribute('aria-busy', 'true');
  await bot.click();
  await page.getByRole('menu', { name: 'Bot', exact: true }).getByRole('menuitemradio', { name: /Test bot/ }).click();
  await expect(bot).toBeVisible();
  await page.locator('#prompt').press('Enter');
  expect(await calls(page, 'send_message')).toHaveLength(0);
  await expect(page.locator('#prompt')).toHaveValue('Do not send before Team is ready');
  await page.evaluate(() => (window as any).__agentTeams.releaseModels());
  await expect(team).toHaveAttribute('aria-pressed', 'true');
  await expect(team).toBeEnabled();
});

test('Team releases queued follow-ups that arrived during setup', async ({ page }) => {
  await install(page);
  await page.evaluate(() => {
    const state = (window as any).__agentTeams;
    state.modelGate = new Promise(resolve => { state.releaseModels = resolve; });
  });
  const team = page.getByRole('button', { name: 'Team', exact: true });
  await team.click();
  await expect(team).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(async () => {
    const win = window as any;
    await win.__teamInvoke('queue_add', { sessionId: 'session-2', text: 'Follow up after setup', attachments: [] });
    win.__teamEmit('queue-changed', { sessionId: 'session-2' });
  });
  await expect(page.getByRole('region', { name: 'Queued messages', exact: true })).toBeVisible();
  expect(await calls(page, 'architect_start')).toHaveLength(0);
  await page.evaluate(() => (window as any).__agentTeams.releaseModels());
  await expect.poll(async () => (await calls(page, 'architect_start')).map(call => call.args.text)).toEqual(['Follow up after setup']);
  expect(await calls(page, 'send_message')).toHaveLength(0);
});

test('the classic team setup switch brings back Architect & workers', async ({ page }) => {
  await install(page);
  await expect(page.getByRole('button', { name: 'Team', exact: true })).toBeVisible();
  await openAgents(page);
  await settings(page).getByRole('checkbox', { name: 'Classic team setup', exact: true }).check();
  await closeSettings(page);
  const classic = page.getByRole('button', { name: 'Architect & workers', exact: true });
  await expect(classic).toBeVisible();
  await classic.click();
  await expect(page.getByRole('heading', { name: 'Architect & workers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose team profile', exact: true })).toBeVisible();
  // The choice survives a reload, and switching it off restores the automatic toggle.
  await page.reload();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.getByRole('button', { name: 'Architect & workers', exact: true })).toBeVisible();
  await openAgents(page);
  await settings(page).getByRole('checkbox', { name: 'Classic team setup', exact: true }).uncheck();
  await closeSettings(page);
  await expect(page.getByRole('button', { name: 'Team', exact: true })).toBeVisible();
});

test('a named agent team is a choice in the model picker and lists only its models', async ({ page }) => {
  await install(page);
  await openAgents(page);
  const { lead, other } = await createTeam(page, 'Reviewers');
  await expect(settings(page).getByRole('listitem').filter({ hasText: 'Reviewers' })).toContainText(`2 models · led by ${lead}`);
  await closeSettings(page);

  await modelButton(page).click();
  const team = picker(page).getByRole('button', { name: 'Agent team · Reviewers', exact: true });
  await expect(team).toBeVisible();
  await team.click();
  await expect(picker(page)).toBeHidden();
  const configured = (await calls(page, 'architect_configure')).at(-1).args;
  expect(configured.config).toMatchObject({ auto: true, rosterOnly: true, name: 'Reviewers' });
  expect(configured.config.workers.map((worker: any) => worker.name)).toEqual([other, lead]);
  const [leadWorker] = configured.config.workers.filter((worker: any) => worker.name === lead);
  expect(configured.architect).toMatchObject({ provider: leadWorker.provider, model: leadWorker.model });
  await expect(modelButton(page)).toContainText('Reviewers');
  await expect(modelButton(page)).toContainText('2 models');
  await expect(page.getByRole('button', { name: 'Team', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // The picker marks the team, not the lead's plain model, as current.
  await modelButton(page).click();
  await expect(picker(page).getByRole('button', { name: 'Agent team · Reviewers', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(picker(page).locator('[aria-current="true"]')).toHaveCount(1);
  // A plain model leaves the team for a single agent.
  await picker(page).locator('.model-menu-option:not(.model-menu-team):not([disabled])').first().click();
  await expect(picker(page)).toBeHidden();
  expect((await calls(page, 'architect_configure')).at(-1).args).toMatchObject({ config: null });
  await expect(page.getByRole('button', { name: 'Team', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(modelButton(page)).not.toContainText('Reviewers');
});

test('agent teams can be renamed, rechosen and deleted, and need a name and a model', async ({ page }) => {
  await install(page);
  await openAgents(page);
  await settings(page).getByRole('button', { name: 'New team' }).click();
  await settings(page).getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toHaveText('Give this team a name.');
  await settings(page).getByRole('textbox', { name: 'Team name', exact: true }).fill('Solo');
  await settings(page).getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(settings(page).getByRole('alert')).toHaveText('Choose at least one model for this team.');
  await settings(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  await createTeam(page, 'Builders');
  await settings(page).getByRole('button', { name: 'Edit Builders', exact: true }).click();
  const name = settings(page).getByRole('textbox', { name: 'Team name', exact: true });
  await expect(name).toHaveValue('Builders');
  await expect(settings(page).getByRole('group', { name: 'Team models' }).getByRole('checkbox', { checked: true })).toHaveCount(2);
  await name.fill('Shipping crew');
  await settings(page).getByRole('group', { name: 'Team models' }).getByRole('checkbox', { checked: true }).first().uncheck();
  await settings(page).getByRole('button', { name: 'Save team', exact: true }).click();
  const row = settings(page).getByRole('listitem').filter({ hasText: 'Shipping crew' });
  await expect(row).toContainText('1 model · led by');
  expect((await calls(page, 'architect_save_profile')).at(-1).args.setup.config.workers).toHaveLength(1);
  await settings(page).getByRole('button', { name: 'Delete Shipping crew', exact: true }).click();
  await expect(row).toBeHidden();
  expect((await calls(page, 'architect_profiles'))).not.toHaveLength(0);
  await closeSettings(page);
  await modelButton(page).click();
  await expect(picker(page).getByRole('button', { name: /^Agent team/ })).toHaveCount(0);
});

test('an agent team sets the lead effort apart from its workers', async ({ page }) => {
  await install(page);
  await openAgents(page);
  await settings(page).getByRole('button', { name: 'New team' }).click();
  await settings(page).getByRole('textbox', { name: 'Team name', exact: true }).fill('Deep');
  const models = settings(page).getByRole('group', { name: 'Team models' });
  const leadEffort = settings(page).getByRole('combobox', { name: 'Lead effort', exact: true });
  await models.getByRole('checkbox', { name: 'Include DeepSeek V4 Pro · DeepSeek', exact: true }).check();
  await models.getByRole('radio', { name: 'DeepSeek V4 Pro · DeepSeek leads', exact: true }).check();
  await expect(leadEffort).toBeVisible();
  await leadEffort.selectOption('max');
  await models.getByRole('combobox', { name: 'Worker effort for DeepSeek V4 Pro · DeepSeek', exact: true }).selectOption('low');
  // Models that advertise no efforts get no effort choice.
  await expect(models.locator('.agent-team-model').filter({ hasNot: page.locator('select') }).first()).toBeAttached();
  await settings(page).getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(settings(page).getByRole('listitem').filter({ hasText: 'Deep' })).toBeVisible();
  const { setup } = (await calls(page, 'architect_save_profile')).at(-1).args;
  expect(setup.architect).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'max' });
  expect(setup.config.workers).toEqual([expect.objectContaining({ model: 'deepseek-v4-pro', reasoningEffort: 'low' })]);
  // Editing shows the saved efforts again.
  await settings(page).getByRole('button', { name: 'Edit Deep', exact: true }).click();
  await expect(leadEffort).toHaveValue('max');
  await expect(models.getByRole('combobox', { name: 'Worker effort for DeepSeek V4 Pro · DeepSeek', exact: true })).toHaveValue('low');
});

test('team model names keep space beside lead and effort controls', async ({ page }) => {
  await install(page);
  await openAgents(page);
  await settings(page).getByRole('button', { name: 'New team' }).click();
  await settings(page).getByRole('searchbox', { name: 'Filter models' }).fill('Codex');
  const row = settings(page).locator('.agent-team-model').filter({ has: page.getByRole('checkbox', { name: 'Include GPT-6-Astra · Codex', exact: true }) });
  await expect(row).toBeVisible();
  const label = row.locator('label').first().locator('span');
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 940 });
    const size = await label.evaluate(el => ({ visible: el.clientWidth, full: el.scrollWidth }));
    expect(size.visible).toBeGreaterThan(0);
    expect(size.visible).toBeGreaterThanOrEqual(size.full);
  }
});

test('the model filter is a full-height field, not a collapsed line', async ({ page }) => {
  await install(page);
  await openAgents(page);
  await settings(page).getByRole('button', { name: 'New team' }).click();
  const nameField = settings(page).getByRole('textbox', { name: 'Team name', exact: true });
  const filter = settings(page).locator('.agent-team-filter');
  await expect(filter).toBeVisible();
  const measure = (locator: ReturnType<typeof settings.locator>) => locator.evaluate(el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { height: box.height, width: box.width, paddingLeft: parseFloat(style.paddingLeft) };
  });
  const [nameBox, filterBox] = [await measure(nameField), await measure(filter)];
  // The filter is a column child: `flex:1` collapsed it to a 15px text strip with no box.
  expect(filterBox.height).toBeGreaterThanOrEqual(nameBox.height);
  expect(filterBox.paddingLeft).toBeGreaterThanOrEqual(8);
  expect(filterBox.width).toBeGreaterThan(300);
});
});
