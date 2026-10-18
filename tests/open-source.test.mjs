import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = /\.(?:ts|tsx|js|mjs|css|html|rs|json|toml)$/;
// Built from parts so this file does not match itself if the scan is ever widened.
const FORBIDDEN = [['pandacode', 'ai'].join('.'), ['feature', 'base'].join('')];

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return SOURCE.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

test('no app source references the paid PandaCode service or the old support portal', async () => {
  const sources = [...await files(join(root, 'src')), ...await files(join(root, 'src-tauri', 'src'))];
  assert.ok(sources.length > 50, 'scanned the app sources');
  const offenders = [];
  for (const path of sources) {
    const text = (await readFile(path, 'utf8')).toLowerCase();
    for (const term of FORBIDDEN) if (text.includes(term)) offenders.push(`${relative(root, path)}: ${term}`);
  }
  assert.deepEqual(offenders, []);
});

test('the desktop build has no licensing or self-updater', async () => {
  const config = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(config.plugins?.updater, undefined);
  assert.equal(config.bundle.createUpdaterArtifacts, undefined);
  const cargo = await readFile(join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.ok(!cargo.includes('tauri-plugin-updater'));
  const build = await readFile(join(root, 'src-tauri', 'build.rs'), 'utf8');
  assert.ok(!/PUBLIC_KEY/.test(build));
});
