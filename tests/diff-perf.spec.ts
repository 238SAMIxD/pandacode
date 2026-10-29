import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Benchmark harness for the inspector's Changes → diff view. It records timings and
// only fails on errors, never on numbers. `?bench=diff` makes the preview's git_status
// list bench/* files whose git_diff patches are synthetic and seeded (src/preview.ts,
// BENCH_DIFFS). Skipped by plain `npx playwright test`; it runs when named or with PERF=1.
// PW_PORT starts this checkout's own server (never another worktree's on 1420) and
// writes to playwright-report/port-<port>/; PW_PROD=1 measures a production build.
//   Chromium dev:  PW_PORT=1437 npx playwright test tests/diff-perf.spec.ts
//   Chromium prod: PW_PROD=1 PW_PORT=1438 npx playwright test tests/diff-perf.spec.ts
//   WebKit (the real target is WKWebView), dev and prod:
//     PW_PORT=1439 npx playwright test -c playwright.webkit.config.ts tests/diff-perf.spec.ts
//     PW_PROD=1 PW_PORT=1440 npx playwright test -c playwright.webkit.config.ts tests/diff-perf.spec.ts
// Results: <outputDir>/diff-perf-<browser>-<dev|prod>.json plus a console table.
// Timings are sampled once per animation frame (±1 frame). Metrics, from the click:
// line = first diff row in a shadow root; ready = data-diff-state=ready; hl = first
// syntax-colored token; hlAll = every non-empty row in the visible viewport colored.

const SIZES = ['bench/small.ts', 'bench/medium.ts', 'bench/large.ts', 'bench/multi', 'bench/huge.ts'];
const RUNS = { cold: 3, warm: 5, hover: 3, toggle: 3, refresh: 3 };
// The 30k-line patch takes seconds per open, so it gets fewer runs.
const HUGE_RUNS = { cold: 2, warm: 2, hover: 2, toggle: 1, refresh: 1 };
const SCROLLED = new Set(['bench/large.ts', 'bench/multi', 'bench/huge.ts']);
const mode = process.env.PW_PROD ? 'prod' : 'dev';
const results: Record<string, Record<string, unknown>> = {};

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

declare global { interface Window { __diffBench: any; __benchDiffs?: Record<string, () => string> } }

// In-page probes, installed before the app so the long-task buffer covers every open.
function installProbes(): void {
  const longtasks: { start: number; duration: number }[] = [];
  const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask');
  if (supported) new PerformanceObserver(list => { for (const e of list.getEntries()) longtasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
  const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const root = () => document.querySelector<HTMLElement>('.inspector-diff-host .diff-viewer');
  const shadows = () => [...document.querySelectorAll('.inspector-diff-host diffs-container')].flatMap(c => c.shadowRoot ? [c.shadowRoot] : []);
  const lines = () => shadows().some(s => s.querySelector('[data-line]'));
  // Plain rows are bare <span>s; Shiki's rows carry --diffs-token-* colors.
  const TOKEN = 'span[style*="--diffs-token"]';
  const highlighted = () => shadows().some(s => s.querySelector(`[data-line] ${TOKEN}`));
  const highlightedAll = () => {
    const view = root()?.querySelector('.diff-viewer-content')?.getBoundingClientRect();
    if (!view) return false;
    let seen = 0;
    for (const shadow of shadows()) for (const row of shadow.querySelectorAll('[data-line]')) {
      const box = row.getBoundingClientRect();
      if (box.bottom <= view.top || box.top >= view.bottom || !row.textContent?.trim()) continue;
      if (!row.querySelector(TOKEN)) return false;
      seen++;
    }
    return seen > 0;
  };
  const blocked = (t0: number, t1: number) => supported ? longtasks.filter(e => e.start >= t0 && e.start < t1).reduce((sum, e) => sum + e.duration, 0) : undefined;
  const round = (n: number | undefined) => n === undefined ? null : Math.round(n * 10) / 10;
  window.__diffBench = {
    // Click (optionally after a 300 ms hover) → line, ready, hl, hlAll.
    async open(selector: string, hover = false) {
      const button = document.querySelector<HTMLElement>(selector);
      if (!button) throw new Error('Missing ' + selector);
      if (hover) {
        for (const type of ['pointerover', 'pointerenter']) button.dispatchEvent(new PointerEvent(type, { bubbles: type === 'pointerover', pointerType: 'mouse' }));
        await sleep(300);
      }
      const t0 = performance.now();
      button.click();
      const at: Record<'line' | 'ready' | 'hl' | 'hlAll', number | undefined> = { line: undefined, ready: undefined, hl: undefined, hlAll: undefined };
      let state = '';
      while (performance.now() - t0 < 30_000) {
        await frame();
        const now = performance.now() - t0;
        state = root()?.dataset.diffState ?? '';
        if (state === 'fallback') throw new Error('Diff fell back: ' + root()?.textContent?.slice(0, 200));
        at.line ??= lines() ? now : undefined;
        at.ready ??= state === 'ready' ? now : undefined;
        at.hl ??= at.line !== undefined && highlighted() ? now : undefined;
        at.hlAll ??= at.hl !== undefined && highlightedAll() ? now : undefined;
        if (at.ready !== undefined && at.hlAll !== undefined) break;
        // Some rows may never color (e.g. over the tokenize limit): stop 5 s after ready.
        if (at.ready !== undefined && now - at.ready > 5_000) break;
      }
      if (at.ready === undefined) throw new Error('Diff never became ready (state ' + state + ')');
      const end = performance.now();
      // Two more frames so a long task that ended with the render is reported.
      await frame(); await frame();
      return { line: round(at.line), ready: round(at.ready), hl: round(at.hl), hlAll: round(at.hlAll), longTasks: round(blocked(t0, end)), engine: root()?.dataset.diffEngine ?? null };
    },
    // A synchronous rerender: handler time, then time to the next painted frame.
    async toggle(label: string) {
      const button = document.querySelector<HTMLButtonElement>(`.inspector-diff-host button[aria-label="${label}"]`);
      if (!button || button.disabled) throw new Error(label + ' is unavailable');
      const t0 = performance.now();
      button.click();
      const sync = performance.now() - t0;
      await frame();
      return { sync: round(sync), frame: round(performance.now() - t0) };
    },
    // Refresh while a diff is open: was it remounted, did a frame paint without it, and when was it back?
    async refresh() {
      const before = root();
      const button = document.querySelector<HTMLElement>('.inspector-heading>[data-action="refresh-inspector"]');
      if (!before || !button) throw new Error('Open a diff first');
      const t0 = performance.now();
      button.click();
      let blankFrames = 0, loadingFrames = 0, back: number | undefined;
      while (performance.now() - t0 < 5_000) {
        await frame();
        const current = root();
        if (!current || !lines()) blankFrames++;
        if (!current || current.dataset.diffState === 'loading') loadingFrames++;
        if (current && current !== before && current.dataset.diffState === 'ready' && lines()) { back = performance.now() - t0; break; }
        // Not remounted: the refresh has settled once a second passes with the same viewer.
        if (current === before && performance.now() - t0 > 1_000) break;
      }
      const end = performance.now();
      await frame(); await frame();
      return { remounted: root() !== before, visibleAgain: round(back ?? 0), blankFrames, loadingFrames, longTasks: round(blocked(t0, end)) };
    },
    // Scroll top → bottom over ~2 s in rAF steps; frame times and rows left uncolored at the end.
    async scroll(duration = 2_000) {
      const scroller = root()?.querySelector<HTMLElement>('.diff-viewer-content');
      if (!scroller) throw new Error('No diff scroller');
      scroller.scrollTop = 0;
      await frame();
      const max = scroller.scrollHeight - scroller.clientHeight, deltas: number[] = [];
      let last = await frame();
      const start = last;
      for (;;) {
        const progress = Math.min(1, (last - start) / duration);
        scroller.scrollTop = max * progress;
        if (progress === 1) break;
        const now = await frame();
        deltas.push(now - last);
        last = now;
      }
      const sorted = [...deltas].sort((a, b) => a - b);
      await frame(); await frame();
      return { frames: deltas.length, p95: round(sorted[Math.floor(sorted.length * 0.95)]), max: round(sorted.at(-1)), over34: deltas.filter(d => d > 34).length, scrollHeight: scroller.scrollHeight, colored: highlightedAll(), longTasks: round(blocked(start, last)) };
    },
  };
}

const median = (values: unknown[]): unknown => {
  const sorted = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return values.find(v => v !== null && v !== undefined) ?? null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) * 5) / 10;
};
const medians = (runs: Record<string, unknown>[]) => runs.length ? Object.fromEntries(Object.keys(runs[0]).map(key => [key, typeof runs[0][key] === 'boolean' ? runs.every(r => r[key]) : median(runs.map(r => r[key]))])) : {};

const row = (path: string) => `#inspector-content [data-action="open-diff"][data-path="${path}"]`;
async function load(page: Page): Promise<void> {
  await page.goto('/?bench=diff');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1', { timeout: 20_000 });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click({ timeout: 10_000 });
  await expect(page.locator(row(SIZES[0])), 'No bench files: the server is not serving this checkout. Rerun with PW_PORT=1437.').toBeVisible();
}
async function back(page: Page): Promise<void> {
  await page.locator('[data-action="back-inspector"]').click();
  await expect(page.locator('.change-file').first()).toBeVisible();
}
const open = (page: Page, path: string, hover = false) => page.evaluate(([selector, hover]) => window.__diffBench.open(selector, hover), [row(path), hover] as const);

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(installProbes);
});
test.afterEach(() => { expect(pageErrors.splice(0)).toEqual([]); });

for (const path of SIZES) {
  test(`diff perf ${path}`, async ({ page }) => {
    const runs = path === 'bench/huge.ts' ? HUGE_RUNS : RUNS;
    await load(page);
    const patch = await page.evaluate(path => {
      const text = window.__benchDiffs![path]();
      return { bytes: text.length, lines: text.split('\n').length, files: text.split('\ndiff --git').length };
    }, path);
    // Cold: a fresh page each time, so the viewer and @pierre/diffs load again.
    const cold = [];
    for (let i = 0; i < runs.cold; i++) {
      if (i) await load(page);
      cold.push(await open(page, path));
    }
    const warm = [];
    for (let i = 0; i < runs.warm; i++) { await back(page); warm.push(await open(page, path)); }
    const hover = [];
    for (let i = 0; i < runs.hover; i++) { await back(page); hover.push(await open(page, path, true)); }
    const refresh = [];
    for (let i = 0; i < runs.refresh; i++) refresh.push(await page.evaluate(() => window.__diffBench.refresh()));
    const scroll = SCROLLED.has(path) ? await page.evaluate(() => window.__diffBench.scroll()) : null;
    // Split needs a panel at least 680 px wide, so drag the resize handle as a user would.
    const handle = (await page.locator('.inspector-resize-handle').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 480, handle.y + handle.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.inspector-diff-host button[aria-label="Split diff"]')).toBeEnabled();
    const toggles: Record<string, Record<string, unknown>[]> = { wrapOff: [], wrapOn: [], split: [], unified: [] };
    for (let i = 0; i < runs.toggle; i++) {
      toggles.wrapOff.push(await page.evaluate(() => window.__diffBench.toggle('Wrap lines')));
      toggles.wrapOn.push(await page.evaluate(() => window.__diffBench.toggle('Wrap lines')));
      toggles.split.push(await page.evaluate(() => window.__diffBench.toggle('Split diff')));
      toggles.unified.push(await page.evaluate(() => window.__diffBench.toggle('Unified diff')));
    }
    await expect(page.locator('.inspector-diff-host .diff-viewer')).toHaveAttribute('data-diff-layout', 'unified');
    results[path] = {
      patch,
      cold: { ...medians(cold), first: cold[0] },
      warm: medians(warm),
      hover: medians(hover),
      refresh: medians(refresh),
      scroll,
      toggles: Object.fromEntries(Object.entries(toggles).map(([key, runs]) => [key, medians(runs)])),
      runs: { cold, warm, hover, refresh },
    };
    test.info().annotations.push({ type: 'diff-perf', description: JSON.stringify({ path, ...results[path], runs: undefined }) });
  });
}

// Where the main thread's time goes on the largest single file: Chromium's sampling profiler.
// Work moved to a highlighter worker does not show up here.
test('diff perf profile bench/large.ts', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP profiler is Chromium only');
  await load(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const opened = await open(page, 'bench/large.ts');
  const { profile } = await cdp.send('Profiler.stop');
  const bucket = (url: string, name: string) => {
    // Shiki is bundled inside @pierre/diffs; its JS regex engine shows up as RegExp frames and these helpers.
    if (name.startsWith('RegExp:') || /^(findNextMatchSync|#execCore|toRegExp|_tokenizeString|tokenizeLine)/.test(name)) return 'shiki tokenize';
    if (!url) return name === '(garbage collector)' ? 'gc' : name === '(program)' ? 'browser (style/layout/paint)' : name === '(idle)' ? 'idle' : 'native/other';
    if (/oniguruma|vscode-textmate|shiki|@shikijs/.test(url)) return 'shiki';
    if (/@pierre|pierre_diffs|\/assets\/(diff|index|worker)/.test(url)) return '@pierre/diffs';
    if (/\/src\//.test(url)) return 'app src';
    return 'other js';
  };
  const total = new Map<string, number>(), byFunction = new Map<string, number>(), self = new Map<number, number>();
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const deltas = profile.timeDeltas ?? [];
  (profile.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0) / 1000));
  for (const [id, ms] of self) {
    const frame = nodes.get(id)!.callFrame;
    const key = bucket(frame.url, frame.functionName);
    total.set(key, (total.get(key) ?? 0) + ms);
    const fn = ((frame.functionName.startsWith('RegExp:') ? 'RegExp (shiki grammar)' : frame.functionName || '(anonymous)') + (frame.url ? ' ' + frame.url.replace(/^.*?(node_modules\/|src\/|assets\/)/, '$1').replace(/\?.*$/, '') + ':' + frame.lineNumber : '')).slice(0, 90);
    byFunction.set(fn, (byFunction.get(fn) ?? 0) + ms);
  }
  const top = [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, ms]) => ({ ms: Math.round(ms * 10) / 10, fn }));
  results['profile bench/large.ts'] = { open: opened, selfTimeMs: Object.fromEntries([...total].map(([k, v]) => [k, Math.round(v)] as const).sort((a, b) => b[1] - a[1])), topFunctions: top };
});

test.afterAll(async ({ browserName }, testInfo) => {
  const file = `${testInfo.project.outputDir}/diff-perf-${browserName}-${mode}.json`;
  mkdirSync(testInfo.project.outputDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ browser: browserName, mode, at: new Date().toISOString(), results }, null, 2));
  const table = Object.entries(results).filter(([key]) => !key.startsWith('profile')).map(([path, r]: [string, any]) => ({
    path, lines: r.patch.lines, engine: r.cold.engine,
    coldReady: r.cold.ready, coldHl: r.cold.hl, coldHlAll: r.cold.hlAll, coldLong: r.cold.longTasks,
    warmReady: r.warm.ready, warmHl: r.warm.hl, warmHlAll: r.warm.hlAll, warmLong: r.warm.longTasks,
    hoverReady: r.hover.ready, hoverHl: r.hover.hl, refreshBlank: r.refresh.blankFrames, remount: r.refresh.remounted,
    wrap: r.toggles.wrapOff.frame, split: r.toggles.split.frame,
    scrollP95: r.scroll?.p95 ?? null, scrollMax: r.scroll?.max ?? null, over34: r.scroll?.over34 ?? null,
  }));
  console.log(`diff perf (${browserName}, ${mode}, ms medians) → ${file}`);
  console.table(table);
  if (results['profile bench/large.ts']) console.log(JSON.stringify(results['profile bench/large.ts'], null, 2));
});
