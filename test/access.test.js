import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { LocalFiles } from '../src/filesystem.js';

test('all access ignores old root restrictions and grants while protecting service configuration', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-all-access-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, '.runtime');
  await mkdir(runtime);
  const configFile = path.join(directory, 'config.json');
  const root = path.join(directory, 'old-unavailable-root');
  await writeFile(configFile, JSON.stringify({
    accessMode: 'all', roots: [root], token: 'test-only-token-01234567890123456789',
  }));
  const grants = path.join(runtime, 'access.json');
  await writeFile(grants, 'old-invalid-grants');
  const config = await loadConfig({ NOTION_MCP_CONFIG: configFile });
  assert.equal(config.accessMode, 'all');
  assert.deepEqual(config.roots, [root]);
  const target = path.join(directory, 'report.md');
  await writeFile(target, '全电脑访问');
  const files = new LocalFiles(config.roots, [configFile, runtime], config.accessMode);
  assert.equal((await files.readFile(target, 0, 100, 'utf8')).content, '全电脑访问');
  assert.equal((await files.readFile('../report.md', 0, 100, 'utf8')).content, '全电脑访问');
  const hardlink = path.join(directory, 'config-hardlink');
  await link(configFile, hardlink);
  for (const protectedPath of [configFile, hardlink, grants]) {
    await assert.rejects(files.resolve(protectedPath), { code: 'ACCESS_DENIED' });
  }
  assert.equal(await readFile(grants, 'utf8'), 'old-invalid-grants');
});

test('saved directory grants remain readable after migration to native MCP', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-access-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'original');
  const outside = path.join(directory, 'requested');
  const runtime = path.join(root, '.runtime');
  await mkdir(runtime, { recursive: true });
  await mkdir(outside);
  const configFile = path.join(root, 'config.json');
  await writeFile(configFile, JSON.stringify({ roots: [root], token: 'test-only-token-01234567890123456789' }));
  await writeFile(path.join(runtime, 'access.json'), JSON.stringify({ roots: [outside] }));
  const config = await loadConfig({ NOTION_MCP_CONFIG: configFile });
  assert.equal(config.approvalMode, 'host');
  assert.deepEqual(config.roots, [root, outside]);
  await writeFile(path.join(outside, 'report.txt'), 'retained access');
  assert.equal((await new LocalFiles(config.roots).readFile(path.join(outside, 'report.txt'), 0, 100, 'utf8')).content, 'retained access');
});
