import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createHttpServer } from './server.js';
import { acquireLock } from './storage.js';

const config = await loadConfig();
const runtime = path.join(path.dirname(config.configFile), '.runtime');
await mkdir(runtime, { recursive: true });
let http;
let stopping = false;
let publicUrl;
let edgeConnected = false;
const unlock = await acquireLock(path.join(runtime, 'native.lock'), (command) => {
  if (command === 'stop') setTimeout(() => { void shutdown(); }, 100);
  return { role: 'native', phase: stopping ? 'stopping' : (http?.listening && edgeConnected ? 'ready' : 'connecting'), url: publicUrl };
});
const tunnel = spawn(path.join(runtime, 'cloudflared.exe'), [
  'tunnel', '--url', `http://127.0.0.1:${config.port}`, '--no-autoupdate', '--protocol', 'http2',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let starting = false;
let log = '';
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  tunnel.kill();
  if (http) {
    await http.closeTasks();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  await unlock();
}
const deadline = setTimeout(() => { console.error('HTTPS 隧道建立超时，请检查网络。'); process.exitCode = 1; void shutdown(); }, 60_000);
tunnel.once('error', (error) => { clearTimeout(deadline); console.error(`隧道启动失败 ${error.message}`); process.exitCode = 1; void shutdown(); });
tunnel.once('exit', () => { clearTimeout(deadline); void shutdown(); });
tunnel.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  log = (log + chunk.toString()).slice(-16000);
  if (chunk.toString().includes('Registered tunnel connection')) {
    edgeConnected = true;
    clearTimeout(deadline);
  }
  if (/Unable to establish connection|Serve tunnel error/.test(chunk.toString())) edgeConnected = false;
  const url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || starting) return;
  starting = true;
  void (async () => {
    http = createHttpServer({ ...config, publicUrl: url, approvalMode: 'host' });
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(config.port, '127.0.0.1', resolve); });
    const connection = { name: 'Notion-skill', url: `${url}/mcp`, headers: { Authorization: `Bearer ${config.token}` }, approvalMode: 'host' };
    await writeFile(path.join(runtime, 'native-connection.json'), JSON.stringify(connection, null, 2), { mode: 0o600 });
    publicUrl = connection.url;
    console.log(`本机 MCP 已启动，公网就绪状态请查询 native.ps1 -Action Status。地址 ${url}/mcp`);
    console.log('认证信息保存在 .runtime/native-connection.json。在 Notion 自定义 MCP 中填写 URL 和 Authorization 请求头。');
    console.log('在 Notion 聊天中选择 Review for me，审批由 Notion 管理。使用 native.ps1 -Action Stop 停止。临时地址重新启动后会改变。');
  })().catch((error) => { console.error(error.message); process.exitCode = 1; void shutdown(); });
});
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
