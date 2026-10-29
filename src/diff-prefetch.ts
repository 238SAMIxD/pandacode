// Warm paths for the inspector's Changes → diff view: the viewer module, its worker
// pool and themes start after the app's first paint, the top changed files and any
// hovered row get their git_diff fetched and first screen highlighted in the pool,
// so the click only paints. Cached patches belong to one git status generation:
// invalidateDiffs() on every status refresh. A click on a cached patch revalidates.
// The patch splitting here is shared by prefetching and mounting, so both derive the
// same pool cache keys.

const MAX_ENTRIES = 20;
const MAX_AGE_MS = 10_000;

interface Entry { at: number; diff: Promise<string> }
const cache = new Map<string, Entry>();

export function invalidateDiffs(): void { cache.clear(); }

/** The patch for `key`: a recent prefetch (`reused`, so the caller revalidates) or a new `load()`. Failures are never cached. */
export function cachedDiff(key: string, load: () => Promise<string>): { diff: Promise<string>; reused: boolean } {
  const hit = cache.get(key);
  cache.delete(key);
  if (hit && performance.now() - hit.at < MAX_AGE_MS) { cache.set(key, hit); return { diff: hit.diff, reused: true }; }
  const entry = { at: performance.now(), diff: load() };
  cache.set(key, entry);
  entry.diff.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return { diff: entry.diff, reused: false };
}

let preloaded: Promise<unknown> | undefined;
/** Imports the diff viewer and starts @pierre/diffs, its worker pool and themes, once. */
export function preloadDiffs(): Promise<unknown> {
  preloaded ??= import('./diff-viewer').then(viewer => viewer.preloadDiffViewer()).catch(() => { preloaded = undefined; });
  return preloaded;
}

/** preloadDiffs() right after the next paint, so it never delays the list it belongs to. */
export function preloadDiffsAfterPaint(): void {
  if (preloaded) return;
  requestAnimationFrame(() => setTimeout(() => void preloadDiffs(), 0));
}

let changedNames: string[] = [];
/** File names in the current git status, so the pool warms their grammars first. */
export function noteChangedPaths(paths: string[]): void {
  changedNames = paths.slice(0, 50).map(path => path.slice(path.lastIndexOf('/') + 1));
}
export function likelyFileNames(): string[] { return changedNames; }

/** Highlights the first screen of `patch` in the worker pool ahead of a likely click. */
export function primeDiffs(path: string, patch: string): void {
  void preloadDiffs().then(() => import('./diff-viewer')).then(viewer => viewer.primeDiff(path, patch)).catch(() => {});
}

/** cyrb53 (53 bits) plus the length: a reopened, unchanged patch reuses its highlighted rows. */
export function patchKey(path: string, text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${path}:${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

export interface PatchChunk { text: string; lines: number; continued: boolean }
// Files longer than SPLIT_FROM lines become groups of whole hunks: a short first group
// so the first screen is highlighted (and parsed) first, then larger ones.
const SPLIT_FROM = 300;
const FIRST_CHUNK_LINES = 60;
const CHUNK_LINES = 500;

/**
 * Splits a patch at `diff --git` sections and, inside long sections, between hunks.
 * A continued chunk repeats its section's header so it parses on its own. Joining the
 * chunks' bodies gives back the patch; patches without hunks stay whole.
 */
export function splitPatch(patch: string): PatchChunk[] {
  const files: number[] = [], hunks: { at: number; line: number }[] = [];
  const lineAt = new Map<number, number>();
  let line = 0;
  for (let i = 0; ; line++) {
    if (patch.startsWith('diff --git ', i)) { files.push(i); lineAt.set(i, line); } else if (patch.startsWith('@@ ', i)) hunks.push({ at: i, line });
    const next = patch.indexOf('\n', i);
    if (next === -1 || next + 1 >= patch.length) { line++; break; }
    i = next + 1;
  }
  if (!files.length) { files.push(0); lineAt.set(0, 0); }
  const chunks: PatchChunk[] = [];
  let h = 0;
  files.forEach((headerAt, index) => {
    // Text before the first section (a commit message, say) stays with it, outside the repeated header.
    const start = index ? headerAt : 0;
    const end = files[index + 1] ?? patch.length, endLine = files[index + 1] !== undefined ? lineAt.get(end)! : line;
    const startLine = index ? lineAt.get(start)! : 0;
    const own: { at: number; line: number }[] = [];
    while (h < hunks.length && hunks[h].at < end) own.push(hunks[h++]);
    if (endLine - startLine <= SPLIT_FROM || own.length < 2 || !patch.startsWith('diff --git ', headerAt)) { chunks.push({ text: patch.slice(start, end), lines: endLine - startLine, continued: false }); return; }
    const header = patch.slice(headerAt, own[0].at);
    let groupAt = start, groupLine = startLine, target = FIRST_CHUNK_LINES;
    for (let k = 1; k <= own.length; k++) {
      const next = own[k] ?? { at: end, line: endLine };
      if (k < own.length && next.line - groupLine < target) continue;
      const continued = groupAt !== start;
      chunks.push({ text: (continued ? header : '') + patch.slice(groupAt, next.at), lines: next.line - groupLine, continued });
      groupAt = next.at; groupLine = next.line; target = CHUNK_LINES;
    }
  });
  return chunks;
}
