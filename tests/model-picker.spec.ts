import { expect, test, type Page } from '@playwright/test';

async function openPicker(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant', { timeout: 15_000 });
  await expect(page.locator('#transcript article').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('.new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toBeVisible({ timeout: 15_000 });
}

// Issue #123: the picker lists only installed harnesses. The preview marks
// Antigravity and Oh My Pi as not installed.
test('the harness picker hides harnesses that are not installed', async ({ page }) => {
  await openPicker(page);
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker.getByRole('region', { name: 'Grok Build' })).toBeVisible();
  await expect(picker.locator('[data-provider="antigravity"], [data-provider="omp"]')).toHaveCount(0);
  await expect(picker).not.toContainText('Antigravity');
  await expect(picker).not.toContainText('Oh My Pi');
});

test('the model picker displays provider logos for Cline, Kilo Code and Oh My Pi', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({
      response,
      body: source.replace(
        /switch\s*\(command\)\s*\{/,
        `if (command === 'list_providers') return structuredClone(providers.map(p => ({...p, installed: true})));\nswitch (command) {`,
      ),
    });
  });
  await openPicker(page);
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });

  // Cline reference: heading and options have .provider-logo[data-provider="cline"]
  const clineGroup = picker.locator('.model-menu-group[aria-label="Cline"]');
  await expect(clineGroup.locator('.model-menu-group-heading .provider-logo[data-provider="cline"]')).toBeVisible();
  await expect(clineGroup.locator('.model-menu-option[data-provider="cline"] .provider-logo[data-provider="cline"]').first()).toBeVisible();

  // Kilo Code: heading and options have .provider-logo[data-provider="kilo"]
  const kiloGroup = picker.locator('.model-menu-group[aria-label="Kilo Code"]');
  await expect(kiloGroup.locator('.model-menu-group-heading .provider-logo[data-provider="kilo"]')).toBeVisible();
  await expect(kiloGroup.locator('.model-menu-option[data-provider="kilo"] .provider-logo[data-provider="kilo"]').first()).toBeVisible();

  // Oh My Pi: heading and options have .provider-logo[data-provider="omp"]
  const ompGroup = picker.locator('.model-menu-group[aria-label="Oh My Pi"]');
  await expect(ompGroup.locator('.model-menu-group-heading .provider-logo[data-provider="omp"]')).toBeVisible();
  await expect(ompGroup.locator('.model-menu-option[data-provider="omp"] .provider-logo[data-provider="omp"]').first()).toBeVisible();
});
