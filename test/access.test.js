import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowPath, loadConfig } from '../src/config.js';
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
    await assert.rejects(allowPath(config, protectedPath), { code: 'ACCESS_DENIED' });
  }
  const allowed = await allowPath(config, target);
  assert.equal(allowed.status, 'already_allowed');
  assert.equal(allowed.access_mode, 'all');
  assert.equal(allowed.added_root, null);
  assert.equal(await readFile(grants, 'utf8'), 'old-invalid-grants');
});

test('task-based directory grants persist canonical paths and retain configuration protections', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-access-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'original');
  const outside = path.join(directory, 'requested');
  const runtime = path.join(root, '.runtime');
  await mkdir(runtime, { recursive: true });
  await mkdir(outside);
  const configFile = path.join(root, 'config.json');
  const raw = JSON.stringify({ roots: [root], token: 'test-only-token-01234567890123456789' });
  await writeFile(configFile, raw);
  const target = path.join(outside, 'report.md');
  await writeFile(target, '按任务访问');
  const hardlink = path.join(outside, 'config-copy.json');
  await link(configFile, hardlink);
  const alias = path.join(directory, 'alias');
  await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const config = await loadConfig({ NOTION_MCP_CONFIG: configFile });
  assert.equal(config.accessMode, 'restricted');
  await assert.rejects(new LocalFiles(config.roots).resolve(target), { code: 'ACCESS_DENIED' });

  const allowed = await allowPath(config, path.join(alias, 'report.md'));
  assert.equal(allowed.status, 'allowed');
  assert.equal(allowed.path, target);
  assert.equal(allowed.added_root, outside);
  assert.deepEqual(allowed.roots, [root, outside]);
  assert.equal((await allowPath(config, outside)).status, 'already_allowed');
  assert.equal(await readFile(configFile, 'utf8'), raw);
  const restored = await loadConfig({ NOTION_MCP_CONFIG: configFile });
  assert.deepEqual(restored.roots, [root, outside]);
  const files = new LocalFiles(restored.roots, [configFile, runtime]);
  assert.equal(await files.resolve(target), target);
  await assert.rejects(files.resolve(hardlink), { code: 'ACCESS_DENIED' });
  for (const protectedPath of [configFile, runtime, hardlink]) {
    await assert.rejects(allowPath(config, protectedPath), { code: 'ACCESS_DENIED' });
  }
  await assert.rejects(allowPath(config, 'relative/path'), { code: 'ABSOLUTE_PATH_REQUIRED' });
  await assert.rejects(allowPath(config, path.join(directory, 'missing')), { code: 'ENOENT' });
  if (process.platform === 'win32') {
    for (const invalid of ['\\\\?\\C:\\Windows', `${target}:stream`, 'C:relative', '\\relative']) {
      await assert.rejects(allowPath(config, invalid));
    }
  }
  await rm(outside, { recursive: true });
  const offline = await loadConfig({ NOTION_MCP_CONFIG: configFile });
  assert.deepEqual(offline.roots, [root, outside]);
  assert.equal(await new LocalFiles(offline.roots).resolve(root), root);
});
