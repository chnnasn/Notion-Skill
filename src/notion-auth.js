import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { readSecret, saveSecret } from './storage.js';
import { windowsDesktop } from './desktop.js';

export const NOTION_MCP_URL = new URL('https://mcp.notion.com/mcp');

async function fetchWithConnectRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, init); }
    catch (error) {
      const cause = error.cause;
      const beforeRequest = cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
        || (cause?.code === 'ECONNRESET' && cause.message.includes('before secure TLS connection was established'));
      if (!beforeRequest || attempt >= 3 || init?.signal?.aborted) throw error;
      await delay(500 * (attempt + 1));
    }
  }
}

export function validState(expected, received) {
  const left = Buffer.from(expected);
  const right = Buffer.from(received || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function connectNotion(config, { interactive = false, openBrowser = (url) => windowsDesktop.open(url, false) } = {}) {
  const runtime = path.join(path.dirname(config.configFile), '.runtime');
  const filename = path.join(runtime, 'notion-auth.json');
  const state = randomBytes(32).toString('base64url');
  const port = config.notion.oauthPort;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  let saved = await readSecret(filename);
  if (saved.redirectUrl && saved.redirectUrl !== redirectUrl) saved = {};
  if (!interactive && !saved.tokens) throw new Error('请先运行 npm run login 完成 Notion 登录。');
  let verifier;
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone({ ...saved, redirectUrl });
    writes = writes.then(() => saveSecret(filename, snapshot));
    return writes;
  };
  const provider = {
    redirectUrl,
    clientMetadata: {
      client_name: 'Notion Local Computer',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    state: () => state,
    clientInformation: () => saved.client,
    saveClientInformation: async (value) => { saved.client = value; await persist(); },
    tokens: () => saved.tokens,
    saveTokens: async (value) => { saved.tokens = value; await persist(); },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier,
    discoveryState: () => saved.discovery,
    saveDiscoveryState: async (value) => { saved.discovery = value; await persist(); },
    async invalidateCredentials(scope) {
      if (scope === 'all') saved = {};
      if (scope === 'tokens') delete saved.tokens;
      if (scope === 'client') delete saved.client;
      if (scope === 'discovery') delete saved.discovery;
      if (scope === 'verifier') verifier = undefined;
      await persist();
    },
    async redirectToAuthorization(url) {
      if (!interactive) throw new Error('Notion 授权需要更新，请重新运行 npm run login。');
      if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*notion\.(com|so)$/.test(url.hostname)) {
        throw new Error('Notion 授权地址校验失败。');
      }
      console.log('请在浏览器中登录 Notion 并授权本地客户端。');
      await openBrowser(url.href);
    },
  };
  let callback;
  let timer;
  let receiveCode;
  let rejectCode;
  const code = new Promise((resolve, reject) => { receiveCode = resolve; rejectCode = reject; });
  // A discovery failure may happen before the OAuth callback is awaited.
  void code.catch(() => {});
  if (interactive) {
    callback = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      const url = new URL(request.url, redirectUrl);
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}` || url.pathname !== '/callback' || !validState(state, url.searchParams.get('state'))) {
        response.writeHead(400).end('授权回调无效，请从客户端重新登录。');
        return;
      }
      if (url.searchParams.has('error')) {
        response.writeHead(400).end('授权未完成，可以返回客户端重试。');
        rejectCode(new Error('Notion 授权未完成。'));
        return;
      }
      const authorizationCode = url.searchParams.get('code');
      if (!authorizationCode) { response.writeHead(400).end('缺少授权码。'); return; }
      response.end('已收到授权回调，正在完成连接。请返回客户端查看结果。');
      receiveCode(authorizationCode);
    });
    await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(port, '127.0.0.1', resolve); });
    timer = setTimeout(() => rejectCode(new Error('登录等待已超时，请重新运行 npm run login。')), 10 * 60_000);
  }
  const createClient = () => new Client({ name: 'notion-local-computer', version: '0.2.0' });
  const createTransport = () => new StreamableHTTPClientTransport(NOTION_MCP_URL, { authProvider: provider, fetch: fetchWithConnectRetry });
  let client = createClient();
  let transport = createTransport();
  try {
    try { await client.connect(transport); }
    catch (error) {
      if (!(error instanceof UnauthorizedError) || !interactive) throw error;
      await transport.finishAuth(await code);
      await client.close();
      client = createClient();
      transport = createTransport();
      await client.connect(transport);
    }
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    if (callback) {
      callback.closeAllConnections();
      await new Promise((resolve) => callback.close(resolve));
    }
  }
}
