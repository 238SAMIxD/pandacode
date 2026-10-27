import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Model routing, and the uncapped model catalog sent with an automatic team.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });

async function install(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      (window.__routing ??= { calls: [] }).calls.push({ command, args: structuredClone(args) });
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
