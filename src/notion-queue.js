import { setTimeout as delay } from 'node:timers/promises';

export function unpack(response) {
  const text = (response.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  if (response.isError) throw new Error(`Notion 操作失败 ${text.slice(0, 500)}`);
  if (response.structuredContent) return response.structuredContent;
  try { return JSON.parse(text); }
  catch { throw new Error('Notion 返回了无法解析的响应。'); }
}

export async function callNotion(client, name, args) {
  let value = unpack(await client.callTool({ name, arguments: args }));
  if (value.type !== 'async_task' && !value.async_task) return value;
  const taskId = value.task_id || value.async_task.task_id;
  if (!taskId) throw new Error('Notion 异步操作缺少任务标识。');
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(2000);
    value = unpack(await client.callTool({ name: 'notion-get-async-task', arguments: { task_id: taskId } }));
    if (value.status === 'succeeded') return value.result;
    if (value.status === 'failed') throw new Error('Notion 异步操作失败，请查看任务页面。');
  }
  throw new Error('Notion 异步操作仍在处理，稍后将重新检查页面。');
}

export function deviceTag(deviceId) {
  return `NLC${deviceId.replaceAll('-', '')}`;
}

export function requestContent(request) {
  return `NLCREQUESTBEGIN\n\n\`\`\`json\n${JSON.stringify(request, null, 2)}\n\`\`\`\n\nNLCREQUESTEND`;
}

export function pageId(value) {
  const match = String(value).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?:[?#/]|$)/i);
  if (!match) throw new Error('Notion 返回了无法识别的页面 ID。');
  return match[1];
}

export class NotionQueue {
  constructor(client, deviceId) {
    this.client = client;
    this.deviceId = deviceId;
    this.tag = deviceTag(deviceId);
  }

  async discover() {
    const ids = new Set();
    for (const status of ['pending', 'running']) {
      const result = await callNotion(this.client, 'notion-search', {
        query: `"${this.tag} ${status}"`, query_type: 'internal', filters: { title_only: true }, page_size: 50, max_highlight_length: 0,
      });
      if (!Array.isArray(result.results)) throw new Error('Notion 搜索响应缺少 results。');
      for (const page of result.results) {
        if (page.title?.startsWith(`${this.tag} ${status} `)) ids.add(pageId(page.id || page.url));
      }
    }
    return [...ids];
  }

  async readJob(id) {
    const page = await callNotion(this.client, 'notion-fetch', { id });
    const title = page.title;
    const match = title?.match(new RegExp(`^${this.tag} (pending|running|succeeded|failed|review) (.+)$`));
    if (!match) throw new Error('任务页面标题与当前设备不匹配。');
    if (page.truncated || page.metadata?.truncated) throw new Error('任务页面返回内容不完整。');
    const text = page.text || '';
    const blocks = [...text.matchAll(/NLC(?:\\?_)?REQUEST(?:\\?_)?BEGIN\s+```json\s*([\s\S]*?)```\s+NLC(?:\\?_)?REQUEST(?:\\?_)?END/g)];
    let request = null;
    if (blocks.length === 1) {
      try { request = JSON.parse(blocks[0][1]); }
      catch { /* JobRunner publishes INVALID_REQUEST for malformed JSON. */ }
    }
    if (request?.deviceId && request.deviceId !== this.deviceId) throw new Error('请求设备与任务标题不匹配。');
    return { status: match[1], label: match[2], request, text };
  }

  async markRunning(id) {
    const job = await this.readJob(id);
    if (!['pending', 'running'].includes(job.status)) return;
    await this.setStatus(id, 'running', job.label);
  }

  async setStatus(id, status, label) {
    await callNotion(this.client, 'notion-update-page', {
      page_id: id, command: 'update_properties', properties: { title: `${this.tag} ${status} ${label}` }, allow_async: false,
    });
  }

  async finish(id, status, result) {
    const job = await this.readJob(id);
    // JSON fences also escape hostile Markdown supplied by local file contents.
    const serialized = JSON.stringify({ status, result }, null, 2).replaceAll('`', '\\u0060').replaceAll('<', '\\u003c');
    const block = `NLCRESULTBEGIN\n\n\`\`\`json\n${serialized}\n\`\`\`\n\nNLCRESULTEND`;
    const existing = job.text.match(/NLCRESULTBEGIN\s+```json\s*[\s\S]*?```\s+NLCRESULTEND/);
    if (existing && existing[0] !== block) {
      await callNotion(this.client, 'notion-update-page', {
        page_id: id, command: 'update_content', content_updates: [{ old_str: existing[0], new_str: block }], allow_async: false,
      });
    } else if (!existing) {
      await callNotion(this.client, 'notion-update-page', {
        page_id: id, command: 'insert_content', content: `\n${block}`, position: { type: 'end' }, allow_async: false,
      });
    }
    await this.setStatus(id, status, job.label);
  }
}
