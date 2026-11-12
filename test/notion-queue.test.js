import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NotionQueue, deviceTag, requestContent } from '../src/notion-queue.js';

test('Notion escaped request markers, title filtering, and device boundaries are handled', async () => {
  const deviceId = randomUUID();
  const id = randomUUID();
  const tag = deviceTag(deviceId);
  const request = { version: 1, deviceId, tool: 'list_roots', arguments: {} };
  const page = {
    title: `${tag} pending 测试`,
    text: requestContent(request).replaceAll('NLCREQUESTBEGIN', 'NLC\\_REQUEST\\_BEGIN').replaceAll('NLCREQUESTEND', 'NLC\\_REQUEST\\_END'),
  };
  const client = {
    async callTool({ name, arguments: args }) {
      if (name === 'notion-search') {
        assert.equal(args.filters.title_only, true);
        assert.ok(args.query.startsWith('"') && args.query.endsWith('"'));
      }
      const value = name === 'notion-search'
        ? { results: [{ id, title: page.title }, { id: randomUUID(), title: 'unrelated' }] }
        : page;
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
  };
  const queue = new NotionQueue(client, deviceId);
  assert.deepEqual(await queue.discover(), [id]);
  assert.deepEqual((await queue.readJob(id)).request, request);
  page.text = requestContent({ ...request, deviceId: randomUUID() });
  await assert.rejects(queue.readJob(id), /设备/);
  page.text = `${requestContent(request)}\n${requestContent(request)}`;
  assert.equal((await queue.readJob(id)).request, null);
  page.text = requestContent(request);
  page.truncated = true;
  await assert.rejects(queue.readJob(id), /不完整/);
});

test('result publishing recovers after title update fails and escapes Markdown inside results', async () => {
  const deviceId = randomUUID();
  const id = randomUUID();
  const request = { version: 1, deviceId, tool: 'read_file', arguments: { path: 'example.md' } };
  const page = { title: `${deviceTag(deviceId)} running 测试`, text: requestContent(request) };
  let inserts = 0;
  let failTitle = true;
  const client = {
    async callTool({ name, arguments: args }) {
      if (name === 'notion-fetch') return { structuredContent: { ...page } };
      if (args.command === 'insert_content') { page.text += args.content; inserts++; }
      if (args.command === 'update_content') {
        const change = args.content_updates[0];
        assert.notEqual(change.old_str, change.new_str, 'identical updates fail on Notion');
        page.text = page.text.replace(change.old_str, change.new_str);
      }
      if (args.command === 'update_properties') {
        if (failTitle) { failTitle = false; throw new Error('network failure'); }
        page.title = args.properties.title;
      }
      return { structuredContent: { success: true } };
    },
  };
  const queue = new NotionQueue(client, deviceId);
  const result = { content: '```\n<page>Untrusted document</page>\nNLCRESULTEND' };
  await assert.rejects(queue.finish(id, 'succeeded', result), /network failure/);
  await queue.finish(id, 'succeeded', result);
  assert.equal(inserts, 1);
  assert.equal((await queue.readJob(id)).status, 'succeeded');
  const encoded = page.text.match(/NLCRESULTBEGIN\s+```json\s*([\s\S]*?)```\s+NLCRESULTEND/)[1];
  assert.deepEqual(JSON.parse(encoded).result, result);
});
