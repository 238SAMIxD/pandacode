import test from 'node:test';
import assert from 'node:assert/strict';
import { version, required, targetConfig, targets, hostTarget, releaseDirectory } from './common.mjs';

test('release versions cannot become paths, prereleases, or shell commands', () => {
  for (const input of ['../secret', '1.0.0;echo x', 'v1.0.0', '01.0.0', '1.0.0-beta', undefined]) assert.throws(() => version(input));
  assert.equal(version('0.3.0'), '0.3.0');
  assert.match(releaseDirectory('1.2.3'), /release[\\/]1\.2\.3$/);
});

test('only the three published targets are accepted', () => {
  assert.deepEqual(Object.keys(targets), ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64']);
  for (const target of ['linux-aarch64', 'windows-arm64', '../mac', 'toString', '__proto__', null]) assert.throws(() => targetConfig(target));
});

test('release asset names are stable across versions', () => {
  const assets = Object.values(targets).map(config => config.asset);
  assert.equal(new Set(assets).size, 3);
  for (const asset of assets) assert.doesNotMatch(asset, /\d+\.\d+\.\d+/);
});

test('the host maps to its native target', () => {
  assert.equal(hostTarget('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(hostTarget('win32', 'x64'), 'windows-x86_64');
  assert.equal(hostTarget('linux', 'x64'), 'linux-x86_64');
  assert.throws(() => hostTarget('linux', 'arm64'), /No release target/);
});

test('missing variables fail without revealing other values', () => {
  assert.throws(() => required('MISSING', { SECRET: 'dontlogme' }), { message: 'Missing MISSING. Set it in your shell or CI environment.' });
});
