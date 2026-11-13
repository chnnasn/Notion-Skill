import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWithin } from './filesystem.js';

const execFileAsync = promisify(execFile);

// Only these complete, single-command forms can run without confirmation.
// Shell syntax, file arguments, arbitrary options and executable paths fall back to confirmation.
export function readOnlyCommand(command) {
  if (!/^[a-zA-Z0-9= \t-]+$/.test(command)) return null;
  const words = command.trim().split(/[ \t]+/);
  if (words[0] === 'node' && words.length === 2 && ['--version', '-v'].includes(words[1])) return { kind: 'node', args: words.slice(1) };
  if (words[0] !== 'git') return null;
  const [, verb, ...args] = words;
  const options = {
    status: ['--short', '-s', '--branch', '-b', '-sb', '--porcelain', '--porcelain=v1', '--porcelain=v2'],
    diff: ['--stat', '--numstat', '--name-only', '--name-status', '--cached', '--staged'],
    log: ['--oneline', '--decorate', '--no-decorate'],
  };
  if (verb === '--version' && args.length === 0) return { kind: 'git', args: [verb] };
  if (verb === 'rev-parse' && args.length === 1 && ['--show-toplevel', '--is-inside-work-tree'].includes(args[0])) return { kind: 'git', args: [verb, ...args] };
  if (!Object.hasOwn(options, verb)) return null;
  const normalized = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (options[verb].includes(argument)) { normalized.push(argument); continue; }
    if (verb !== 'log') return null;
    if (argument === '-n' && /^[1-9][0-9]{0,2}$/.test(args[index + 1] || '')) {
      normalized.push('-n', args[++index]);
    } else if (/^(?:-n|--max-count=)[1-9][0-9]{0,2}$/.test(argument)) {
      normalized.push(argument);
    } else return null;
  }
  if (verb === 'status') normalized.push('--ignore-submodules=all');
  if (verb === 'diff') normalized.push('--no-ext-diff', '--no-textconv', '--ignore-submodules=all');
  if (verb === 'log') {
    if (!args.some((argument) => /^-n|^--max-count=/.test(argument))) normalized.push('--max-count=50');
    normalized.push('--no-patch', '--no-show-signature', '--no-ext-diff', '--no-textconv');
  }
  return { kind: 'git', args: [verb, ...normalized] };
}

async function findGit(cwd) {
  // Search absolute PATH entries only. A git.cmd/git.exe planted in the task directory is never selected.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  for (const entry of (process.env[pathKey] || '').split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(directory) || isWithin(cwd, directory)) continue;
    try {
      const executable = await realpath(path.join(directory, 'git.exe'));
      if (!isWithin(cwd, executable) && (await stat(executable)).isFile()) return executable;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return null;
}

export async function automaticCommand(command, cwd, signal) {
  const plan = readOnlyCommand(command);
  if (!plan) return null;
  if (plan.kind === 'node') return { executable: process.execPath, args: plan.args, env: { ...process.env, NODE_OPTIONS: '' } };
  const executable = await findGit(cwd);
  if (!executable) return null;
  // Clear inherited Git overrides, redirections and tracing. Block lazy network fetches and optional writes.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' });
  const options = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'gc.auto=0'];
  if (['status', 'diff'].includes(plan.args[0])) {
    // Clean/process filters can execute programs even during status/diff. Unknown configuration fails closed.
    try {
      const version = await execFileAsync(executable, ['--version'], {
        cwd, env, signal, windowsHide: true, timeout: 5000, maxBuffer: 1024,
      });
      const match = version.stdout.match(/^git version (\d+)\.(\d+)\./);
      // Older Git treats core.fsmonitor=false as the name of a hook to execute.
      if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 36)) return null;
      const { stdout } = await execFileAsync(executable, [...options, 'config', '--null', '--list'], {
        cwd, env, signal, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
      });
      if (stdout.split('\0').some((entry) => /^filter\..+\.(clean|process)\n[^\0]+$/i.test(entry))) return null;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }
  return { executable, args: [...options, ...plan.args], env };
}
