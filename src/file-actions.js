import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { authorizeAction, confirmLocally, riskSchema } from './approval.js';
import { FileAccessError, isWithin, validatePath } from './filesystem.js';

const filename = z.string().min(1).max(4096);
export const writeSchema = z.object({
  path: filename, content: z.string().max(262144), encoding: z.enum(['utf8', 'utf16le', 'base64']).default('utf8'),
  overwrite: z.boolean().default(false), risk: riskSchema,
}).strict();
export const directorySchema = z.object({ path: filename, risk: riskSchema }).strict();
export const copySchema = z.object({ source: filename, destination: filename, risk: riskSchema }).strict();

export class FileActions {
  constructor(files, confirm = confirmLocally) { this.files = files; this.confirm = confirm; }

  async destination(input) {
    validatePath(input);
    const requested = path.resolve(this.files.roots[0], input);
    if (process.platform === 'win32' && requested.slice(path.parse(requested).root.length).split(/[\\/]/)
      .some((part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new FileAccessError('INVALID_PATH', '请使用普通文件名，避免 Windows 保留名称及末尾空格或句点。');
    }
    const parent = await this.files.resolve(path.dirname(requested));
    if (!(await stat(parent)).isDirectory()) throw new FileAccessError('NOT_DIRECTORY', '父路径必须是现有目录。');
    const target = path.join(parent, path.basename(requested));
    if (this.files.protectedFiles.some((item) => isWithin(item, target))) throw new FileAccessError('ACCESS_DENIED', '服务配置及运行目录受保护。');
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new FileAccessError('ACCESS_DENIED', '写入目标不能是符号链接。');
      await this.files.resolve(target);
      return { target, exists: true, info };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { target, exists: false };
    }
  }

  async write(args, signal) {
    args = writeSchema.parse(args);
    const before = await this.destination(args.path);
    if (before.exists && !args.overwrite) throw new FileAccessError('EEXIST', '文件已存在，需要明确设置 overwrite=true 才能替换。');
    if (before.exists && !before.info.isFile()) throw new FileAccessError('NOT_FILE', '只能替换普通文件。');
    const data = Buffer.from(args.content, args.encoding);
    const safety = await authorizeAction({ tool: 'write_file', ...args, path: before.target }, !before.exists, signal, this.confirm);
    const after = await this.destination(args.path);
    if (after.target !== before.target || after.exists !== before.exists || (before.exists &&
      (before.info.ino !== after.info.ino || before.info.mtimeMs !== after.info.mtimeMs || before.info.size !== after.info.size))) {
      throw new FileAccessError('FILE_CHANGED', '目标在确认期间已改变，请重新检查。');
    }
    signal?.throwIfAborted();
    const temporary = path.join(path.dirname(after.target), `.notion-write-${randomUUID()}.tmp`);
    let backup;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      signal?.throwIfAborted();
      if (after.exists) {
        backup = `${after.target}.notion-backup-${randomUUID()}`;
        await copyFile(after.target, backup, constants.COPYFILE_EXCL);
        await rename(temporary, after.target);
      } else {
        await link(temporary, after.target);
      }
      return { status: after.exists ? 'replaced' : 'created', path: after.target, bytes_written: data.length,
        sha256: createHash('sha256').update(data).digest('hex'), backup_path: backup, safety };
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async createDirectory(args, signal) {
    args = directorySchema.parse(args);
    const target = await this.destination(args.path);
    if (target.exists) {
      if (!target.info.isDirectory()) throw new FileAccessError('EEXIST', '已有同名文件。');
      return { status: 'already_exists', path: target.target };
    }
    const safety = await authorizeAction({ tool: 'create_directory', ...args, path: target.target }, true, signal, this.confirm);
    const checked = await this.destination(args.path);
    if (checked.target !== target.target) throw new FileAccessError('PATH_CHANGED', '父目录已改变。');
    signal?.throwIfAborted();
    await mkdir(target.target);
    return { status: 'created', path: target.target, safety };
  }

  async copy(args, signal) {
    args = copySchema.parse(args);
    const source = await this.files.resolve(args.source);
    if (!(await stat(source)).isFile()) throw new FileAccessError('NOT_FILE', 'copy_file 复制普通文件，目录请逐项列出后复制。');
    const target = await this.destination(args.destination);
    if (target.exists) throw new FileAccessError('EEXIST', '目标已存在，请使用新的文件名。');
    const safety = await authorizeAction({ tool: 'copy_file', ...args, source, destination: target.target }, true, signal, this.confirm);
    const checked = await this.destination(args.destination);
    if (checked.target !== target.target || checked.exists) throw new FileAccessError('FILE_CHANGED', '复制目标已改变。');
    await this.files.resolve(source);
    signal?.throwIfAborted();
    const temporary = path.join(path.dirname(target.target), `.notion-copy-${randomUUID()}.tmp`);
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      signal?.throwIfAborted();
      await link(temporary, target.target);
      return { status: 'copied', source, destination: target.target, size_bytes: (await stat(target.target)).size, safety };
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
