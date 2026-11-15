import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { allowPath, loadConfig } from './config.js';
import { FileAccessError } from './filesystem.js';
import { connectNotion } from './notion-auth.js';
import { NotionQueue } from './notion-queue.js';
import { JobRunner } from './jobs.js';
import { acquireLock } from './storage.js';
import { commandSchema } from './commands.js';
import { APPROVAL_TIMEOUT_MS } from './approval.js';

export async function connectLocal(config) {
  const client = new Client({ name: 'notion-local-worker', version: '0.2.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'stdio.js')],
    env: { ...process.env, NOTION_MCP_CONFIG: config.configFile },
    cwd: path.dirname(config.configFile),
  });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw error; }
  return { client, pid: transport.pid, close: () => client.close() };
}

export class McpController {
  constructor({ config, state = {}, startLocal = connectLocal }) {
    this.config = config;
    this.state = state;
    this.startLocal = startLocal;
    this.local = null;
    this.state.mcpMode = 'auto';
    this.state.mcpPid = null;
  }

  snapshot() {
    return {
      mode: this.state.mcpMode,
      running: this.local !== null,
      mcpPid: this.state.mcpPid,
      receiverPid: process.pid,
      scope: 'receiver_session',
      checkedAt: new Date().toISOString(),
    };
  }

  async start() {
    if (this.local) return;
    const local = await this.startLocal(this.config);
    this.local = local;
    this.state.mcpPid = local.pid;
    const onclose = local.client.onclose;
    local.client.onclose = () => {
      if (this.local === local) {
        this.local = null;
        this.state.mcpPid = null;
      }
      onclose?.();
    };
    console.log(`MCP 已启动，进程 ${local.pid}`);
  }

  async close() {
    if (!this.local) return;
    const local = this.local;
    await local.close();
    if (this.local === local) {
      this.local = null;
      this.state.mcpPid = null;
    }
    console.log('MCP 已关闭。');
  }

  async releaseIdle() {
    if (this.state.mcpMode !== 'on') await this.close();
  }

  async callTool(request) {
    if (request.name === 'mcp_control') {
      switch (request.arguments.action) {
        case 'start':
          await this.start();
          this.state.mcpMode = 'on';
          break;
        case 'stop':
          this.state.mcpMode = 'off';
          await this.close();
          break;
        case 'auto':
          this.state.mcpMode = 'auto';
          await this.close();
          break;
        case 'status':
          break;
        default:
          throw new Error('未知 MCP 控制动作。');
      }
      const result = this.snapshot();
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (this.state.mcpMode === 'off') {
      const result = { code: 'MCP_DISABLED', message: 'MCP 已手动关闭。请在 Notion 中开启 MCP，或恢复按需启动后新建任务。' };
      return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (request.name === 'allow_path') {
      let result;
      try { result = await allowPath(this.config, request.arguments.path); }
      catch (error) {
        if (!(error instanceof FileAccessError) && !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
        result = { code: error.code, message: error.message };
        return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      await this.close();
      if (this.state.mcpMode === 'on') await this.start();
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    await this.start();
    if (request.name === 'run_command') {
      const args = commandSchema.parse(request.arguments);
      return this.local.client.callTool({ ...request, arguments: args }, undefined, { timeout: args.timeout_ms + APPROVAL_TIMEOUT_MS + 30_000 });
    }
    if (['ensure_app', 'open_path', 'write_file', 'create_directory', 'copy_file'].includes(request.name)) {
      return this.local.client.callTool(request, undefined, { timeout: APPROVAL_TIMEOUT_MS + 60_000 });
    }
    return this.local.client.callTool(request);
  }
}

export async function processBatch({
  ids, queue, config, signal, state = {}, startLocal = connectLocal,
  mcp = new McpController({ config, state, startLocal }),
}) {
  if (!ids.length || signal?.aborted) return;
  state.phase = 'executing';
  try {
    const runner = new JobRunner({
      queue, client: mcp, deviceId: config.notion.deviceId,
      journalDirectory: path.join(path.dirname(config.configFile), '.runtime', 'jobs'),
    });
    for (const id of ids) {
      if (signal?.aborted) break;
      try { await runner.run(id); console.log(`任务处理完成 ${id}`); }
      catch (error) { console.error(`任务 ${id} 将重试 ${error.message}`); }
    }
  } finally {
    try { await mcp.releaseIdle(); }
    finally { state.phase = signal?.aborted ? 'stopping' : 'waiting'; }
  }
}

export async function runWorker({ once = false, signal: externalSignal } = {}) {
  const config = await loadConfig();
  if (!config.notion) throw new Error('请先运行 npm run login。');
  const runtime = path.join(path.dirname(config.configFile), '.runtime');
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const state = { role: 'worker', phase: 'connecting', mcpPid: null };
  const mcp = new McpController({ config, state });
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
        await processBatch({ ids, queue, config, signal, state, mcp });
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
    try { await mcp.close(); }
    finally {
      await remote?.close().catch(() => {});
      await unlock();
    }
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
