import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JobRunner } from '../src/jobs.js';
import { acquireLock, readSecret, saveSecret } from '../src/storage.js';
import { validState } from '../src/notion-auth.js';

test('queued jobs recover result publishing failures without repeating desktop actions', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notion-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceId = randomUUID();
  const id = randomUUID();
  const job = { status: 'pending', request: { version: 1, deviceId, tool: 'open_path', arguments: { path: '.' } } };
  let calls = 0;
  let failures = 1;
  const queue = {
    async readJob() { return structuredClone(job); },
    async markRunning() { job.status = 'running'; },
    async finish(jobId, status, result) {
      if (failures-- > 0) throw new Error('temporary publishing failure');
      Object.assign(job, { status, result });
    },
  };
  const client = { async callTool() { calls++; return { structuredContent: { status: 'open_requested' } }; } };
  const runner = new JobRunner({ queue, client, deviceId, journalDirectory: directory });
  await assert.rejects(runner.run(id), /publishing failure/);
  await runner.run(id);
  assert.equal(calls, 1);
  assert.equal(job.status, 'succeeded');
  job.status = 'pending';
  await runner.run(id);
  assert.equal(calls, 1);
  job.status = 'pending';
  job.request.arguments.path = 'changed';
  await runner.run(id);
  assert.equal(job.status, 'review');
  assert.equal(calls, 1);
});

test('orphan running actions require review while read operations can recover', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notion-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceId = randomUUID();
  let calls = 0;
  const job = { status: 'running', request: { version: 1, deviceId, tool: 'ensure_app', arguments: { name: 'notepad' } } };
  const queue = {
    async readJob() { return structuredClone(job); },
    async markRunning() { job.status = 'running'; },
    async finish(id, status, result) { Object.assign(job, { status, result }); },
  };
  const client = { async callTool() { calls++; return { structuredContent: { roots: ['example'] } }; } };
  const runner = new JobRunner({ queue, client, deviceId, journalDirectory: directory });
  await runner.run(randomUUID());
  assert.equal(job.status, 'review');
  assert.equal(calls, 0);
  job.status = 'running';
  job.request.tool = 'list_roots';
  job.request.arguments = {};
  await runner.run(randomUUID());
  assert.equal(job.status, 'succeeded');
  assert.equal(calls, 1);
  job.status = 'pending';
  job.request.deviceId = randomUUID();
  await runner.run(randomUUID());
  assert.equal(calls, 1);
});

test('client lock prevents simultaneous workers and OAuth state is validated', { skip: process.platform !== 'win32' }, async (t) => {
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
