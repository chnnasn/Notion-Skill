import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { FileAccessError } from './filesystem.js';
import { authorizeAction, confirmLocally, riskSchema } from './approval.js';
import { automaticCommand } from './command-policy.js';

const execFileAsync = promisify(execFile);

export const commandSchema = z.object({
  command: z.string().min(1).max(8000).refine((value) => value.trim().length > 0 && !value.includes('\0')),
  shell: z.enum(['powershell', 'cmd']).default('powershell'),
  cwd: z.string().min(1).max(4096).default('.'),
  timeout_ms: z.number().int().min(1000).max(600_000).default(60_000),
  max_output_bytes: z.number().int().min(256).max(8192).default(8192),
  risk: riskSchema,
}).strict();

export async function runCommand(args, files, signal, confirm = confirmLocally) {
  args = commandSchema.parse(args);
  if (process.platform !== 'win32') throw new FileAccessError('UNSUPPORTED_PLATFORM', '命令行工具当前支持 Windows。');
  const cwd = await files.resolve(args.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new FileAccessError('NOT_DIRECTORY', '命令工作目录必须是目录。');
  signal?.throwIfAborted();
  const automatic = await automaticCommand(args.command, cwd, signal);
  const safety = await authorizeAction({ tool: 'run_command', ...args, cwd }, Boolean(automatic), signal, confirm);
  if (await files.resolve(cwd) !== cwd) throw new FileAccessError('PATH_CHANGED', '确认期间工作目录已改变，请重新检查任务。');
  const systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  let executable;
  let commandArgs;
  let scriptFile;
  if (automatic) {
    executable = automatic.executable;
    commandArgs = automatic.args;
  } else if (args.shell === 'cmd') {
    executable = path.join(systemDirectory, 'cmd.exe');
    scriptFile = path.join(os.tmpdir(), `notion-command-${randomUUID()}.cmd`);
    // CMD must change code page on a preceding line before decoding the user's script.
    await writeFile(scriptFile, `@echo off\r\nchcp 65001 >nul\r\n${args.command.replace(/\r?\n/g, '\r\n')}\r\n`, { flag: 'wx', mode: 0o600 });
    commandArgs = ['/d', '/s', '/c', `""${scriptFile}""`];
  } else {
    executable = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `
      [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
      $OutputEncoding = [Console]::OutputEncoding
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      $global:LASTEXITCODE = 0
      try {
        & {
${args.command}
        }
        $commandSucceeded = $?
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        if (!$commandSucceeded) { exit 1 }
      } catch {
        [Console]::Error.WriteLine($_.ToString())
        exit 1
      }
    `;
    commandArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const env = automatic?.env || { ...process.env, [pathKey]: [path.dirname(process.execPath), process.env[pathKey]].filter(Boolean).join(path.delimiter) };
  const started = Date.now();
  try {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, commandArgs, {
        cwd, env, windowsHide: true, windowsVerbatimArguments: !automatic && args.shell === 'cmd',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = { stdout: [], stderr: [] };
      let remaining = args.max_output_bytes;
      let truncated = false;
      let stopReason = null;
      let terminationError;
      let settled = false;
      let drainTimer;
      const timeout = setTimeout(() => { void stop('timed_out'); }, args.timeout_ms);
      const onAbort = () => { void stop('cancelled'); };

      function collect(stream, chunk) {
        const length = Math.min(remaining, chunk.length);
        if (length) output[stream].push(Buffer.from(chunk.subarray(0, length)));
        remaining -= length;
        if (length < chunk.length) truncated = true;
      }

      function finish(code, exitSignal, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(drainTimer);
        signal?.removeEventListener('abort', onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) { reject(error); return; }
        const decode = (chunks) => new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated });
        resolve({
          status: stopReason || (code === 0 ? 'completed' : 'failed'),
          shell: args.shell, cwd, exit_code: code, signal: exitSignal,
          stdout: decode(output.stdout), stderr: decode(output.stderr),
          timed_out: stopReason === 'timed_out', truncated, duration_ms: Date.now() - started,
          safety,
          ...(terminationError ? { termination_error: terminationError } : {}),
        });
      }

      async function stop(reason) {
        if (settled || stopReason) return;
        stopReason = reason;
        // taskkill targets this shell and its child processes, including a running CLI.
        try {
          await execFileAsync(path.join(systemDirectory, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
          });
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) {
            terminationError = `进程树终止失败 (${error.code || 'IO_ERROR'})`;
            child.kill();
          }
        }
        if (settled) return;
        // Bound inherited pipe draining if a detached child kept a stream open.
        drainTimer = setTimeout(() => finish(child.exitCode, child.signalCode), 1000);
      }

      child.stdout.on('data', (chunk) => collect('stdout', chunk));
      child.stderr.on('data', (chunk) => collect('stderr', chunk));
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (code, exitSignal) => finish(code, exitSignal));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  } finally {
    if (scriptFile) await unlink(scriptFile).catch((error) => {
      if (error.code !== 'ENOENT') console.error(`命令临时脚本清理失败 (${error.code})`);
    });
  }
}
