import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

test('queued full-computer reads start stdio MCP with all access and no directory grant', async (t) => {
  const controls = await queuedControls(t);
  const filename = controls.config.configFile;
  const raw = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(filename, JSON.stringify({ ...raw, accessMode: 'all' }));
  Object.assign(controls.config, await loadConfig({ NOTION_MCP_CONFIG: filename }));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-full-read-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'report.md');
  await writeFile(target, '直接读取其他目录');
  const result = await controls.run(controls.create('read_file', { path: target }));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.content, '直接读取其他目录');
  assert.equal(controls.state.mcpPid, null);
  assert.equal(controls.state.phase, 'waiting');
  const roots = await controls.run(controls.create('list_roots', {}));
  assert.equal(roots.result.access_mode, 'all');
  assert.ok(roots.result.roots.includes(path.parse(outside).root));
  await assert.rejects(readFile(path.join(path.dirname(filename), '.runtime', 'access.json')), { code: 'ENOENT' });
});

test('queued low-risk commands execute automatically through stdio and respect manual off mode', { skip: process.platform !== 'win32' }, async (t) => {
  const controls = await queuedControls(t);
  const args = { command: 'node --version', cwd: controls.config.roots[0], risk: { level: 'low', reason: '查询运行时版本' } };
  const job = await controls.run(controls.create('run_command', args));
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.stdout.trim(), process.version);
  assert.equal(job.result.safety.decision, 'automatic');
  assert.equal(controls.state.mcpPid, null);
  await controls.run(controls.create('mcp_control', { action: 'stop' }));
  const blocked = await controls.run(controls.create('run_command', args));
  assert.equal(blocked.result.code, 'MCP_DISABLED');
});

test('command MCP transport timeout includes the requested runtime and cleanup time', async (t) => {
  let options;
  const controls = await queuedControls(t, async () => ({
    pid: 12345,
    client: { async callTool(request, schema, requestOptions) {
      options = requestOptions;
      return { structuredContent: { status: 'completed', stdout: 'done', exit_code: 0 } };
    } },
    async close() {},
  }));
  const job = await controls.run(controls.create('run_command', { command: 'Write-Output done', timeout_ms: 120_000 }));
  assert.equal(job.status, 'succeeded');
  assert.equal(options.timeout, 270_000);
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

test('queued path grants enable a requested file and reload a running MCP while respecting manual off mode', async (t) => {
  const controls = await queuedControls(t);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-new-root-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  await mkdir(first);
  await mkdir(second);
  const filename = path.join(first, 'report.md');
  await writeFile(filename, '根据任务授权');
  const denied = await controls.run(controls.create('read_file', { path: filename }));
  assert.equal(denied.result.code, 'ACCESS_DENIED');
  const granted = await controls.run(controls.create('allow_path', { path: filename }));
  assert.equal(granted.status, 'succeeded');
  assert.equal(granted.result.added_root, first);
  assert.equal(controls.state.mcpPid, null);
  const read = await controls.run(controls.create('read_file', { path: granted.result.path }));
  assert.equal(read.result.content, '根据任务授权');
  await controls.run(controls.create('mcp_control', { action: 'start' }));
  const oldPid = controls.state.mcpPid;
  const next = controls.create('allow_path', { path: second });
  controls.publishFailures.add(next);
  await controls.run(next);
  assert.equal(controls.state.mcpMode, 'on');
  assert.ok(controls.state.mcpPid);
  assert.notEqual(controls.state.mcpPid, oldPid);
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  const newPid = controls.state.mcpPid;
  await controls.run(next);
  assert.equal(controls.state.mcpPid, newPid);
  const roots = await controls.run(controls.create('list_roots', {}));
  assert.ok(roots.result.roots.includes(second));
  await controls.run(controls.create('mcp_control', { action: 'stop' }));
  const blocked = await controls.run(controls.create('allow_path', { path: directory }));
  assert.equal(blocked.result.code, 'MCP_DISABLED');
  const restored = await loadConfig({ NOTION_MCP_CONFIG: controls.config.configFile });
  assert.deepEqual(restored.roots, controls.config.roots);
  assert.equal(restored.roots.includes(directory), false);
});
