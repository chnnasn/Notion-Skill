import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { acquireLock, requestClient } from '../src/storage.js';

test('native CLI reuses the current service and stops it through its own control endpoint', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notion-native-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, '.runtime', 'native.lock');
  let release;
  release = await acquireLock(lock, (command) => {
    if (command === 'stop') setTimeout(() => { void release(); }, 100);
    return { role: 'native', phase: 'ready', url: 'https://native.example.com/mcp' };
  });
  const run = (action) => promisify(execFile)(process.execPath, [path.resolve('src/runtime.js'), action], {
    env: { ...process.env, NOTION_MCP_CONFIG: path.join(directory, 'config.json') }, windowsHide: true,
  });
  assert.equal(JSON.parse((await run('start')).stdout).role, 'native');
  assert.equal(JSON.parse((await run('status')).stdout).phase, 'ready');
  await run('stop');
  assert.equal(await requestClient(lock), null);
});
