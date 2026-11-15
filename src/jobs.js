import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { readJson, saveJson } from './storage.js';
import { commandSchema } from './commands.js';

const requestBase = z.object({
  version: z.literal(1),
  deviceId: z.string().uuid(),
});

export const requestSchema = z.discriminatedUnion('tool', [
  requestBase.extend({
    tool: z.enum(['list_roots', 'list_directory', 'get_path_info', 'read_file', 'search_files', 'list_apps', 'ensure_app', 'open_path', 'write_file', 'create_directory', 'copy_file']),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  requestBase.extend({
    tool: z.literal('mcp_control'),
    arguments: z.object({ action: z.enum(['start', 'stop', 'status', 'auto']) }).strict(),
  }).strict(),
  requestBase.extend({
    tool: z.literal('allow_path'),
    arguments: z.object({ path: z.string().min(1).max(4096) }).strict(),
  }).strict(),
  requestBase.extend({
    tool: z.literal('run_command'),
    arguments: commandSchema,
  }).strict(),
]);

const actionTools = new Set(['ensure_app', 'open_path', 'allow_path', 'run_command', 'write_file', 'create_directory', 'copy_file']);

export class JobRunner {
  constructor({ queue, client, deviceId, journalDirectory }) {
    this.queue = queue;
    this.client = client;
    this.deviceId = deviceId;
    this.journalDirectory = journalDirectory;
  }

  async run(jobId) {
    if (!/^[a-f0-9-]{32,36}$/i.test(jobId)) throw new Error('任务页面 ID 无效。');
    jobId = jobId.replaceAll('-', '').toLowerCase();
    const job = await this.queue.readJob(jobId);
    if (!['pending', 'running'].includes(job.status)) return;
    const parsed = requestSchema.safeParse(job.request);
    if (!parsed.success) {
      await this.queue.finish(jobId, 'failed', { code: 'INVALID_REQUEST', message: '任务请求格式无效，请按 Skill 格式新建任务。' });
      return;
    }
    const request = parsed.data;
    if (request.deviceId !== this.deviceId) return;
    const isAction = actionTools.has(request.tool)
      || (request.tool === 'mcp_control' && request.arguments.action !== 'status');
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const filename = path.join(this.journalDirectory, `${jobId}.json`);
    let record = await readJson(filename, null);
    if (record && record.hash !== hash) {
      await this.queue.finish(jobId, 'review', { code: 'REQUEST_CHANGED', message: '任务开始处理后请求已更改，请新建任务。' });
      return;
    }
    if (record?.phase === 'done') {
      await this.queue.finish(jobId, record.status, record.result);
      return;
    }
    if (isAction && (record?.phase === 'executing' || (!record && job.status === 'running'))) {
      record = { hash, phase: 'done', status: 'review', result: { code: 'EXECUTION_UNCERTAIN', message: '上次执行中断，操作可能已提交。请检查电脑或 MCP 状态，需要再次操作时新建任务。' } };
      await saveJson(filename, record);
      await this.queue.finish(jobId, record.status, record.result);
      return;
    }
    await saveJson(filename, { hash, phase: 'claimed' });
    await this.queue.markRunning(jobId);
    const claimed = await this.queue.readJob(jobId);
    if (claimed.status !== 'running') return;
    const current = requestSchema.safeParse(claimed.request);
    if (!current.success || createHash('sha256').update(JSON.stringify(current.data)).digest('hex') !== hash) {
      await this.queue.finish(jobId, 'review', { code: 'REQUEST_CHANGED', message: '领取过程中请求已更改，请新建任务。' });
      return;
    }
    await saveJson(filename, { hash, phase: 'executing' });
    let result;
    let status;
    try {
      const args = { ...request.arguments };
      if (request.tool === 'read_file' && args.length === undefined) args.length = 8192;
      const response = await this.client.callTool({ name: request.tool, arguments: args });
      status = response.isError ? 'failed' : 'succeeded';
      if (response.structuredContent) result = response.structuredContent;
      else {
        const text = response.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
        try { result = JSON.parse(text); }
        catch { result = { message: text }; }
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 80_000) {
        status = 'failed';
        result = { code: 'RESULT_TOO_LARGE', message: '结果超过单个任务的回传大小，请使用更小的 length、limit 或更精确的搜索范围新建任务。' };
      }
    } catch (error) {
      status = isAction ? 'review' : 'failed';
      result = { code: 'TOOL_ERROR', message: error.message };
    }
    await saveJson(filename, { hash, phase: 'done', status, result });
    await this.queue.finish(jobId, status, result);
  }
}
