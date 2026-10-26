import { expect, test, type Page } from '@playwright/test';

// The task list is one Tab stop with arrow keys inside; ⌘1…9 and ⌘⇧[ / ] move between tasks.
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const tabStops = (page: Page) => page.locator('#navigation').evaluate(nav => [...nav.querySelectorAll<HTMLElement>('button')].filter(b => b.tabIndex >= 0 && b.getClientRects().length).map(b => b.dataset.id ?? b.dataset.action));

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
}

test('the list is a single Tab stop and arrow keys move between rows and headings', async ({ page }) => {
  await open(page);
  expect(await tabStops(page)).toEqual(['session-1']);
  await row(page, 'session-1').focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'session-2')).toBeFocused();
  expect(await tabStops(page)).toEqual(['session-2']);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const heading = page.locator('.folder-heading[data-project="project-1"]');
  await expect(heading).toBeFocused();
  // ← closes the folder, → opens it again; the closed state is remembered.
  await page.keyboard.press('ArrowLeft');
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('End');
  await expect(row(page, 'session-4')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page, 'session-4')).toHaveAttribute('aria-current', 'page');
});

test('row actions stay out of the Tab order and the menu key opens the row menu', async ({ page }) => {
  await open(page);
  await expect(page.locator('#navigation .task-action[tabindex="0"]')).toHaveCount(0);
  await row(page, 'session-2').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Pin task', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row(page, 'session-2')).toBeFocused();
});

test('⌘1…9 open the nth task and ⌘⇧[ / ] step through tasks', async ({ page }) => {
  await open(page);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.locator('#transcript').click();
  await page.keyboard.press(`${mod}+2`);
  await expect(row(page, 'session-2')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press(`${mod}+Shift+BracketRight`);
  await expect(row(page, 'session-3')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press(`${mod}+Shift+BracketLeft`);
  await expect(row(page, 'session-2')).toHaveAttribute('aria-current', 'page');
});

test('/ focuses the filter from the sidebar and ⌘Z undoes completing a task', async ({ page }) => {
  await open(page);
  await row(page, 'session-2').focus();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Filter tasks', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await row(page, 'session-3').focus();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+Enter`);
  await expect(page.locator('#toast')).toContainText('Task completed');
  await expect(page.locator('#navigation [data-thread-group="completed"]')).toBeVisible();
  await page.locator('#navigation').focus().catch(() => undefined);
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator('#navigation [data-thread-group="completed"]')).toHaveCount(0);
  await expect(row(page, 'session-3')).toHaveCount(1);
});
