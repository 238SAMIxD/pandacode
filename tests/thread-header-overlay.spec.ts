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
});
