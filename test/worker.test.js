import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connectLocal, McpController, processBatch } from '../src/worker.js';
import { startReceiver, stopReceiver } from '../src/launcher.js';
import { loadConfig } from '../src/config.js';
import { requestClient } from '../src/storage.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notion-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  await writeFile(configFile, JSON.stringify({
    roots: [directory], token: 'test-only-token-01234567890123456789',
    notion: { deviceId: randomUUID(), pollSeconds: 5 },
  }));
  return loadConfig({ NOTION_MCP_CONFIG: configFile });
}

test('idle polling does not launch MCP and a task batch starts and closes one instance', async (t) => {
  const config = await fixture(t);
  let starts = 0;
  let closed = 0;
  let executed = 0;
  const state = { phase: 'waiting', mcpPid: null };
  const jobs = new Map();
  for (let count = 0; count < 2; count++) {
    jobs.set(randomUUID().replaceAll('-', ''), { status: 'pending', request: { version: 1, deviceId: config.notion.deviceId, tool: 'list_roots', arguments: {} } });
  }
  const queue = {
    async readJob(id) { return structuredClone(jobs.get(id)); },
    async markRunning(id) { jobs.get(id).status = 'running'; },
    async finish(id, status) { jobs.get(id).status = status; },
  };
  const startLocal = async () => {
    starts++;
    return {
      pid: 12345,
      client: { async callTool() { assert.equal(state.mcpPid, 12345); executed++; return { structuredContent: { roots: config.roots } }; } },
      async close() { closed++; },
    };
  };
  await processBatch({ ids: [], queue, config, state, startLocal });
  assert.equal(starts, 0);
  await processBatch({ ids: [...jobs.keys()], queue, config, state, startLocal });
  assert.equal(starts, 1);
  assert.equal(closed, 1);
  assert.equal(executed, 2);
  assert.equal(state.phase, 'waiting');
  assert.equal(state.mcpPid, null);
});

test('on-demand stdio MCP reads a file and its process exits after the batch', async (t) => {
  const config = await fixture(t);
  await writeFile(path.join(config.roots[0], 'example.txt'), '按需启动测试');
  const local = await connectLocal(config);
  t.after(() => local.close());
  assert.ok(local.pid);
  const result = await local.client.callTool({ name: 'read_file', arguments: { path: 'example.txt' } });
  assert.equal(result.structuredContent.content, '按需启动测试');
  await local.close();
  assert.throws(() => process.kill(local.pid, 0), { code: 'ESRCH' });
});

test('desktop launcher reuses the receiver and can stop it without starting MCP', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await fixture(t);
  t.after(() => stopReceiver(config.configFile));
  const first = await startReceiver(config);
  const second = await startReceiver(config);
  assert.equal(first.pid, second.pid);
  assert.equal(second.role, 'worker');
  assert.equal(second.mcpPid, null);
  await stopReceiver(config.configFile);
  assert.equal(await requestClient(path.join(path.dirname(config.configFile), '.runtime', 'client.lock')), null);
});

async function queuedControls(t, startLocal) {
  const config = await fixture(t);
  const state = { phase: 'waiting' };
  const mcp = new McpController({ config, state, startLocal });
  t.after(() => mcp.close());
  const jobs = new Map();
  const publishFailures = new Set();
  const queue = {
    async readJob(id) { return structuredClone(jobs.get(id)); },
    async markRunning(id) { jobs.get(id).status = 'running'; },
    async finish(id, status, result) {
      if (publishFailures.delete(id)) throw new Error('temporary publishing failure');
      Object.assign(jobs.get(id), { status, result });
    },
  };
  function create(tool, args, status = 'pending') {
    const id = randomUUID().replaceAll('-', '');
    jobs.set(id, { status, request: { version: 1, deviceId: config.notion.deviceId, tool, arguments: args } });
    return id;
  }
  async function run(id) {
    await processBatch({ ids: [id], queue, config, state, mcp });
    return jobs.get(id);
  }
  return { config, state, mcp, jobs, publishFailures, create, run };
}

test('queued manual controls keep MCP alive, block tasks while off, and restore on-demand execution', async (t) => {
  const controls = await queuedControls(t);
  await writeFile(path.join(controls.config.roots[0], 'example.txt'), 'Notion 手动开关');
  const control = (action) => controls.run(controls.create('mcp_control', { action }));
  const initial = await control('status');
  assert.equal(initial.status, 'succeeded');
  assert.equal(initial.result.mode, 'auto');
  assert.equal(initial.result.running, false);
  const started = await control('start');
  const pid = started.result.mcpPid;
  assert.ok(pid);
  assert.equal(started.result.mode, 'on');
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal((await control('start')).result.mcpPid, pid);
  const read = await controls.run(controls.create('read_file', { path: 'example.txt' }));
  assert.equal(read.result.content, 'Notion 手动开关');
  assert.equal(controls.state.mcpPid, pid);
  const stopped = await control('stop');
  assert.equal(stopped.result.mode, 'off');
  assert.equal(stopped.result.running, false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const blocked = await controls.run(controls.create('read_file', { path: 'example.txt' }));
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.result.code, 'MCP_DISABLED');
  const invalid = await controls.run(controls.create('mcp_control', { action: 'start', extra: true }));
  assert.equal(invalid.result.code, 'INVALID_REQUEST');
  assert.equal((await control('status')).result.mode, 'off');
  assert.equal((await control('auto')).result.mode, 'auto');
  assert.equal((await controls.run(controls.create('read_file', { path: 'example.txt' }))).status, 'succeeded');
  assert.equal(controls.state.mcpPid, null);
  assert.equal(controls.state.phase, 'waiting');
  const pinned = await control('start');
  await controls.mcp.close();
  assert.throws(() => process.kill(pinned.result.mcpPid, 0), { code: 'ESRCH' });
});

test('control result retries and orphaned commands do not repeat lifecycle changes', async (t) => {
  let starts = 0;
  const controls = await queuedControls(t, async () => {
    starts++;
    return { pid: 12345, client: {}, async close() {} };
  });
  const start = controls.create('mcp_control', { action: 'start' });
  controls.publishFailures.add(start);
  await controls.run(start);
  assert.equal(controls.jobs.get(start).status, 'running');
  await controls.run(controls.create('mcp_control', { action: 'stop' }));
  await controls.run(start);
  assert.equal(controls.jobs.get(start).status, 'succeeded');
  assert.equal(controls.state.mcpMode, 'off');
  assert.equal(controls.state.mcpPid, null);
  assert.equal(starts, 1);
  const orphan = await controls.run(controls.create('mcp_control', { action: 'start' }, 'running'));
  assert.equal(orphan.status, 'review');
  const status = await controls.run(controls.create('mcp_control', { action: 'status' }, 'running'));
  assert.equal(status.result.mode, 'off');
  assert.equal(starts, 1);
});

test('failed startup and unexpected child exit keep control status accurate and allow a later restart', async (t) => {
  let attempts = 0;
  const client = {};
  const controls = await queuedControls(t, async () => {
    attempts++;
    if (attempts === 1) throw new Error('startup failed');
    return { pid: 12345, client, async close() {} };
  });
  assert.equal((await controls.run(controls.create('mcp_control', { action: 'start' }))).status, 'review');
  assert.equal(controls.state.mcpMode, 'auto');
  assert.equal(controls.state.mcpPid, null);
  await controls.run(controls.create('mcp_control', { action: 'start' }));
  client.onclose();
  const status = await controls.run(controls.create('mcp_control', { action: 'status' }));
  assert.equal(status.result.mode, 'on');
  assert.equal(status.result.running, false);
  assert.equal(status.result.mcpPid, null);
  await controls.run(controls.create('mcp_control', { action: 'start' }));
  assert.equal(controls.state.mcpPid, 12345);
  assert.equal(attempts, 3);
});
