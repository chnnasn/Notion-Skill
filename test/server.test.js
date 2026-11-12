import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONFIG_FILENAME, loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const token = 'test-token-for-local-mcp-integration-0123456789';
let temp, root, outside, configFile, config, http, url, client;

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  return { response, value: JSON.parse(response.content[0].text) };
}

async function rawRequest(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: body ? 'POST' : 'GET', headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function runScript(script, args, env) {
  const child = spawn(process.execPath, [path.join(project, 'src', script), ...args], {
    cwd: project,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'exit');
  return { code, output };
}

before(async () => {
  temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-mcp-test-')));
  root = path.join(temp, 'allowed');
  outside = path.join(temp, 'allowed-other');
  await mkdir(path.join(root, '子目录'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, '中文文件.txt'), '你好，Notion！\n第二行 😀\n');
  await writeFile(path.join(root, 'utf16.txt'), Buffer.from('\uFEFF你好，Windows 😀', 'utf16le'));
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 255, 128, 1, 2]));
  await writeFile(path.join(root, '子目录', 'report.md'), '# Report\nLocal file content');
  await writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  configFile = path.join(root, CONFIG_FILENAME);
  await writeFile(configFile, JSON.stringify({ roots: [root], token, port: 3210 }));
  await link(configFile, path.join(root, 'config-hardlink'));
  await symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.join(root, '子目录'), path.join(root, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  config = await loadConfig({ NOTION_MCP_CONFIG: configFile });
  http = createHttpServer(config);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  client = new Client({ name: 'notion-local-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
});

after(async () => {
  await client?.close();
  if (http?.listening) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  if (temp) await rm(temp, { recursive: true, force: true });
});

test('official MCP client discovers read tools and a command action with accurate annotations', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_path_info', 'list_directory', 'list_roots', 'read_file', 'run_command', 'search_files']);
  assert.ok(tools.filter((tool) => tool.name !== 'run_command').every((tool) => tool.annotations.readOnlyHint));
  assert.equal(tools.find((tool) => tool.name === 'run_command').annotations.destructiveHint, true);
  const { value } = await call('list_roots');
  assert.equal(value.access_mode, 'restricted');
  assert.deepEqual(value.roots, [root]);
  assert.equal(typeof value.locations, 'object');
  assert.ok(path.isAbsolute(value.locations.home));
  if (process.platform === 'win32') assert.ok(path.isAbsolute(value.locations.desktop));
});

test('HTTP command execution returns failure details and validates arguments', { skip: process.platform !== 'win32' }, async () => {
  const success = await call('run_command', { command: 'Write-Output "HTTP命令"', cwd: root });
  assert.ok(!success.response.isError);
  assert.equal(success.value.stdout.trim(), 'HTTP命令');
  const failure = await call('run_command', { command: '[Console]::Error.WriteLine("失败详情"); exit 9', cwd: root });
  assert.equal(failure.response.isError, true);
  assert.equal(failure.value.exit_code, 9);
  assert.equal(failure.value.stderr.trim(), '失败详情');
  const invalid = await client.callTool({ name: 'run_command', arguments: { command: 'Write-Output never', timeout_ms: -1 } });
  assert.equal(invalid.isError, true);
});

test('directory pagination, Chinese paths, path metadata, and search work over HTTP', async () => {
  const names = [];
  let offset = 0;
  do {
    const { value } = await call('list_directory', { limit: 2, offset });
    names.push(...value.entries.map((entry) => entry.name));
    offset = value.next_offset;
  } while (offset !== null);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('中文文件.txt'));
  assert.ok(!names.includes(CONFIG_FILENAME));
  assert.ok(!names.includes('config-hardlink'));
  assert.ok(!names.includes('outside-link'));
  const info = await call('get_path_info', { path: '子目录/report.md' });
  assert.equal(info.value.type, 'file');
  assert.equal(info.value.path, path.join(root, '子目录', 'report.md'));
  const search = await call('search_files', { query: 'REPORT' });
  assert.equal(search.value.results.length, 1);
  assert.equal(search.value.results[0].path, info.value.path);
  const limited = await call('search_files', { query: '.txt', limit: 1 });
  assert.equal(limited.value.stop_reason, 'result_limit');
});

test('UTF-8 and UTF-16 chunks preserve multibyte characters and progress to EOF', async () => {
  for (const [filename, encoding] of [['中文文件.txt', 'utf8'], ['utf16.txt', 'utf16le']]) {
    let combined = '';
    let offset = 0;
    do {
      const { response, value } = await call('read_file', { path: filename, encoding, offset, length: 5 });
      assert.ok(!response.isError, JSON.stringify(value));
      combined += value.content;
      assert.ok(value.next_offset === null || value.next_offset > offset);
      offset = value.next_offset;
    } while (offset !== null);
    assert.equal(combined, await readFile(path.join(root, filename), encoding));
  }
  assert.equal((await call('read_file', { path: 'empty.txt' })).value.content, '');
  const binary = await call('read_file', { path: 'binary.bin', encoding: 'base64' });
  assert.deepEqual(Buffer.from(binary.value.content, 'base64'), Buffer.from([0, 255, 128, 1, 2]));
});

test('directory traversal, sibling prefixes, external junctions, and config hardlinks are blocked', async () => {
  for (const input of ['../allowed-other/secret.txt', path.join(outside, 'secret.txt'), 'outside-link/secret.txt', CONFIG_FILENAME, 'config-hardlink']) {
    const { response, value } = await call('read_file', { path: input });
    assert.equal(response.isError, true, input);
    assert.equal(value.code, 'ACCESS_DENIED', input);
    assert.ok(!JSON.stringify(response).includes('outside secret'));
    assert.ok(!JSON.stringify(response).includes(token));
  }
  const allowed = await call('read_file', { path: 'inside-link/report.md' });
  assert.equal(allowed.value.content, '# Report\nLocal file content');
});

test('all access works through HTTP for external directories, files, and junctions', async (t) => {
  const fullServer = createHttpServer({ ...config, accessMode: 'all' });
  fullServer.listen(0, '127.0.0.1');
  await once(fullServer, 'listening');
  const fullClient = new Client({ name: 'all-access-test', version: '1' });
  t.after(async () => {
    await fullClient.close();
    fullServer.closeAllConnections();
    await new Promise((resolve) => fullServer.close(resolve));
  });
  await fullClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${fullServer.address().port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const invoke = (name, args = {}) => fullClient.callTool({ name, arguments: args });
  const roots = await invoke('list_roots');
  assert.equal(roots.structuredContent.access_mode, 'all');
  assert.equal(roots.structuredContent.relative_path_base, root);
  assert.ok(roots.structuredContent.roots.includes(path.parse(outside).root));
  for (const filename of [path.join(outside, 'secret.txt'), '../allowed-other/secret.txt', 'outside-link/secret.txt']) {
    assert.equal((await invoke('read_file', { path: filename })).structuredContent.content, 'outside secret');
  }
  const listing = await invoke('list_directory', { path: outside });
  assert.ok(listing.structuredContent.entries.some((entry) => entry.name === 'secret.txt'));
  const search = await invoke('search_files', { path: outside, query: 'secret' });
  assert.equal(search.structuredContent.results[0].path, path.join(outside, 'secret.txt'));
  const info = await invoke('get_path_info', { path: outside });
  assert.equal(info.structuredContent.type, 'directory');
  for (const filename of [configFile, 'config-hardlink']) {
    const protectedResult = await invoke('read_file', { path: filename });
    assert.equal(protectedResult.isError, true);
    assert.equal(JSON.parse(protectedResult.content[0].text).code, 'ACCESS_DENIED');
  }
});

test('Windows device paths and alternate data streams are rejected', { skip: process.platform !== 'win32' }, async () => {
  for (const input of ['\\\\.\\C:\\Windows', '\\\\?\\C:\\Windows', '中文文件.txt:stream']) {
    const { response, value } = await call('read_file', { path: input });
    assert.equal(response.isError, true);
    assert.equal(value.code, 'INVALID_PATH');
  }
});

test('missing files, binary-as-text, directories-as-files, and invalid inputs return tool errors', async () => {
  for (const args of [{ path: 'missing.txt' }, { path: 'binary.bin' }, { path: '.' }, { path: 'empty.txt', offset: 1 }, { path: 'empty.txt', length: -1 }, { path: 'utf16.txt', encoding: 'utf16le', offset: 1 }]) {
    assert.equal((await client.callTool({ name: 'read_file', arguments: args })).isError, true);
  }
  assert.equal((await call('list_directory', { path: '中文文件.txt' })).response.isError, true);
  assert.equal((await call('search_files', { path: '中文文件.txt', query: 'report' })).response.isError, true);
});

test('HTTP authentication, Host, Origin, protocol errors, and health endpoint behave correctly', async () => {
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${url}?token=${token}`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await rawRequest(url, { Authorization: `Bearer ${token}`, Host: 'evil.example' })).status, 403);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(new URL('/health', url))).status, 200);
  assert.equal((await fetch(new URL('/missing', url))).status, 404);
});

test('concurrent requests remain independent', async () => {
  const responses = await Promise.all(Array.from({ length: 12 }, () => call('read_file', { path: '中文文件.txt' })));
  assert.ok(responses.every(({ response, value }) => !response.isError && value.content === '你好，Notion！\n第二行 😀\n'));
});

test('public hostname proxying and multiple allowed roots work with authenticated MCP requests', async (t) => {
  const proxied = createHttpServer({ ...config, roots: [root, outside], publicUrl: 'https://files.example.com' });
  proxied.listen(0, '127.0.0.1');
  await once(proxied, 'listening');
  t.after(async () => {
    proxied.closeAllConnections();
    await new Promise((resolve) => proxied.close(resolve));
  });
  const endpoint = new URL(`http://127.0.0.1:${proxied.address().port}/mcp`);
  const headers = {
    Host: 'files.example.com',
    Origin: 'https://files.example.com',
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  const initialized = await rawRequest(endpoint, headers, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'proxy-test', version: '1' } },
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, 'notion-local-files');
  const read = await rawRequest(endpoint, headers, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'read_file', arguments: { path: path.join(outside, 'secret.txt') } },
  });
  assert.equal(read.status, 200);
  assert.equal(JSON.parse(read.body.result.content[0].text).content, 'outside secret');
});

test('setup CLI creates a usable config, protects existing configs, and supports relative roots', async () => {
  const generated = path.join(temp, 'setup.json');
  const env = { NOTION_MCP_CONFIG: generated };
  assert.equal((await runScript('setup.js', [root], env)).code, 0);
  const before = await readFile(generated, 'utf8');
  assert.equal((await runScript('setup.js', [outside], env)).code, 1);
  assert.equal(await readFile(generated, 'utf8'), before);
  const loaded = await loadConfig(env);
  assert.equal(loaded.token.length, 43);
  assert.equal(loaded.accessMode, 'restricted');
  assert.deepEqual(loaded.roots, [root]);
  await writeFile(generated, JSON.stringify({ roots: ['allowed'], token }));
  assert.deepEqual((await loadConfig(env)).roots, [root]);
  await writeFile(generated, JSON.stringify({ roots: [root], token: 'short' }));
  await assert.rejects(loadConfig(env), /token/);
  await writeFile(generated, JSON.stringify({ roots: [root], token, publicUrl: 'http://example.com' }));
  await assert.rejects(loadConfig(env), /HTTPS/);
});

test('setup without roots defaults to all access and retains a relative path base', async () => {
  const env = { NOTION_MCP_CONFIG: path.join(temp, 'setup-all.json') };
  assert.equal((await runScript('setup.js', [], env)).code, 0);
  const generated = await loadConfig(env);
  assert.equal(generated.accessMode, 'all');
  assert.deepEqual(generated.roots, [await realpath(project)]);
});

test('normal server CLI starts from config and accepts an actual MCP client', async (t) => {
  const childConfig = path.join(temp, 'child-config.json');
  const probe = createHttpServer(config);
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await writeFile(childConfig, JSON.stringify({ roots: [root], token, port }));
  const child = spawn(process.execPath, [path.join(project, 'src', 'server.js')], {
    cwd: temp,
    env: { ...process.env, NOTION_MCP_CONFIG: childConfig, NOTION_MCP_TOKEN: token, NOTION_MCP_PUBLIC_URL: '' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`Server exited with ${code}`); }),
  ]);
  const cliClient = new Client({ name: 'cli-test', version: '1.0.0' });
  t.after(() => cliClient.close());
  await cliClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const response = await cliClient.callTool({ name: 'read_file', arguments: { path: '中文文件.txt' } });
  assert.equal(JSON.parse(response.content[0].text).content, '你好，Notion！\n第二行 😀\n');
});
