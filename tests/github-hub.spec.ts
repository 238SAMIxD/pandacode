import { expect, test, type Page } from '@playwright/test';

/* The GitHub view: repositories on the left, threads / pull requests / issues on the right,
 * and one-click work that opens as an ordinary linked thread. Runs on the preview's sample
 * GitHub (src/preview-github-hub.ts). */
const hub = (page: Page) => page.getByRole('region', { name: 'GitHub', exact: true });
const repoList = (page: Page) => hub(page).getByRole('listbox', { name: 'Repositories' });
const tab = (page: Page, name: RegExp) => hub(page).getByRole('tab', { name });
const row = (page: Page, number: number) => hub(page).locator(`.gh-item[data-gh-number="${number}"]`);

async function openHub(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'GitHub view' }).click();
  await expect(hub(page)).toBeVisible();
  await expect(repoList(page).getByRole('option')).toHaveCount(5);
}

test('lists repositories and shows the chosen one’s threads, pull requests and issues', async ({ page }) => {
  await openHub(page);
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.conversation-pane')).toBeHidden();
  const orbit = repoList(page).getByRole('option', { name: /orbit\s*orbit-labs/ });
  await expect(orbit).toHaveAttribute('aria-selected', 'true');
  await expect(orbit.locator('.gh-local-dot')).toBeVisible();
  await expect(hub(page).getByRole('heading', { name: 'orbit-labs/orbit' })).toBeVisible();
  await expect(hub(page).locator('.gh-where')).toContainText('Projects/orbit');
  await expect(tab(page, /Threads/)).toHaveText('Threads3');
  await expect(tab(page, /Pull requests/)).toHaveText('Pull requests4');
  await expect(tab(page, /Issues/)).toHaveText('Issues5');
  await expect(hub(page).locator('.gh-thread')).toHaveCount(3);

  await tab(page, /Pull requests/).click();
  await expect(row(page, 130)).toContainText('Debounce library search and cache the index');
  await expect(row(page, 124).locator('.gh-review')).toHaveText('Changes requested');
  await expect(row(page, 124).locator('.gh-checks')).toHaveAttribute('data-checks', 'failing');
  await hub(page).getByRole('searchbox', { name: 'Search this tab' }).fill('vite');
  await expect(hub(page).locator('.gh-item')).toHaveCount(1);
  await hub(page).getByRole('searchbox', { name: 'Search this tab' }).fill('');

  await hub(page).getByRole('searchbox', { name: 'Filter repositories' }).fill('dot');
  await expect(repoList(page).getByRole('option')).toHaveCount(1);
  await hub(page).getByRole('searchbox', { name: 'Filter repositories' }).fill('');
  // Arrow keys move through repositories and select them.
  await orbit.focus();
  await page.keyboard.press('ArrowDown');
  await expect(repoList(page).getByRole('option', { name: /orbit-api/ })).toHaveAttribute('aria-selected', 'true');
  await expect(hub(page).getByRole('heading', { name: 'orbit-labs/orbit-api' })).toBeVisible();
  await expect(tab(page, /Pull requests/)).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 52)).toBeVisible();
});

test('Solve starts a linked thread that works on the issue', async ({ page }) => {
  await openHub(page);
  await tab(page, /Issues/).click();
  await row(page, 128).hover();
  await row(page, 128).getByRole('button', { name: 'Solve' }).click();
  await expect(hub(page)).toBeHidden();
  await expect(page.locator('.conversation-pane')).toBeVisible();
  const sent = page.locator('#transcript .user-message').last();
  await expect(sent).toContainText('Fix issue #128: Search index rebuilds on every keystroke');
  await expect(page.locator('#navigation .task-item.selected')).toContainText('Fix #128: Search index rebuilds on every keystroke');
  // Back in the GitHub view, the issue links to its thread instead of offering a new one.
  await page.getByRole('button', { name: 'GitHub view' }).click();
  await expect(row(page, 128).getByRole('button', { name: 'Thread' })).toBeAttached();
  await expect(row(page, 128).getByRole('button', { name: 'Open in thread' })).toHaveCount(0);
  await row(page, 128).hover();
  await row(page, 128).getByRole('button', { name: 'Thread' }).click();
  await expect(page.locator('#navigation .task-item.selected')).toContainText('Fix #128');
});

test('pull requests open for review, or in a thread with the prompt ready', async ({ page }) => {
  await openHub(page);
  await tab(page, /Pull requests/).click();
  await row(page, 130).hover();
  await row(page, 130).getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('#transcript .user-message').last()).toContainText('Review pull request #130 (feat/instant-search → main)');
  await expect(page.locator('#navigation .task-item.selected')).toContainText('Review #130');

  await page.getByRole('button', { name: 'GitHub view' }).click();
  await row(page, 127).hover();
  await row(page, 127).getByRole('button', { name: 'More actions for #127' }).click();
  const menu = page.locator('.choice-menu');
  await expect(menu).toContainText('Merge when ready');
  await menu.getByText('Open in thread', { exact: true }).click();
  await expect(page.locator('#prompt')).toHaveValue('Let’s work on pull request #127: '.replace('’', "'"));
  await expect(page.locator('#prompt')).toBeFocused();
  await expect(page.locator('#transcript .user-message')).toHaveCount(0);
});

test('a thread starts from the Threads tab', async ({ page }) => {
  await openHub(page);
  const compose = hub(page).getByRole('textbox', { name: 'New thread' });
  await compose.fill('Add a reading-time estimate to each article');
  await compose.press('Enter');
  await expect(page.locator('#transcript .user-message').last()).toContainText('Add a reading-time estimate to each article');
  await expect(page.locator('#breadcrumb')).toContainText('orbit');
});

test('a repository that is only on GitHub can be cloned, then worked on', async ({ page }) => {
  await openHub(page);
  await repoList(page).getByRole('option', { name: /meadow/ }).click();
  await expect(hub(page).locator('.gh-empty')).toContainText('Not on this computer yet');
  await hub(page).locator('.gh-head').getByRole('button', { name: 'Clone to this computer' }).click();
  await expect(hub(page).locator('.gh-where')).toContainText('new-project/meadow');
  await expect(repoList(page).getByRole('option', { name: /meadow/ }).locator('.gh-local-dot')).toBeVisible();
  await expect(hub(page).getByRole('textbox', { name: 'New thread' })).toBeVisible();
  await tab(page, /Issues/).click();
  await row(page, 3).hover();
  await row(page, 3).getByRole('button', { name: 'Open in thread' }).click();
  await expect(page.locator('#prompt')).toHaveValue("Let's work on issue #3: ");
  await expect(page.locator('#welcome-project')).toHaveText('meadow');
});

test('the GitHub view stays out of the way when GitHub is turned off', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('pandacode.github', 'off'); localStorage.setItem('pandacode.view', 'github'); });
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await expect(page.getByRole('button', { name: 'GitHub view' })).toBeHidden();
  await expect(page.locator('.conversation-pane')).toBeVisible();
});

test('the GitHub view is reachable from Go to anything', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.locator('.search-trigger').click();
  await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill('github');
  await page.locator('#command-results').getByRole('button', { name: 'GitHub' }).click();
  await expect(hub(page)).toBeVisible();
});
