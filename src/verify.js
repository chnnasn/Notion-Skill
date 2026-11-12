import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { connectNotion } from './notion-auth.js';
import { callNotion, NotionQueue, pageId, requestContent } from './notion-queue.js';
import { connectLocal } from './worker.js';
import { JobRunner } from './jobs.js';
import { acquireLock, readJson, saveJson } from './storage.js';

async function verify() {
  const config = await loadConfig();
  const runtime = path.join(path.dirname(config.configFile), '.runtime');
  const unlock = await acquireLock(path.join(runtime, 'client.lock'));
  let remote;
  let local;
  try {
    remote = await connectNotion(config);
    local = await connectLocal(config);
    const queue = new NotionQueue(remote, config.notion.deviceId);
    const filename = path.join(runtime, 'verification.json');
    const scope = JSON.stringify({ accessMode: config.accessMode, roots: config.roots });
    let state = await readJson(filename, {});
    if (state.verified || state.scope !== scope) state = {};
    if (!state.pageId) {
      await callNotion(remote, 'notion-fetch', { id: 'notion://docs/notion-flavored-markdown-spec' });
      const request = { version: 1, deviceId: config.notion.deviceId, tool: 'list_roots', arguments: {} };
      const created = await callNotion(remote, 'notion-create-pages', {
        creation_mode: 'draft', allow_async: false,
        pages: [{ properties: { title: `${queue.tag} pending 本机连接验证` }, content: requestContent(request) }],
      });
      await saveJson(path.join(runtime, 'create-response.json'), created);
      const page = created.pages?.[0];
      if (!page) throw new Error('创建结果缺少 pages。');
      state = { pageId: pageId(page.id || page.url), url: page.url, scope };
      await saveJson(filename, state);
    }
    console.log(`验证任务 ${state.url || state.pageId}`);
    if (!state.discovered) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const ids = await queue.discover();
        if (ids.some((id) => id.replaceAll('-', '') === state.pageId.replaceAll('-', ''))) { state.discovered = true; break; }
        await delay(5000);
      }
      if (!state.discovered) throw new Error('搜索索引尚未返回验证任务，请稍后重试 npm run verify。');
      await saveJson(filename, state);
    }
    const runner = new JobRunner({ queue, client: local.client, deviceId: config.notion.deviceId, journalDirectory: path.join(runtime, 'jobs') });
    await runner.run(state.pageId);
    const finished = await queue.readJob(state.pageId);
    assert.equal(finished.status, 'succeeded');
    const result = finished.text.match(/NLCRESULTBEGIN\s+```json\s*([\s\S]*?)```\s+NLCRESULTEND/);
    assert.ok(result, '结果块未保存到 Notion');
    const expected = await local.client.callTool({ name: 'list_roots', arguments: {} });
    assert.ok(!expected.isError);
    const received = JSON.parse(result[1]).result;
    assert.equal(received.access_mode, config.accessMode);
    assert.deepEqual(received.roots, expected.structuredContent.roots);
    state.verified = new Date().toISOString();
    await saveJson(filename, state);
    console.log('验证成功，Notion 任务发现、本机 MCP 执行和结果回传均通过。');
  } finally {
    await remote?.close();
    await local?.close();
    await unlock();
  }
}

verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
