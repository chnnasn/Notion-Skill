import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class FileAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validatePath(input) {
  if (input.includes('\0')) {
    throw new FileAccessError('INVALID_PATH', '路径包含无效字符。');
  }
  // Reject Win32 device namespaces and alternate data streams before filesystem access.
  if (process.platform === 'win32' && (/^[\\/]{2}[?.][\\/]/.test(input) || input.replace(/^[a-z]:/i, '').includes(':'))) {
    throw new FileAccessError('INVALID_PATH', '请使用普通文件路径。');
  }
}

function fileType(info) {
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  if (info.isSymbolicLink()) return 'symlink';
  return 'other';
}

export class LocalFiles {
  constructor(roots, protectedFiles = [], accessMode = 'restricted') {
    this.roots = roots;
    this.protectedFiles = protectedFiles;
    this.accessMode = accessMode;
  }

  async resolve(input = '.') {
    validatePath(input);
    const requested = path.resolve(this.roots[0], input);
    if (this.accessMode !== 'all' && !this.roots.some((root) => isWithin(root, requested))) {
      throw new FileAccessError('ACCESS_DENIED', '路径超出配置的 roots。请先调用 list_roots。');
    }
    const resolved = await realpath(requested);
    if (this.accessMode !== 'all' && !this.roots.some((root) => isWithin(root, resolved))) {
      throw new FileAccessError('ACCESS_DENIED', '链接目标超出配置的 roots。');
    }
    if (this.protectedFiles.some((filename) => isWithin(filename, resolved))) {
      throw new FileAccessError('ACCESS_DENIED', '服务配置文件受保护。');
    }
    // Also protect hard links to the configuration containing the access token.
    if (this.protectedFiles.length) {
      const target = await stat(resolved);
      for (const filename of this.protectedFiles) {
        const protectedInfo = await stat(filename).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!protectedInfo) continue;
        if (target.ino === protectedInfo.ino && target.dev === protectedInfo.dev) {
          throw new FileAccessError('ACCESS_DENIED', '服务配置文件受保护。');
        }
      }
    }
    return resolved;
  }

  async pathInfo(input) {
    const resolved = await this.resolve(input);
    const info = await stat(resolved);
    return {
      path: resolved,
      name: path.basename(resolved),
      type: fileType(info),
      size_bytes: info.size,
      modified_at: info.mtime.toISOString(),
      created_at: info.birthtime.toISOString(),
    };
  }

  async listDirectory(input, offset, limit) {
    const directory = await this.resolve(input);
    if (!(await stat(directory)).isDirectory()) {
      throw new FileAccessError('NOT_DIRECTORY', '此路径是文件，请使用 read_file 或 get_path_info。');
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const visible = [];
    let index = offset;
    for (; index < entries.length && visible.length < limit; index++) {
      const entry = entries[index];
      const entryPath = path.join(directory, entry.name);
      try {
        await this.resolve(entryPath);
        visible.push({ name: entry.name, path: entryPath, type: fileType(entry) });
      } catch (error) {
        if (!['ACCESS_DENIED', 'ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
      }
    }
    return { path: directory, entries: visible, next_offset: index < entries.length ? index : null };
  }

  async readFile(input, offset, length, encoding) {
    if (encoding === 'utf16le' && offset % 2 !== 0) {
      throw new FileAccessError('INVALID_OFFSET', 'UTF-16 LE 的 offset 必须位于偶数字节边界。');
    }
    const resolved = await this.resolve(input);
    if (!(await stat(resolved)).isFile()) {
      throw new FileAccessError('NOT_FILE', '此路径不是普通文件，请使用 list_directory。');
    }
    const handle = await open(resolved, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new FileAccessError('NOT_FILE', '只能读取普通文件。');
      // Revalidate after opening, and reject paths replaced during the open operation.
      const checked = await this.resolve(resolved);
      const current = await stat(checked);
      if (info.dev !== current.dev || info.ino !== current.ino) {
        throw new FileAccessError('FILE_CHANGED', '文件已被替换，请重新读取。');
      }
      if (offset > info.size) {
        throw new FileAccessError('INVALID_OFFSET', 'offset 超过文件大小。');
      }
      const buffer = Buffer.alloc(length + 4);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
        if (part.bytesRead === 0) break;
        bytesRead += part.bytesRead;
      }
      const chunk = buffer.subarray(0, Math.min(bytesRead, length));
      const hasMore = bytesRead > length;
      let content;
      let consumed = chunk.length;
      if (encoding === 'base64') {
        content = chunk.toString('base64');
      } else {
        try {
          const decoder = new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'utf-16le', { fatal: true, ignoreBOM: true });
          content = decoder.decode(chunk, { stream: hasMore });
          consumed = Buffer.byteLength(content, encoding);
        } catch {
          throw new FileAccessError('INVALID_ENCODING', '内容与编码不匹配。请尝试 utf16le 或 base64，并使用上次返回的 next_offset 分页。');
        }
        if (content.includes('\0')) {
          throw new FileAccessError('BINARY_FILE', '检测到二进制内容。请使用 encoding="base64"，UTF-16 LE 文本请使用 utf16le。');
        }
      }
      const next = offset + consumed;
      return {
        path: resolved,
        encoding,
        size_bytes: info.size,
        modified_at: info.mtime.toISOString(),
        offset,
        bytes_read: consumed,
        next_offset: hasMore ? next : null,
        content,
      };
    } finally {
      await handle.close();
    }
  }

  async searchFiles(input, query, maxDepth, limit, exclude, signal) {
    const directory = await this.resolve(input);
    if (!(await stat(directory)).isDirectory()) {
      throw new FileAccessError('NOT_DIRECTORY', '搜索路径必须是目录。');
    }
    const stack = [{ directory, depth: 0 }];
    const results = [];
    const ignored = new Set(exclude.map((name) => name.toLowerCase()));
    const needle = query.toLowerCase();
    const deadline = Date.now() + 10_000;
    let visited = 0;
    let skipped = 0;
    let depthLimited = false;
    let stopReason = null;
    search: while (stack.length) {
      signal?.throwIfAborted();
      const current = stack.pop();
      let entries;
      try {
        await this.resolve(current.directory);
        entries = (await readdir(current.directory, { withFileTypes: true }))
          .sort((left, right) => left.name.localeCompare(right.name, 'en'));
      } catch (error) {
        if (!['ACCESS_DENIED', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
        skipped++;
        continue;
      }
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (visited >= 10_000 || Date.now() >= deadline) {
          stopReason = visited >= 10_000 ? 'entry_limit' : 'time_limit';
          break search;
        }
        visited++;
        if (ignored.has(entry.name.toLowerCase())) continue;
        const entryPath = path.join(current.directory, entry.name);
        try {
          await this.resolve(entryPath);
        } catch (error) {
          if (!['ACCESS_DENIED', 'ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
          skipped++;
          continue;
        }
        if (entry.name.toLowerCase().includes(needle)) {
          results.push({ path: entryPath, name: entry.name, type: fileType(entry) });
          if (results.length >= limit) {
            stopReason = 'result_limit';
            break search;
          }
        }
        // Directory links are listed but not traversed, avoiding cycles and duplicate trees.
        if (entry.isDirectory()) {
          if (current.depth < maxDepth) stack.push({ directory: entryPath, depth: current.depth + 1 });
          else depthLimited = true;
        }
      }
    }
    return {
      path: directory,
      query,
      results,
      visited_entries: visited,
      skipped_entries: skipped,
      depth_limited: depthLimited,
      truncated: stopReason !== null,
      stop_reason: stopReason,
    };
  }
}
