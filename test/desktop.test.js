import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DesktopControl, windowsDesktop } from '../src/desktop.js';
import { LocalFiles } from '../src/filesystem.js';
import { createHttpServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

test('desktop tools preserve path boundaries, expose actions, and coalesce concurrent app launches', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-desktop-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '中文 & dollar$ quote\' file.txt');
  const script = path.join(root, 'example.ps1');
  const configFile = path.join(root, 'config.json');
  await writeFile(file, 'hello');
  await writeFile(script, 'Write-Host hello');
  const config = {
    roots: [root], token: 'test-desktop-token-01234567890123456789', port: 3210,
    desktop: { enabled: true, apps: { editor: { executable: process.execPath } }, openExtensions: ['.txt'] },
  };
  await writeFile(configFile, JSON.stringify(config));
  const loaded = await loadConfig({ NOTION_MCP_CONFIG: configFile });
  const launches = [];
  const opened = [];
  let running = [];
  const driver = {
    async processes() { return running; },
    async launch(executable, args) {
      launches.push({ executable, args });
      running = [{ ProcessId: 12345, ExecutablePath: executable }];
      return 12345;
    },
    async open(target, reveal) { opened.push({ target, reveal }); },
  };
  const desktop = new DesktopControl(loaded, new LocalFiles(loaded.roots, [configFile]), driver);
  const http = createHttpServer(loaded, desktop);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const client = new Client({ name: 'desktop-test', version: '1' });
  t.after(async () => {
    await client.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  assert.equal(tools.find((tool) => tool.name === 'list_apps').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'open_path').annotations.readOnlyHint, false);
  const invoke = (name, args) => client.callTool({ name, arguments: args });
  const calls = await Promise.all(Array.from({ length: 6 }, () => invoke('ensure_app', { name: 'editor' })));
  assert.ok(calls.every((call) => !call.isError));
  assert.equal(launches.length, 1);
  const again = await invoke('ensure_app', { name: 'editor' });
  assert.equal(JSON.parse(again.content[0].text).status, 'already_running');
  assert.equal(launches.length, 1);
  assert.ok(!(await invoke('open_path', { path: file })).isError);
  assert.deepEqual(opened[0], { target: file, reveal: false });
  assert.ok(!(await invoke('open_path', { path: script, mode: 'reveal' })).isError);
  assert.deepEqual(opened[1], { target: script, reveal: true });
  assert.equal((await invoke('open_path', { path: script })).isError, true);
  assert.ok(!(await invoke('open_path', { path: script, app: 'editor' })).isError);
  assert.deepEqual(launches.at(-1).args, [script]);
  for (const args of [{ path: configFile }, { path: '../outside.txt' }, { path: file, app: '__proto__' }, { path: file, mode: 'reveal', app: 'editor' }]) {
    assert.equal((await invoke('open_path', args)).isError, true);
  }
  assert.equal((await invoke('ensure_app', { name: '__proto__' })).isError, true);
  assert.equal(launches.length, 2);
  loaded.desktop.apps.editor.packageName = 'Example.Editor';
  running = [{ ProcessId: 2468, ExecutablePath: path.join(root, 'WindowsApps', 'Example.Editor', path.basename(process.execPath)), PackageName: 'Example.Editor' }];
  const packaged = await invoke('ensure_app', { name: 'editor' });
  assert.equal(packaged.structuredContent.status, 'already_running');
  assert.equal(launches.length, 2);
});

test('Windows process inspection returns the current Node process in this session', { skip: process.platform !== 'win32' }, async () => {
  const processes = await windowsDesktop.processes();
  assert.ok(processes.some((item) => item.ProcessId === process.pid && path.relative(item.ExecutablePath, process.execPath) === ''));
});
