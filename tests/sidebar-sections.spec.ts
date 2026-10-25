import { expect, test, type Page } from '@playwright/test';

// ?sections adds preview threads for every section: one running, one waiting for approval,
// two unseen finished turns and three completed tasks.
const section = (page: Page, name: string) => page.locator(`#navigation [data-thread-group="${name}"]`);
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const toggle = (page: Page) => page.getByRole('button', { name: /^Completed/ });
const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function open(page: Page): Promise<void> {
  await page.goto('/?sections');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
}

test.describe('sidebar sections', () => {
  test('lists active and recently finished threads under headings with counts', async ({ page }) => {
    await open(page);
    const active = page.getByRole('region', { name: 'Active tasks', exact: true });
    const review = page.getByRole('region', { name: 'Tasks to review', exact: true });
    await expect(active.locator('.section-heading')).toHaveText('Active2');
    await expect(active.locator('.task-item')).toHaveCount(2);
    await expect(review.locator('.section-heading')).toHaveText('Needs review2');
    await expect(review.locator('.task-item')).toHaveCount(2);
    await expect(row(page, 'sections-approval').locator('.task-indicator')).toHaveAttribute('aria-label', 'Needs approval');
    // Each thread appears once.
    for (const id of ['sections-running', 'sections-review-1', 'session-1']) await expect(row(page, id)).toHaveCount(1);
  });

  test('Completed starts closed, opens on click and stays open after reload', async ({ page }) => {
    await open(page);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page)).toContainText('3');
    await expect(section(page, 'completed').locator('.task-item')).toHaveCount(0);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    expect(await section(page, 'completed').locator('.task-item').evaluateAll(rows => rows.map(r => (r as HTMLElement).dataset.id)))
      .toEqual(['sections-done-1', 'sections-done-2', 'sections-done-3']);
    await page.reload();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(section(page, 'completed').locator('.task-item')).toHaveCount(3);
  });

  test('the row tick completes a review thread and the checked tick reopens it', async ({ page }) => {
    await open(page);
    await toggle(page).click();
    await row(page, 'sections-review-1').hover();
    await action(page, 'Mark complete: Fix the flaky filter test').click();
    await expect(section(page, 'completed').locator('.task-item').first()).toHaveAttribute('data-id', 'sections-review-1');
    await expect(section(page, 'review').locator('.task-item')).toHaveCount(1);
    await expect(toggle(page)).toContainText('4');
    await action(page, 'Reopen: Fix the flaky filter test').click();
    await expect(section(page, 'completed').locator('[data-id="sections-review-1"]')).toHaveCount(0);
    await expect(section(page, 'project:project-1').locator('[data-id="sections-review-1"]')).toHaveCount(1);
    await expect(row(page, 'sections-review-1')).toHaveCount(1);
  });

  test('archiving from the row moves the thread to the archive view', async ({ page }) => {
    await open(page);
    await row(page, 'sections-review-2').hover();
    await action(page, 'Archive: Write the release notes').click();
    await expect(row(page, 'sections-review-2')).toHaveCount(0);
    await page.getByRole('button', { name: 'Archived tasks', exact: true }).click();
    await expect(section(page, 'archived').locator('[data-id="sections-review-2"]')).toBeVisible();
    await row(page, 'sections-review-2').hover();
    await expect(action(page, 'Restore: Write the release notes')).toBeVisible();
    await expect(action(page, 'Delete: Write the release notes')).toBeVisible();
  });

  test('deletes a thread from the row menu after confirming', async ({ page }) => {
    await open(page);
    await row(page, 'sections-review-1').hover();
    const more = action(page, 'Task actions: Fix the flaky filter test');
    await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await more.click();
    await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete task?', exact: true });
    await expect(confirm).toContainText('Fix the flaky filter test');
    await confirm.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(row(page, 'sections-review-1')).toHaveCount(0);
    await expect(section(page, 'review').locator('.section-count')).toHaveText('1');
  });
});
