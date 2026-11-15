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

export function pageId(value) {
  const match = String(value).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?:[?#/]|$)/i);
  if (!match) throw new Error('Notion 返回了无法识别的页面 ID。');
  return match[1];
}
