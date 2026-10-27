import { expect, test, type Page } from '@playwright/test';

const box = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => node.getBoundingClientRect().toJSON() as DOMRect);

async function openThread(page: Page, width = 1200): Promise<void> {
  // Short enough that the sample thread scrolls.
  await page.setViewportSize({ width, height: 520 });
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/');
  await page.locator('.task-item[data-id="session-1"]').evaluate(node => (node as HTMLElement).click());
  await expect(page.locator('#transcript .message').first()).toBeVisible();
}

test.describe('thread header overlay', () => {
  for (const width of [1200, 900, 620]) {
    test(`the transcript scrolls under a blurred header at ${width}px`, async ({ page }) => {
      await openThread(page, width);
      const header = page.locator('.workspace-header');
      const style = await header.evaluate(node => {
        const band = getComputedStyle(node, '::before');
        return { position: getComputedStyle(node).position, blur: band.backdropFilter || band.getPropertyValue('-webkit-backdrop-filter'), mask: band.maskImage || band.getPropertyValue('-webkit-mask-image') };
      });
      expect(style.position).toBe('relative');
      expect(style.blur).toContain('blur');
      expect(style.mask).toContain('gradient');

      const headerBottom = (await box(page, '.workspace-header')).bottom;
      const transcript = page.locator('#transcript');
      // The transcript starts under the header, but its first message is fully visible at rest.
      expect((await box(page, '#transcript')).top).toBeLessThan(headerBottom);
      await transcript.evaluate(node => { node.scrollTop = 0; });
      expect((await box(page, '#transcript .message')).top).toBeGreaterThanOrEqual(headerBottom);

      await transcript.evaluate(node => { node.scrollTop = 40; });
      expect(await transcript.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      expect((await box(page, '#transcript .message')).top).toBeLessThan(headerBottom);

      // Scrolled to the end, the last row sits inside the transcript, above the composer.
      await transcript.evaluate(node => { node.scrollTop = node.scrollHeight; });
      const end = await transcript.evaluate(node => ({ last: node.lastElementChild!.previousElementSibling!.getBoundingClientRect().bottom, bottom: node.getBoundingClientRect().bottom }));
      expect(end.last).toBeLessThanOrEqual(end.bottom);
    });
  }

  test('the team bar floats over the thread with its left side in view', async ({ page }) => {
    await openThread(page);
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Open workers', exact: true });
    await expect(trigger).toBeVisible();
    const host = await page.locator('.architect-host').evaluate(node => ({ position: getComputedStyle(node).position, blur: getComputedStyle(node.querySelector('.architect-trigger')!).backdropFilter }));
    expect(host.position).toBe('absolute');
    expect(host.blur).toContain('blur');
    const bar = await box(page, '.architect-trigger');
    const pane = await box(page, '.conversation-pane');
    expect(bar.left).toBeGreaterThanOrEqual(pane.left);
    expect(bar.top).toBeGreaterThanOrEqual((await box(page, '.workspace-header')).bottom);
    // Its left edge (the team icon) is what the pointer hits there, not a strip or the header.
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.architect-trigger') !== null, { x: bar.left + 6, y: bar.top + bar.height / 2 });
    expect(hit).toBe(true);
    // At rest nothing sits under it; scrolled, the transcript passes beneath.
    await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; });
    const first = await box(page, '#transcript .message');
    expect(first.top).toBeGreaterThanOrEqual(bar.bottom);
    await page.locator('#transcript').evaluate(node => { node.scrollTop = 40; });
    expect((await box(page, '#transcript .message')).top).toBeLessThan(bar.bottom);
    await expect(trigger).toBeVisible();
  });

  test('find in thread lands every match below the header, its fade, the team bar and the find bar', async ({ page }) => {
    await openThread(page);
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open workers', exact: true })).toBeVisible();
    const transcript = page.locator('#transcript');
    // Room to scroll, then put the first "search" match just under the header, inside the fade.
    await page.locator('#stream-region').evaluate(node => { node.style.minHeight = '900px'; });
    const headerBottom = (await box(page, '.workspace-header')).bottom;
    await transcript.evaluate((node, y) => { node.scrollTop += node.querySelector('.user-message')!.getBoundingClientRect().top - y; }, headerBottom + 6);
    // Let the scroll event land, so the transcript stops following the bottom.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByRole('search');
    const input = find.getByRole('searchbox', { name: 'Find in thread', exact: true });
    await input.fill('search');
    const count = find.locator('.thread-find-count');
    await expect(count).toHaveText(/^\d+ of \d+$/);
    const total = Number((await count.textContent())!.split(' of ')[1]);
    const current = () => page.evaluate(() => { const [range] = [...(CSS as any).highlights.get('thread-find-current')] as Range[]; return range.getBoundingClientRect().toJSON() as DOMRect; });
    const limit = Math.max(headerBottom + 32, (await box(page, '.architect-trigger')).bottom, (await find.boundingBox())!.y + (await find.boundingBox())!.height);
    const bottom = (await box(page, '#transcript')).bottom;
    // The fresh search skips the covered match; stepping back to it, then through every match,
    // must bring each fully into the clear area.
    for (const [index, key] of ['', 'Shift+Enter', ...Array(total).fill('Enter')].entries()) {
      if (key) await input.press(key);
      const rect = await current();
      expect(rect.top, `step ${index}`).toBeGreaterThanOrEqual(limit);
      expect(rect.bottom, `step ${index}`).toBeLessThanOrEqual(bottom);
    }
  });
});
