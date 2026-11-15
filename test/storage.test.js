import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireLock, readSecret, saveSecret } from '../src/storage.js';
import { validState } from '../src/notion-auth.js';

test('client lock prevents simultaneous installers and OAuth state is validated', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notion-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'client.lock');
  const release = await acquireLock(filename);
  await assert.rejects(acquireLock(filename), /已运行/);
  await release();
  await (await acquireLock(filename))();
  assert.equal(validState('random-test-state', 'random-test-state'), true);
  assert.equal(validState('random-test-state', 'wrong'), false);
  assert.equal(validState('random-test-state', null), false);
});

test('Windows DPAPI persists credentials encrypted for the current user', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notion-secret-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'auth.json');
  const value = { tokens: { access_token: 'test-only-token', issuer: 'https://mcp.notion.com' } };
  await saveSecret(filename, value);
  assert.deepEqual(await readSecret(filename), value);
});
