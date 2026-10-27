import { expect, test, type Page } from '@playwright/test';

const dock = (page: Page) => page.getByRole('toolbar', { name: 'Workspace actions', exact: true });
const rect = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => node.getBoundingClientRect().toJSON() as DOMRect);
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const dockAnimations = (page: Page) => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && ((animation.effect as KeyframeEffect | null)?.target as Element | null)?.closest('#action-dock')).length);

async function open(page: Page, width = 1440, height = 940): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#transcript .message').first()).toBeVisible();
  // Measure after the entrance has settled.
  await expect.poll(() => dockAnimations(page)).toBe(0);
}

test.describe('action dock', () => {
  test('floats as a vertical stack under the header, beside the inspector or at the window edge', async ({ page }) => {
    await open(page);
    const toolbar = dock(page);
    await expect(toolbar).toHaveAttribute('aria-orientation', 'vertical');
    // The header keeps only its leading items; every action lives in the dock.
    await expect(page.locator('.workspace-header .header-actions button')).toHaveCount(0);
    for (const name of ['Toggle inspector (⌘ ⇧ B)', /^Toggle terminal/, 'Open browser', 'Project moodboards', 'Deploy', 'Task actions']) {
      await expect(toolbar.getByRole('button', { name, exact: typeof name === 'string' })).toBeVisible();
    }
    const items = await toolbar.locator('button:visible').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON() as DOMRect));
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (let index = 1; index < items.length; index++) {
      expect(Math.abs(items[index].left - items[0].left)).toBeLessThan(1);
      expect(items[index].top).toBeGreaterThanOrEqual(items[index - 1].bottom);
    }
    for (const item of items) { expect(item.width).toBeGreaterThanOrEqual(32); expect(item.width).toBeLessThanOrEqual(36); }

    const box = await rect(page, '#action-dock');
    const header = await rect(page, '.workspace-header');
    const inspector = await rect(page, '#inspector');
    expect(box.top).toBeGreaterThanOrEqual(header.bottom);
    expect(box.right).toBeLessThanOrEqual(inspector.left);
    expect(inspector.left - box.right).toBeLessThan(16);
    // It stays clear of the composer and of every message in the transcript.
    expect(overlaps(box, await rect(page, '#composer'))).toBe(false);
    for (const message of await page.locator('#transcript .message').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON() as DOMRect))) expect(overlaps(box, message)).toBe(false);
    const glass = await toolbar.evaluate(node => getComputedStyle(node).backdropFilter);
    expect(glass).toContain('blur');

    await toolbar.getByRole('button', { name: 'Toggle inspector (⌘ ⇧ B)', exact: true }).click();
    await expect(page.locator('#inspector')).toBeHidden();
    const closed = await rect(page, '#action-dock');
    expect(page.viewportSize()!.width - closed.right).toBeLessThan(16);
    expect(overlaps(closed, await rect(page, '#composer'))).toBe(false);
  });

  test('is one Tab stop with arrow-key roving, and panels show their active state', async ({ page }) => {
    await open(page);
    const toolbar = dock(page);
    const inspector = toolbar.getByRole('button', { name: 'Toggle inspector (⌘ ⇧ B)', exact: true });
    const terminal = page.locator('#terminal-toggle'), browser = page.locator('#browser-toggle'), more = page.locator('#task-menu-trigger');
    await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
    await expect(inspector).toHaveClass(/\bactive\b/);
    await inspector.focus();
    await page.keyboard.press('ArrowDown');
    await expect(terminal).toBeFocused();
    await expect(terminal).toHaveAttribute('tabindex', '0');
    await expect(inspector).toHaveAttribute('tabindex', '-1');
    // The label pops out on the dock's left for keyboard focus.
    const tip = page.locator('.action-dock-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(/^Toggle terminal/);
    expect((await rect(page, '.action-dock-tip')).right).toBeLessThanOrEqual((await rect(page, '#action-dock')).left);
    await page.keyboard.press('End');
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(inspector).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(more).toBeFocused();
    await page.keyboard.press('Home');
    await expect(inspector).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(terminal).toHaveClass(/\bactive\b/);
    await expect(terminal).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#terminal-drawer')).toBeVisible();
    // The terminal may take focus once its shell starts, so the next item is reached directly.
    await browser.focus();
    await page.keyboard.press(' ');
    await expect(browser).toHaveClass(/\bactive\b/);
    await expect(page.locator('#browser-panel')).toBeVisible();
    // Focus that left the dock comes back to the last item through one Tab stop.
    await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
    await expect(toolbar.locator('button[tabindex="0"]')).toHaveId('browser-toggle');
    // The active fill paints behind the icon.
    await expect.poll(() => browser.evaluate(node => getComputedStyle(node, '::before').opacity)).toBe('1');
    expect(await page.locator('#action-dock [data-action="moodboards"]').evaluate(node => getComputedStyle(node, '::before').opacity)).toBe('0');
  });

  test('springs items in and out as they appear, and animates hover and entrance', async ({ page }) => {
    await open(page);
    await expect.poll(() => dockAnimations(page)).toBe(0);
    const run = page.locator('#run-project-button');
    await expect(run).toBeHidden();
    await run.evaluate(node => { (node as HTMLElement).hidden = false; });
    await expect(run).toBeVisible();
    expect(await dockAnimations(page)).toBeGreaterThan(0);
    // Leaving, the item keeps its box (inert) until the collapse ends, then it is gone.
    await expect.poll(() => dockAnimations(page)).toBe(0);
    await run.evaluate(node => { (node as HTMLElement).hidden = true; });
    expect(await run.evaluate(node => node.hasAttribute('data-leaving') && (node as HTMLElement).inert)).toBe(true);
    await expect(run).not.toHaveAttribute('data-leaving');
    await expect(run).toBeHidden();
    // Hover lifts the icon with a spring; nothing uses a CSS transition.
    await page.locator('#browser-toggle').hover();
    expect(await dockAnimations(page)).toBeGreaterThan(0);
    await expect(page.locator('.action-dock-tip')).toHaveText('Open browser');
    await expect(page.locator('#browser-toggle')).toHaveCSS('transition-duration', '0s');
    await expect.poll(() => page.locator('#browser-toggle .icon').evaluate(node => getComputedStyle(node).scale)).toBe('1.12');
    // Pressing scales the button with `scale`, never `transform`.
    const box = await rect(page, '#browser-toggle');
    await page.mouse.down();
    await expect.poll(() => page.locator('#browser-toggle').evaluate(node => getComputedStyle(node).scale)).toBe('0.88');
    expect(await page.locator('#browser-toggle').evaluate(node => getComputedStyle(node).transform)).toBe('none');
    await page.mouse.move(box.left - 200, box.top);
    await page.mouse.up();
    // A fresh load plays the staggered entrance.
    await page.reload();
    await expect.poll(() => dockAnimations(page), { timeout: 2000 }).toBeGreaterThan(0);
  });

  test('is instant under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    expect(await dockAnimations(page)).toBe(0);
    const run = page.locator('#run-project-button');
    await run.evaluate(node => { (node as HTMLElement).hidden = false; });
    await expect(run).toBeVisible();
    await page.locator('#browser-toggle').hover();
    await expect(page.locator('.action-dock-tip')).toBeVisible();
    expect(await dockAnimations(page)).toBe(0);
    expect(await page.locator('#browser-toggle .icon').evaluate(node => getComputedStyle(node).scale)).toBe('none');
    await run.evaluate(node => { (node as HTMLElement).hidden = true; });
    expect(await run.evaluate(node => node.hasAttribute('data-leaving'))).toBe(false);
    await expect(run).toBeHidden();
    expect(await dockAnimations(page)).toBe(0);
  });

  test('moves into the header as a row on narrow windows and the board', async ({ page }) => {
    await open(page, 620);
    const toolbar = dock(page);
    const header = await rect(page, '.workspace-header');
    const box = await rect(page, '#action-dock');
    expect(box.top).toBeGreaterThanOrEqual(header.top);
    expect(box.bottom).toBeLessThanOrEqual(header.bottom);
    expect(box.right).toBeLessThanOrEqual(620);
    await toolbar.getByRole('button', { name: 'Task actions', exact: true }).focus();
    await expect(toolbar).toHaveAttribute('aria-orientation', 'horizontal');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#deploy-button')).toBeFocused();

    await page.setViewportSize({ width: 1440, height: 940 });
    await page.getByRole('button', { name: /^Workspace view: / }).click();
    await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    await expect(page.locator('.workspace')).toHaveClass(/\bboard-view\b/);
    const boardHeader = await rect(page, '.workspace-header');
    const row = await rect(page, '#action-dock');
    expect(row.top).toBeGreaterThanOrEqual(boardHeader.top);
    expect(row.bottom).toBeLessThanOrEqual(boardHeader.bottom);
    await expect(toolbar.getByRole('button', { name: 'Task actions', exact: true })).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`keeps a solid fallback under reduced transparency in ${theme}`, async ({ page }) => {
      await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
      await page.emulateMedia({ colorScheme: theme, contrast: 'more' } as Parameters<Page['emulateMedia']>[0]);
      await open(page);
      const style = await dock(page).evaluate(node => ({ filter: getComputedStyle(node).backdropFilter, fill: getComputedStyle(node).backgroundColor }));
      expect(style.filter).toBe('none');
      expect(style.fill).not.toMatch(/rgba\(.*, 0\.\d+\)/);
    });
  }
});
