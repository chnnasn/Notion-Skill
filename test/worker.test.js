import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connectLocal, processBatch } from '../src/worker.js';
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
