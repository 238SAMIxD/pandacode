import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Model routing, and the uncapped model catalog sent with an automatic team.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });

async function install(page: Page, init?: () => void): Promise<void> {
  if (init) await page.addInitScript(init);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      (window.__routing ??= { calls: [] }).calls.push({ command, args: structuredClone(args) });
      // Test hook: \`__routingFail[command] = message\` rejects that command until cleared.
      const failure = window.__routingFail?.[command];
      if (failure) throw new Error(failure);
      // Test hook: \`__routingDelay[command] = ms\` holds that command back before it runs.
      const delay = window.__routingDelay?.[command];
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return invokePreview(command, args);
    }
    async function invokePreview(command, args) {`) });
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
}
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => (window as any).__routing.calls.filter((entry: any) => entry.command === command), command);
async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agent teams', exact: true }).click();
}

test('the section renders, settings persist and the profiler downloads', async ({ page }) => {
  await install(page);
  await openAgents(page);
  const toggle = settings(page).getByRole('checkbox', { name: 'Pick worker models with Panda Router', exact: true });
  await expect(toggle).toBeChecked();
  await expect(settings(page).getByText('Not downloaded', { exact: true })).toBeVisible();
  await expect(settings(page).getByRole('radio', { name: 'Cheapest that passes' })).toHaveAttribute('aria-checked', 'true');
  await settings(page).getByRole('radio', { name: 'Balanced' }).click();
  await expect(settings(page).getByRole('spinbutton', { name: /Minimum chance/ })).toBeHidden();
  await settings(page).getByRole('radio', { name: 'Balanced' }).press('ArrowLeft');
  await expect(settings(page).getByRole('spinbutton', { name: /Minimum chance/ })).toBeVisible();
  await toggle.uncheck();
  await settings(page).getByRole('button', { name: 'Download', exact: true }).click();
  await expect(settings(page).getByText('Ready', { exact: true })).toBeVisible();
  const minP = settings(page).getByRole('spinbutton', { name: /Minimum chance/ });
  await expect(minP).toHaveValue('80');
  await minP.fill('99'); await minP.blur();
  await expect(minP).toHaveValue('95');
  // Reopen: the preview keeps the configuration.
  await page.reload();
  await page.locator('.task-item[data-id="session-2"]').click();
  await openAgents(page);
  await expect(settings(page).getByRole('checkbox', { name: 'Pick worker models with Panda Router', exact: true })).not.toBeChecked();
  await expect(settings(page).getByRole('radio', { name: 'Cheapest that passes' })).toHaveAttribute('aria-checked', 'true');
  await expect(settings(page).getByRole('textbox', { name: 'Task to route' })).toBeDisabled();
  await expect(settings(page).getByText('Ready', { exact: true })).toBeVisible();
});

test('Try it shows a pick and alternatives', async ({ page }) => {
  await install(page);
  await openAgents(page);
  await settings(page).getByRole('textbox', { name: 'Task to route' }).fill('Fix the failing login test');
  await settings(page).getByRole('button', { name: 'Route', exact: true }).click();
  const rows = settings(page).getByRole('list', { name: 'Routed models' }).getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('Pick');
  await expect(settings(page).getByText(/debugging/)).toBeVisible();
  expect((await calls(page, 'model_routing_route')).at(-1).args.pool.length).toBeGreaterThan(24);
});

test('the catalog keeps every harness and long shared prefixes', async ({ page }) => {
  await install(page);
  const result = await page.evaluate(async () => {
    const { buildTeamCatalog } = await import('/src/team-catalog.ts');
    const long = 'x'.repeat(90);
    const models = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `M${i}` }));
    const harnesses = [
      { id: 'opencode', name: 'OpenCode', models: [...models('provider/', 700), { id: `${long}a`, name: 'A' }, { id: `${long}b`, name: 'B' }, { id: 'provider/1', name: 'dup' }] },
      { id: 'glm', name: 'GLM', models: models('glm-', 2) }, { id: 'grok', name: 'Grok', models: models('grok-', 2) }, { id: 'muse', name: 'Muse', models: models('muse-', 2) },
      { id: 'kimi', name: 'Kimi', models: models('kimi-', 100) },
    ];
    const { catalog, roster } = buildTeamCatalog(harnesses as any);
    return { count: catalog.length, ids: new Set(catalog.map(m => m.id)).size, providers: [...new Set(catalog.map(m => m.provider))], longBoth: catalog.filter(m => m.model.startsWith(long)).length, dups: catalog.filter(m => m.provider === 'opencode' && m.model === 'provider/1').length, valid: catalog.every(m => /^[a-z0-9_-]{1,100}$/.test(m.id)), roster: roster.length, rosterInCatalog: roster.every(r => catalog.some(c => c.id === r.id)) };
  });
  expect(result.count).toBeLessThanOrEqual(1000);
  expect(result.ids).toBe(result.count);
  expect(result.providers).toEqual(expect.arrayContaining(['opencode', 'glm', 'grok', 'muse', 'kimi']));
  expect(result.longBoth).toBe(2);
  expect(result.dups).toBe(1);
  expect(result.valid).toBe(true);
  expect(result.roster).toBeLessThanOrEqual(24);
  expect(result.rosterInCatalog).toBe(true);
});

test('turning Team on sends the uncapped catalog and prepares routing', async ({ page }) => {
  await install(page);
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Team', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const { config } = (await calls(page, 'architect_configure')).at(-1).args;
  expect(config.workers.length).toBeLessThanOrEqual(24);
  expect(config.catalog.length).toBeGreaterThan(config.workers.length);
  await expect.poll(async () => (await calls(page, 'model_routing_prepare')).length).toBeGreaterThan(0);
});

test('the cap keeps every harness represented', async ({ page }) => {
  await install(page);
  const providers = await page.evaluate(async () => {
    const { buildTeamCatalog } = await import('/src/team-catalog.ts');
    const models = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `M${i}` }));
    const { catalog } = buildTeamCatalog([{ id: 'opencode', name: 'OpenCode', models: models('p/', 2000) }, { id: 'glm', name: 'GLM', models: models('glm-', 3) }] as any);
    return { count: catalog.length, glm: catalog.filter(m => m.provider === 'glm').length };
  });
  expect(providers).toEqual({ count: 1000, glm: 3 });
});

const chip = (page: Page) => page.locator('#route-picker-trigger');
const teamOn = async (page: Page) => {
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Team', exact: true })).toHaveAttribute('aria-pressed', 'true');
};

test('the composer picks the worker-model mode beside Team and remembers it', async ({ page }) => {
  await install(page);
  await expect(chip(page)).toBeHidden();
  await teamOn(page);
  await expect(chip(page)).toHaveAccessibleName('Worker models: Cheapest that passes');
  await expect(chip(page)).toHaveText('Cheapest');
  await chip(page).click();
  await expect(page.getByRole('menuitemradio', { name: 'Cheapest that passes' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.getByRole('menuitemradio', { name: 'Balanced' }).press('Enter');
  await expect(chip(page)).toHaveAccessibleName('Worker models: Balanced');
  expect((await calls(page, 'model_routing_configure')).at(-1).args).toEqual({ mode: 'balanced' });
  // Picking the current mode only closes the menu.
  const configures = (await calls(page, 'model_routing_configure')).length;
  await chip(page).click();
  await page.getByRole('menuitemradio', { name: 'Balanced' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Balanced' })).toBeHidden();
  expect(await calls(page, 'model_routing_configure')).toHaveLength(configures);
  await page.reload();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(chip(page)).toHaveAccessibleName('Worker models: Balanced');
  await openAgents(page);
  await expect(settings(page).getByRole('radio', { name: 'Balanced' })).toHaveAttribute('aria-checked', 'true');
  // A change in Settings reaches the chip without a reload.
  await settings(page).getByRole('radio', { name: 'Best quality' }).click();
  // The modal makes the composer inert, so read the label itself.
  await expect(chip(page)).toHaveAttribute('aria-label', 'Worker models: Best quality');
  await expect(chip(page)).toHaveText('Best');
  await settings(page).getByRole('checkbox', { name: 'Pick worker models with Panda Router', exact: true }).uncheck();
  await expect(chip(page)).toBeHidden();
});

test('routing off at load keeps the chip hidden', async ({ page }) => {
  await install(page, () => localStorage.setItem('pandacode.preview.routing', JSON.stringify({ enabled: false })));
  await teamOn(page);
  await expect(chip(page)).toBeHidden();
});

test('a remote task never shows the chip', async ({ page }) => {
  await install(page);
  await teamOn(page);
  await expect(chip(page)).toBeVisible();
  await page.evaluate(() => (window as any).__previewMirrorTeam());
  await page.locator('.task-item[data-id="mirror-team"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'mirror-team');
  await expect(chip(page)).toBeHidden();
});

test('an unknown mode shows a neutral label and checks nothing', async ({ page }) => {
  await install(page, () => localStorage.setItem('pandacode.preview.routing', JSON.stringify({ mode: 'fastest' })));
  await teamOn(page);
  await expect(chip(page)).toHaveAccessibleName('Worker models: Panda Router');
  await chip(page).click();
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveCount(0);
  await expect(page.getByRole('menuitemradio')).toHaveCount(3);
});

test('a refused change shows the menu error and keeps the chip', async ({ page }) => {
  await install(page);
  await teamOn(page);
  await page.evaluate(() => { (window as any).__routingFail = { model_routing_configure: 'Routing settings could not be saved.' }; });
  await chip(page).click();
  await page.getByRole('menuitemradio', { name: 'Balanced' }).click();
  await expect(page.locator('.choice-menu-error')).toHaveText('Routing settings could not be saved.');
  await expect(chip(page)).toHaveAccessibleName('Worker models: Cheapest that passes');
});

test('a status read during a pending change never overrides it', async ({ page }) => {
  await install(page);
  await teamOn(page);
  await page.evaluate(() => { (window as any).__routingDelay = { model_routing_configure: 800 }; });
  await chip(page).click();
  await page.getByRole('menuitemradio', { name: 'Balanced' }).click();
  // The read starts after the change and answers first, with the old mode.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(chip(page)).toHaveAccessibleName('Worker models: Balanced');
  await page.waitForTimeout(300);
  await expect(chip(page)).toHaveAccessibleName('Worker models: Balanced');
  await page.evaluate(() => { delete (window as any).__routingDelay; window.dispatchEvent(new Event('focus')); });
  await expect(chip(page)).toHaveAccessibleName('Worker models: Balanced');
});

test('a failed status load recovers on the next render or focus', async ({ page }) => {
  await install(page, () => { (window as any).__routingFail = { model_routing_status: 'Router unavailable.' }; });
  await teamOn(page);
  await expect(chip(page)).toBeHidden();
  await page.evaluate(() => { delete (window as any).__routingFail; window.dispatchEvent(new Event('focus')); });
  await expect(chip(page)).toHaveAccessibleName('Worker models: Cheapest that passes');
  // A render recovers too, and once loaded renders ask nothing.
  await page.evaluate(() => { (window as any).__routingFail = { model_routing_status: 'Router unavailable.' }; });
  await page.reload();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  await page.evaluate(() => { delete (window as any).__routingFail; });
  // Renders retry a failed load at most every 3 s (ROUTING_RETRY_MS).
  await page.waitForTimeout(3100);
  await page.locator('.task-item[data-id="session-1"]').click();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(chip(page)).toBeVisible();
  const loads = (await calls(page, 'model_routing_status')).length;
  await page.locator('.task-item[data-id="session-1"]').click();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(chip(page)).toBeVisible();
  expect(await calls(page, 'model_routing_status')).toHaveLength(loads);
});

test('a routing change keeps the prompt focus and caret', async ({ page }) => {
  await install(page);
  await teamOn(page);
  await expect(chip(page)).toBeVisible();
  const prompt = page.locator('#prompt');
  await prompt.fill('hello world'); await prompt.focus();
  await prompt.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode:routing', { detail: { enabled: true, mode: 'quality', minP: 0.8, profiler: 'ready', error: null } })));
  await expect(chip(page)).toHaveAccessibleName('Worker models: Best quality');
  expect(await prompt.evaluate((el: HTMLTextAreaElement) => [document.activeElement === el, el.selectionStart, el.value])).toEqual([true, 5, 'hello world']);
});

test('the chip keeps its label and fits the toolbar from wide to the narrowest window', async ({ page }) => {
  await install(page);
  await teamOn(page);
  await expect(chip(page)).toBeVisible();
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('[data-action="toggle-theme"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // 860 is the app's minimum window width (tauri.conf.json); 600 is the browser preview's narrow layout.
    for (const width of [1280, 860, 600]) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await page.evaluate(() => {
        const toolbar = document.querySelector('.composer-toolbar')!, tools = document.querySelector('.composer-tools')!.getBoundingClientRect();
        const button = document.querySelector('#route-picker-trigger')!, box = button.getBoundingClientRect(), team = document.querySelector('.composer-team-button')!.getBoundingClientRect();
        const label = button.querySelector('span')!;
        return { toolsRight: tools.right, right: box.right, overflow: toolbar.scrollWidth - toolbar.clientWidth, height: box.height, teamHeight: team.height, top: box.top, teamTop: team.top, label: label.offsetWidth > 0 && label.scrollWidth <= label.clientWidth };
      });
      expect(layout.label).toBe(true);
      expect(layout.right).toBeLessThanOrEqual(layout.toolsRight);
      expect(layout.overflow).toBeLessThanOrEqual(0);
      expect(Math.abs(layout.height - layout.teamHeight)).toBeLessThanOrEqual(2);
      expect(Math.abs(layout.top - layout.teamTop)).toBeLessThanOrEqual(2);
    }
  }
});
