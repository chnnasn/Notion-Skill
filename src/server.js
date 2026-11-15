import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp.js';
import { LocalFiles } from './filesystem.js';
import { DesktopControl } from './desktop.js';
import { confirmLocally, hostApproval } from './approval.js';
import { CommandTasks } from './command-tasks.js';

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

export function createHttpServer(config, desktop, confirm = config.approvalMode === 'host' ? hostApproval : confirmLocally) {
  const tasks = new CommandTasks(path.join(path.dirname(config.configFile), '.runtime', 'tasks'));
  desktop ||= new DesktopControl(config, new LocalFiles(
    config.roots, [config.configFile, path.join(path.dirname(config.configFile), '.runtime')], config.accessMode,
  ), undefined, confirm);
  const expectedToken = digest(`Bearer ${config.token}`);
  const publicHost = config.publicUrl ? new URL(config.publicUrl).host : null;
  const origins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    'https://www.notion.so',
    'https://www.notion.com',
  ]);
  if (config.publicUrl) {
    origins.add(config.publicUrl);
  }

  const http = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16384 }, async (request, response) => {
    const localPort = request.socket.localPort;
    const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`, publicHost];
    if (!hosts.includes(request.headers.host?.toLowerCase())) {
      json(response, 403, { error: 'Host is not allowed. Set publicUrl or use the tunnel HTTP Host override.' });
      return;
    }
    if (request.headers.origin && !origins.has(request.headers.origin)) {
      json(response, 403, { error: 'Origin is not allowed.' });
      return;
    }
    const endpoint = request.url?.split('?')[0];
    if (endpoint === '/health' && request.method === 'GET') {
      json(response, 200, { status: 'ok', service: 'notion-local-files' });
      return;
    }
    if (endpoint !== '/mcp') {
      json(response, 404, { error: 'Use /mcp for MCP requests.' });
      return;
    }
    if (!timingSafeEqual(expectedToken, digest(request.headers.authorization || ''))) {
      json(response, 401, { error: 'A valid Bearer token is required.' }, { 'WWW-Authenticate': 'Bearer realm="notion-local-files"' });
      return;
    }
    if (request.method !== 'POST') {
      json(response, 405, { error: 'Use POST for stateless Streamable HTTP.' }, { Allow: 'POST' });
      return;
    }

    const server = createMcpServer(config, desktop, confirm, config.approvalMode === 'host' ? tasks : undefined);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.setHeader('Cache-Control', 'no-store');
    response.once('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) json(response, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
      else response.end();
      await server.close().catch(() => {});
    }
  });
  http.closeTasks = () => tasks.close();
  return http;
}

async function main() {
  const config = await loadConfig();
  const http = createHttpServer(config);
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, '127.0.0.1', resolve);
  });
  console.log(`MCP 服务已启动 http://127.0.0.1:${config.port}/mcp`);
  console.log(config.accessMode === 'all'
    ? '全电脑访问已开启，使用当前操作系统账户权限。认证已启用。按 Ctrl+C 停止。'
    : `可访问 ${config.roots.length} 个目录，认证已启用。按 Ctrl+C 停止。`);
  const shutdown = () => {
    void http.closeTasks();
    http.close();
    const timer = setTimeout(() => http.closeAllConnections(), 5000);
    timer.unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`启动失败。${error.message}`);
    process.exitCode = 1;
  });
}
