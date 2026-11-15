import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { FileAccessError } from './filesystem.js';
import { readJson, saveJson } from './storage.js';

export class CommandTasks {
  constructor(directory) {
    this.directory = directory;
    this.tasks = new Map();
    this.ready = this.restore();
    void this.ready.catch(() => {});
  }

  async restore() {
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const task = await readJson(path.join(this.directory, name));
      if (task.task_id !== name.slice(0, -5) || !['running', 'completed', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(task.status)) {
        throw new Error('任务记录格式无效，请检查本机任务目录。');
      }
      if (task.status === 'running') {
        task.status = 'interrupted';
        task.error = { code: 'EXECUTION_UNCERTAIN', message: '服务在执行期间中断，请检查进程及实际文件状态后决定下一步。' };
        await saveJson(path.join(this.directory, name), task);
      }
      this.tasks.set(task.task_id, task);
    }
  }

  snapshot(task) {
    const { controller, pending, writes, ...record } = task;
    return structuredClone(record);
  }

  async save(task) { await saveJson(path.join(this.directory, `${task.task_id}.json`), this.snapshot(task)); }

  async start(operation, request = {}) {
    await this.ready;
    if (this.closing) throw new FileAccessError('SERVICE_STOPPING', '服务正在停止，不能启动新任务。');
    if (this.tasks.size >= 1000) throw new FileAccessError('TASK_LIMIT', '任务记录已达 1000 条，请归档本机任务目录后重启服务。');
    if ([...this.tasks.values()].filter((task) => task.status === 'running').length >= 4) throw new FileAccessError('TASK_BUSY', '同时运行的命令已达到上限。');
    const id = randomUUID();
    const task = { task_id: id, status: 'running', started_at: new Date().toISOString(), request, log_bytes: 0, log_truncated: false,
      controller: new AbortController(), writes: Promise.resolve() };
    this.tasks.set(id, task);
    try { await this.save(task); }
    catch (error) { this.tasks.delete(id); throw error; }
    const onOutput = (stream, text) => {
      if (task.log_truncated) return;
      const data = Buffer.from(`[${stream}] ${text}`);
      if (task.log_bytes + data.length > 8 * 1024 ** 2) { task.log_truncated = true; return; }
      task.log_bytes += data.length;
      task.writes = task.writes.then(() => appendFile(path.join(this.directory, `${id}.log`), data, { mode: 0o600 }));
      void task.writes.catch(() => {});
    };
    task.pending = Promise.resolve().then(() => operation(task.controller.signal, onOutput)).then((result) => {
      task.result = result;
      task.status = result.status;
    }, (error) => {
      task.status = 'failed';
      task.error = { code: error.code || 'COMMAND_ERROR', message: error.message };
    }).then(async () => {
      try { await task.writes; }
      catch (error) { task.log_error = error.message; }
      task.finished_at = new Date().toISOString();
      await this.save(task);
    });
    void task.pending.catch((error) => { task.persistence_error = error.message; });
    return this.snapshot(task);
  }

  async get(id) {
    await this.ready;
    const task = this.tasks.get(id);
    if (!task) throw new FileAccessError('TASK_NOT_FOUND', '任务记录不存在，请检查编号及实际文件状态。');
    return this.snapshot(task);
  }

  async list(offset = 0, limit = 50) {
    await this.ready;
    const tasks = [...this.tasks.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
    return { tasks: tasks.slice(offset, offset + limit).map((task) => ({ task_id: task.task_id, status: task.status, started_at: task.started_at, request: task.request })),
      next_offset: offset + limit < tasks.length ? offset + limit : null };
  }

  async logs(id, offset = 0, length = 16384) {
    const task = await this.get(id);
    await this.tasks.get(id).writes;
    let handle;
    try { handle = await open(path.join(this.directory, `${id}.log`), 'r'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (offset) throw new FileAccessError('INVALID_OFFSET', '日志 offset 超出范围。');
      return { task_id: id, status: task.status, content: '', offset: 0, next_offset: 0, has_more: false, log_truncated: task.log_truncated };
    }
    try {
      const size = (await handle.stat()).size;
      if (offset > size) throw new FileAccessError('INVALID_OFFSET', '日志 offset 超出范围。');
      const buffer = Buffer.alloc(Math.min(length, size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const content = new TextDecoder().decode(buffer.subarray(0, bytesRead), { stream: offset + bytesRead < size });
      const next = offset + Buffer.byteLength(content);
      return { task_id: id, status: task.status, content, offset, next_offset: next, has_more: next < size, log_truncated: task.log_truncated };
    } finally { await handle.close(); }
  }

  async cancel(id) {
    await this.get(id);
    this.tasks.get(id).controller?.abort();
    return this.get(id);
  }

  async close() {
    this.closing = true;
    await this.ready;
    for (const task of this.tasks.values()) task.controller?.abort();
    await Promise.allSettled([...this.tasks.values()].map((task) => task.pending));
  }
}
