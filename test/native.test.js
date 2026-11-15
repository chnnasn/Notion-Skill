import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/server.js';
import { LocalFiles } from '../src/filesystem.js';
import { FileActions } from '../src/file-actions.js';
import { hostApproval } from '../src/approval.js';

test('file creation, backup replacement and copy protect existing data and service files', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-write-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json');
  await writeFile(config, 'secret');
  const actions = new FileActions(new LocalFiles([root], [config, path.join(root, '.runtime')]), hostApproval);
  await actions.createDirectory({ path: '中文目录' });
  const created = await actions.write({ path: '中文目录/a.txt', content: '你好' });
  assert.equal(created.status, 'created');
  assert.equal(created.safety.decision, 'host_managed');
  await assert.rejects(actions.write({ path: '中文目录/a.txt', content: 'bad' }), { code: 'EEXIST' });
  const replaced = await actions.write({ path: '中文目录/a.txt', content: '新内容', overwrite: true });
  assert.equal(await readFile(replaced.backup_path, 'utf8'), '你好');
  await actions.copy({ source: '中文目录/a.txt', destination: 'b.txt' });
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), '新内容');
  await assert.rejects(actions.copy({ source: 'b.txt', destination: 'b.txt' }), { code: 'EEXIST' });
  for (const target of ['config.json', '.runtime', '../outside.txt']) {
    await assert.rejects(actions.write({ path: target, content: 'bad', overwrite: true }), { code: 'ACCESS_DENIED' });
  }
  const results = await Promise.allSettled([actions.write({ path: 'race.txt', content: 'one' }), actions.write({ path: 'race.txt', content: 'two' })]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  await symlink(path.join(root, '中文目录'), path.join(root, 'alias.txt'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(actions.write({ path: 'alias.txt', content: 'bad', overwrite: true }), { code: 'ACCESS_DENIED' });
});

test('native HTTP commands return task IDs and survive request disconnects without local dialogs', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-native-')));
  const http = createHttpServer({ roots: [root], configFile: path.join(root, 'config.json'), token: 'native-test-token-01234567890123456789', port: 3210, approvalMode: 'host' });
  t.after(async () => { await http.closeTasks(); http.closeAllConnections(); await new Promise((r) => http.close(r)); await rm(root, { recursive: true, force: true }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  async function connect() {
    const client = new Client({ name: 'native-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer native-test-token-01234567890123456789' } },
    }));
    return client;
  }
  const first = await connect();
  const response = await first.callTool({ name: 'start_command', arguments: { command: 'Start-Sleep -Seconds 2; Write-Output done', cwd: root, risk: { level: 'high', reason: 'test native host approval' } } });
  const id = response.structuredContent.task_id;
  assert.ok(id);
  await first.close();
  const second = await connect();
  t.after(() => second.close());
  let task;
  for (let attempt = 0; attempt < 30; attempt++) {
    task = (await second.callTool({ name: 'get_command_task', arguments: { task_id: id } })).structuredContent;
    if (task.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(task.status, 'completed');
  assert.equal(task.result.stdout.trim(), 'done');
  assert.equal(task.result.safety.decision, 'host_managed');
  const created = await second.callTool({ name: 'write_file', arguments: { path: 'native.txt', content: 'hello' } });
  assert.equal(created.structuredContent.status, 'created');
  const invoke = async (name, args) => {
    const result = await second.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  await invoke('edit_file', { path: 'native.txt', edits: [{ old_text: 'hello', new_text: 'edited' }] });
  await invoke('rename_path', { path: 'native.txt', name: 'renamed.txt' });
  await invoke('create_directory', { path: 'folder' });
  await invoke('move_path', { source: 'renamed.txt', destination: 'folder/moved.txt' });
  await invoke('copy_directory', { source: 'folder', destination: 'copied-folder' });
  assert.equal((await invoke('read_document', { path: 'copied-folder/moved.txt' })).content, 'edited');
  assert.ok((await invoke('list_command_tasks', {})).tasks.some((task) => task.task_id === id));
  assert.match((await invoke('read_command_log', { task_id: id })).content, /done/);
});
