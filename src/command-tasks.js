import { randomUUID } from 'node:crypto';
import { FileAccessError } from './filesystem.js';

export class CommandTasks {
  constructor() { this.tasks = new Map(); }

  start(operation) {
    for (const [id, task] of this.tasks) {
      if (task.finished && Date.now() - task.finished > 3600_000) this.tasks.delete(id);
    }
    if (this.tasks.size >= 100) throw new FileAccessError('TASK_LIMIT', '任务记录已满，请稍后重试。');
    if ([...this.tasks.values()].filter((task) => task.status === 'running').length >= 4) {
      throw new FileAccessError('TASK_BUSY', '同时运行的命令已达到上限。');
    }
    const id = randomUUID();
    const controller = new AbortController();
    const task = { id, status: 'running', started_at: new Date().toISOString(), controller };
    this.tasks.set(id, task);
    task.pending = Promise.resolve().then(() => operation(controller.signal)).then((result) => {
      task.result = result;
      task.status = result.status;
    }, (error) => {
      task.status = 'failed';
      task.error = { code: error.code || 'COMMAND_ERROR', message: error.message };
    }).finally(() => { task.finished = Date.now(); });
    return this.get(id);
  }

  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw new FileAccessError('TASK_NOT_FOUND', '任务不存在或已过期，进程重启后任务记录会清空。请检查实际文件状态后决定下一步。');
    return { task_id: id, status: task.status, started_at: task.started_at, result: task.result, error: task.error };
  }

  cancel(id) {
    this.get(id);
    this.tasks.get(id).controller.abort();
    return this.get(id);
  }

  async close() {
    for (const task of this.tasks.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map((task) => task.pending));
  }
}
