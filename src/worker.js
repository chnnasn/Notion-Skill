import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from './config.js';
import { connectNotion } from './notion-auth.js';
import { NotionQueue } from './notion-queue.js';
import { JobRunner } from './jobs.js';
import { acquireLock } from './storage.js';

export async function connectLocal(config) {
  const client = new Client({ name: 'notion-local-worker', version: '0.2.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'stdio.js')],
    env: { NOTION_MCP_CONFIG: config.configFile },
    cwd: path.dirname(config.configFile),
  });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw error; }
  return { client, pid: transport.pid, close: () => client.close() };
}

export async function processBatch({ ids, queue, config, signal, state = {}, startLocal = connectLocal }) {
  if (!ids.length || signal?.aborted) return;
  const local = await startLocal(config);
  state.phase = 'executing';
  state.mcpPid = local.pid;
  console.log(`MCP 已按任务启动，进程 ${local.pid}`);
  try {
    const runner = new JobRunner({
      queue, client: local.client, deviceId: config.notion.deviceId,
      journalDirectory: path.join(path.dirname(config.configFile), '.runtime', 'jobs'),
    });
    for (const id of ids) {
      if (signal?.aborted) break;
      try { await runner.run(id); console.log(`任务处理完成 ${id}`); }
      catch (error) { console.error(`任务 ${id} 将重试 ${error.message}`); }
    }
  } finally {
    await local.close();
    state.mcpPid = null;
    state.phase = signal?.aborted ? 'stopping' : 'waiting';
    console.log('本批任务处理结束，MCP 已关闭。');
  }
}

export async function runWorker({ once = false, signal: externalSignal } = {}) {
  const config = await loadConfig();
  if (!config.notion) throw new Error('请先运行 npm run login。');
  const runtime = path.join(path.dirname(config.configFile), '.runtime');
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const state = { role: 'worker', phase: 'connecting', mcpPid: null };
  const unlock = await acquireLock(path.join(runtime, 'client.lock'), (command) => {
    if (command === 'stop') { state.phase = 'stopping'; controller.abort(); }
    return state;
  });
  let remote;
  try {
    let failures = 0;
    while (!signal?.aborted) {
      try {
        if (!remote) {
          remote = await connectNotion(config);
          state.phase = 'waiting';
          console.log('Notion 已连接，正在等待本机任务。');
        }
        const queue = new NotionQueue(remote, config.notion.deviceId);
        const ids = await queue.discover();
        await processBatch({ ids, queue, config, signal, state });
        failures = 0;
      } catch (error) {
        console.error(`连接暂不可用 ${error.message}`);
        await remote?.close().catch(() => {});
        remote = undefined;
        state.phase = 'reconnecting';
        failures++;
        if (once) throw error;
      }
      if (once) break;
      await delay(Math.min(60, config.notion.pollSeconds * (1 + failures)) * 1000, undefined, { signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  } finally {
    await remote?.close().catch(() => {});
    await unlock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runWorker({ once: process.argv.includes('--once'), signal: controller.signal }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
