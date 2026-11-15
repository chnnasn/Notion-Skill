import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { authorizeAction, confirmLocally, riskSchema } from './approval.js';
import { FileAccessError, isWithin, validatePath } from './filesystem.js';

const activeEdits = new Set();

const filename = z.string().min(1).max(4096);
export const writeSchema = z.object({
  path: filename, content: z.string().max(262144), encoding: z.enum(['utf8', 'utf16le', 'base64']).default('utf8'),
  overwrite: z.boolean().default(false), risk: riskSchema,
}).strict();
export const directorySchema = z.object({ path: filename, risk: riskSchema }).strict();
export const copySchema = z.object({ source: filename, destination: filename, risk: riskSchema }).strict();
export const moveSchema = copySchema;
export const renameSchema = z.object({ path: filename, name: z.string().min(1).max(255).refine((value) => !/[\\/]/.test(value) && !['.', '..'].includes(value)), risk: riskSchema }).strict();
export const editSchema = z.object({
  path: filename, encoding: z.enum(['utf8', 'utf16le']).default('utf8'),
  edits: z.array(z.object({ old_text: z.string().min(1).max(262144), new_text: z.string().max(262144), replace_all: z.boolean().default(false) }).strict()).min(1).max(100),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), risk: riskSchema,
}).strict();

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

  assertMovable(source) {
    if (this.files.roots.some((root) => path.relative(root, source) === '') ||
      this.files.protectedFiles.some((item) => isWithin(source, item))) {
      throw new FileAccessError('ACCESS_DENIED', '不能移动访问根目录或包含服务配置的目录。');
    }
  }

  async move(args, signal) {
    args = moveSchema.parse(args);
    const requested = path.resolve(this.files.roots[0], args.source);
    if ((await lstat(requested)).isSymbolicLink()) throw new FileAccessError('ACCESS_DENIED', '移动源不能是符号链接。');
    const source = await this.files.resolve(args.source);
    this.assertMovable(source);
    const info = await stat(source);
    if (!info.isFile() && !info.isDirectory()) throw new FileAccessError('UNSUPPORTED_TYPE', '只能移动普通文件和目录。');
    const target = await this.destination(args.destination);
    if (target.exists) throw new FileAccessError('EEXIST', '移动目标已存在，请指定新的名称。');
    if (isWithin(source, target.target)) throw new FileAccessError('INVALID_DESTINATION', '不能移动到源目录内部。');
    const safety = await authorizeAction({ tool: 'move_path', ...args, source, destination: target.target }, false, signal, this.confirm);
    const checked = await this.destination(args.destination);
    const current = await stat(await this.files.resolve(source));
    if (checked.exists || checked.target !== target.target || current.ino !== info.ino || current.mtimeMs !== info.mtimeMs) {
      throw new FileAccessError('FILE_CHANGED', '移动前源或目标发生变化。');
    }
    signal?.throwIfAborted();
    if (info.isDirectory()) {
      if ((await stat(path.dirname(target.target))).dev !== info.dev) throw new FileAccessError('CROSS_DEVICE_DIRECTORY', '跨磁盘目录请先 copy_directory，核对结果后处理源目录。');
      await rename(source, target.target);
    } else {
      try { await link(source, target.target); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await this.copy({ source, destination: target.target }, signal);
      }
      const moved = await stat(await this.files.resolve(source));
      if (moved.ino !== info.ino || moved.size !== info.size || moved.mtimeMs !== info.mtimeMs) {
        throw new FileAccessError('FILE_CHANGED', `源文件已变化，保留两份文件，请检查 ${target.target}`);
      }
      try { await unlink(source); }
      catch (error) { throw new FileAccessError('MOVE_INCOMPLETE', `目标已创建但源文件未移除，请检查两处路径 (${error.code})。`); }
    }
    return { status: 'moved', source, destination: target.target, safety };
  }

  async rename(args, signal) {
    args = renameSchema.parse(args);
    return this.move({ source: args.path, destination: path.join(path.dirname(path.resolve(this.files.roots[0], args.path)), args.name), risk: args.risk }, signal);
  }

  async copyDirectory(args, signal) {
    args = copySchema.parse(args);
    const source = await this.files.resolve(args.source);
    if (!(await stat(source)).isDirectory()) throw new FileAccessError('NOT_DIRECTORY', '复制源必须是目录。');
    const target = await this.destination(args.destination);
    if (target.exists) throw new FileAccessError('EEXIST', '复制目标已存在。');
    if (isWithin(source, target.target)) throw new FileAccessError('INVALID_DESTINATION', '不能复制到源目录内部。');
    const safety = await authorizeAction({ tool: 'copy_directory', ...args, source, destination: target.target }, true, signal, this.confirm);
    const stage = path.join(path.dirname(target.target), `.notion-copy-dir-${randomUUID()}`);
    let count = 0;
    let bytes = 0;
    await mkdir(stage);
    try {
      const pending = [{ from: source, to: stage }];
      while (pending.length) {
        signal?.throwIfAborted();
        const entry = pending.pop();
        await this.files.resolve(entry.from);
        for (const item of await readdir(entry.from, { withFileTypes: true })) {
          signal?.throwIfAborted();
          if (++count > 10000) throw new FileAccessError('COPY_LIMIT', '单次目录复制最多 10000 项。');
          const from = path.join(entry.from, item.name);
          const to = path.join(entry.to, item.name);
          if (item.isSymbolicLink()) throw new FileAccessError('LINK_UNSUPPORTED', `目录包含链接，请单独处理 ${from}`);
          const canonical = await this.files.resolve(from);
          if (!isWithin(source, canonical)) throw new FileAccessError('ACCESS_DENIED', '复制源路径发生变化。');
          if (item.isDirectory()) { await mkdir(to); pending.push({ from, to }); }
          else if (item.isFile()) {
            const before = await stat(canonical);
            bytes += before.size;
            if (bytes > 2 * 1024 ** 3) throw new FileAccessError('COPY_LIMIT', '单次目录复制最多 2 GiB。');
            await copyFile(canonical, to, constants.COPYFILE_EXCL);
            const after = await stat(await this.files.resolve(from));
            if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new FileAccessError('FILE_CHANGED', '复制期间源文件已变化。');
          } else throw new FileAccessError('UNSUPPORTED_TYPE', '目录包含非常规文件。');
        }
      }
      const checked = await this.destination(args.destination);
      if (checked.exists || checked.target !== target.target) throw new FileAccessError('FILE_CHANGED', '复制期间目标已变化。');
      signal?.throwIfAborted();
      await rename(stage, target.target);
      return { status: 'copied', source, destination: target.target, entries: count, bytes_copied: bytes, safety };
    } finally {
      // Only this operation's generated staging directory is eligible for recursive cleanup.
      if (isWithin(path.dirname(target.target), stage) && path.basename(stage).startsWith('.notion-copy-dir-')) await rm(stage, { recursive: true, force: true });
    }
  }

  async edit(args, signal) {
    args = editSchema.parse(args);
    const source = await this.files.resolve(args.path);
    if (activeEdits.has(source)) throw new FileAccessError('FILE_BUSY', '此文件正在执行另一项局部编辑，请重新读取后再试。');
    activeEdits.add(source);
    try {
      if ((await stat(source)).size > 524288) throw new FileAccessError('EDIT_LIMIT', '局部编辑支持最多 512 KiB 文本。');
      const buffer = await readFile(source);
      const digest = createHash('sha256').update(buffer).digest('hex');
      if (args.expected_sha256 && args.expected_sha256.toLowerCase() !== digest) throw new FileAccessError('FILE_CHANGED', '文件摘要与预期不一致。');
      let content = new TextDecoder(args.encoding === 'utf8' ? 'utf-8' : 'utf-16le', { fatal: true, ignoreBOM: true }).decode(buffer);
      if (content.includes('\0')) throw new FileAccessError('BINARY_FILE', '局部编辑仅支持文本文件。');
      for (const edit of args.edits) {
        const count = content.split(edit.old_text).length - 1;
        if (!count || (count !== 1 && !edit.replace_all)) throw new FileAccessError('EDIT_MATCH', `替换文本匹配 ${count} 次，需要唯一匹配或 replace_all=true。`);
        content = edit.replace_all ? content.replaceAll(edit.old_text, () => edit.new_text) : content.replace(edit.old_text, () => edit.new_text);
      }
      const approved = await authorizeAction({ tool: 'edit_file', ...args, path: source }, false, signal, this.confirm);
      if (createHash('sha256').update(await readFile(source)).digest('hex') !== digest) throw new FileAccessError('FILE_CHANGED', '审批期间文件已变化。');
      const result = await new FileActions(this.files, async () => true).write({ path: source, content, encoding: args.encoding, overwrite: true }, signal);
      return { ...result, status: 'edited', safety: approved };
    } finally { activeEdits.delete(source); }
  }
}
