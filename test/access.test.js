import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowPath, loadConfig } from '../src/config.js';
import { LocalFiles } from '../src/filesystem.js';

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
