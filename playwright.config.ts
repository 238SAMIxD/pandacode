import { defineConfig } from '@playwright/test';

// PW_PORT starts a fresh server for this checkout on that port and refuses to reuse one,
// so another worktree's server on 1420 is never measured; output then goes to a per-port
// folder so concurrent runs don't collide. PW_PROD=1 serves a production build instead of dev.
const port = Number(process.env.PW_PORT ?? 1420);
const own = Boolean(process.env.PW_PORT || process.env.PW_PROD);
const prodDir = `node_modules/.cache/pandacode-perf-${port}`;
// Outside test-results/, which every default run deletes; playwright-report/ is gitignored too.
export const outputRoot = process.env.PW_PORT ? `playwright-report/port-${port}` : 'test-results';
// The diff benchmark (~90 s) runs only when named or with PERF=1. Workers inherit the env.
if (process.argv.some(arg => arg.includes('diff-perf'))) process.env.PERF = '1';
export const perfSpecs = process.env.PERF === '1' ? ['**/diff-perf.spec.ts'] : [];

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/external-links.spec.ts', '**/remove-project.spec.ts', '**/run-project.spec.ts', '**/terminal.spec.ts', '**/thread-order.spec.ts', '**/thread-panels.spec.ts', '**/agent-updates.spec.ts', '**/thread-deletion.spec.ts', '**/agent-usage.spec.ts', '**/grok.spec.ts', '**/compact-menus.spec.ts', '**/attachments.spec.ts', '**/sketch.spec.ts', '**/worktrees.spec.ts', '**/github.spec.ts', '**/github-hub.spec.ts', '**/remote.spec.ts', '**/simulator.spec.ts', '**/colors.spec.ts', '**/token-saver.spec.ts', '**/support.spec.ts', '**/jev-live.spec.ts', '**/jev-assist.spec.ts', '**/jev.spec.ts', '**/message-actions.spec.ts', '**/opencode-models.spec.ts', '**/overlay.spec.ts', '**/moodboards.spec.ts', '**/provider-settings.spec.ts', '**/ui.spec.ts', '**/browser.spec.ts', '**/board.spec.ts', '**/streaming.spec.ts', '**/concurrency.spec.ts', '**/subagents.spec.ts', '**/architect.spec.ts', '**/team-profiles.spec.ts', '**/agent-teams.spec.ts', '**/vm.spec.ts', '**/deploy.spec.ts', '**/turn-changes.spec.ts', '**/wallpapers.spec.ts', '**/wallpaper-settings.spec.ts', '**/settings.spec.ts', '**/layout-preferences.spec.ts', '**/agent-input.spec.ts', '**/agent-tools.spec.ts', '**/slash-commands.spec.ts', '**/file-mentions.spec.ts', '**/command-center.spec.ts', '**/goal-workflow.spec.ts', '**/conversation-import.spec.ts', '**/message-queue.spec.ts', '**/steering.spec.ts', '**/usage-limit.spec.ts', '**/bots.spec.ts', '**/bots-web.spec.ts', '**/markdown.spec.ts', '**/document-viewer.spec.ts', '**/generative-ui.spec.ts', '**/search-panel.spec.ts', '**/design-canvas.spec.ts', '**/skills-library.spec.ts', '**/jj.spec.ts', '**/capabilities.spec.ts', '**/recipes.spec.ts', '**/github-hub-keyboard.spec.ts', '**/chats.spec.ts', '**/connections.spec.ts', '**/inspector-new-task.spec.ts', '**/cloud-agents.spec.ts', ...perfSpecs],
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 4),
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  outputDir: outputRoot,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 940 },
    headless: true,
    launchOptions: {
      // Playwright creates disposable browser contexts; never use a personal profile.
      executablePath: process.env.PANDACODE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.PW_PROD
      ? `npx vite build --outDir ${prodDir} --emptyOutDir && npx vite preview --outDir ${prodDir} --port ${port} --strictPort --host 127.0.0.1`
      : own ? `npx vite --port ${port} --strictPort --host 127.0.0.1` : 'npm run dev',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !own,
    timeout: process.env.PW_PROD ? 180_000 : 30_000,
  },
});
