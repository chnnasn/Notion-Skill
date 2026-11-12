import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { commandSchema, runCommand } from '../src/commands.js';
import { LocalFiles } from '../src/filesystem.js';

let directory, cwd, files;

before(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-command-')));
  cwd = path.join(directory, '中文 working folder');
  await mkdir(cwd);
  files = new LocalFiles([directory]);
});

after(() => rm(directory, { recursive: true, force: true }));

const run = (args, signal) => runCommand(commandSchema.parse({ cwd, ...args }), files, signal);
const windowsOnly = { skip: process.platform !== 'win32' };

test('PowerShell captures Unicode output, stderr and the requested working directory', windowsOnly, async () => {
  const result = await run({ command: '[Console]::Out.WriteLine((Get-Location).Path)\n[Console]::Out.WriteLine("你好 😀")\n[Console]::Error.WriteLine("错误输出")' });
  assert.equal(result.status, 'completed');
  assert.equal(result.exit_code, 0);
  assert.ok(result.stdout.includes(cwd));
  assert.ok(result.stdout.includes('你好 😀'));
  assert.equal(result.stderr.trim(), '错误输出');
  assert.equal(result.truncated, false);
  assert.equal(result.cwd, cwd);
  assert.equal(result.timed_out, false);
});

test('CMD executes a quoted native command with UTF-8 output and preserves its exit code', windowsOnly, async () => {
  const result = await run({ shell: 'cmd', command: 'node -e "process.stdout.write(\'中文 & quoted\'); process.stderr.write(\'native error\'); process.exit(7)"' });
  assert.equal(result.status, 'failed');
  assert.equal(result.exit_code, 7);
  assert.equal(result.stdout, '中文 & quoted');
  assert.equal(result.stderr, 'native error');
  const script = path.join(cwd, '中文 & echo.cmd');
  await writeFile(script, '@echo off\r\necho %~1\r\nexit /b 0\r\n');
  const quoted = await run({ shell: 'cmd', command: `"${script}" "argument with spaces"` });
  assert.equal(quoted.exit_code, 0);
  assert.equal(quoted.stdout.trim(), 'argument with spaces');
  const mixed = await run({ shell: 'cmd', command: 'node -e "console.log(\'native中文\')" & echo CMD中文成功' });
  assert.equal(mixed.exit_code, 0);
  assert.ok(mixed.stdout.includes('native中文'));
  assert.ok(mixed.stdout.includes('CMD中文成功'));
  const batch = await run({ shell: 'cmd', command: 'echo %cd%\necho %~f0' });
  const lines = batch.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], cwd);
  assert.match(path.basename(lines[1]), /^notion-command-[a-f0-9-]+\.cmd$/);
  await assert.rejects(stat(lines[1]), { code: 'ENOENT' });
});

test('PowerShell reports native exit codes, script errors and missing commands', windowsOnly, async () => {
  const native = await run({ command: 'node -e "process.exit(13)"' });
  assert.equal(native.exit_code, 13);
  for (const command of ['throw "测试失败"', 'notion_nonexistent_command_123']) {
    const result = await run({ command });
    assert.equal(result.status, 'failed');
    assert.ok(result.exit_code !== 0);
    assert.ok(result.stderr.length > 0);
  }
});

test('output truncation preserves UTF-8 boundaries and bounds the combined result', windowsOnly, async () => {
  const result = await run({ command: '[Console]::Out.Write(("中文😀" * 6000))', max_output_bytes: 256 });
  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 256);
  assert.ok(!result.stdout.includes('\uFFFD'));
  const escaped = await run({ command: '[Console]::Out.Write(([string][char]0 * 9000))' });
  assert.equal(escaped.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) < 80_000);
});

test('timeout terminates the shell and its native child process', windowsOnly, async () => {
  for (const shell of ['powershell', 'cmd']) {
    const result = await run({ shell, command: 'node -e "console.log(process.pid); setTimeout(() => {}, 60000)"', timeout_ms: 5000 });
    assert.equal(result.status, 'timed_out');
    assert.equal(result.timed_out, true);
    const pid = Number(result.stdout.trim());
    assert.ok(pid > 0, JSON.stringify(result));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.ok(result.duration_ms < 15_000);
  }
});

test('cancellation stops an active command and rejects a pre-cancelled request', windowsOnly, async () => {
  const controller = new AbortController();
  const pending = run({ command: 'Start-Sleep -Seconds 60' }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.timed_out, false);
  } finally { clearTimeout(timer); }
  await assert.rejects(run({ command: 'Write-Output never' }, controller.signal), { name: 'AbortError' });
});

test('command validation and working directory errors prevent execution', windowsOnly, async () => {
  for (const args of [{ command: '' }, { command: ' ' }, { command: 'a\0b' }, { command: 'x', shell: 'unknown' }, { command: 'x', timeout_ms: 0 }]) {
    assert.equal(commandSchema.safeParse(args).success, false);
  }
  await assert.rejects(run({ command: 'Write-Output never', cwd: 'missing' }), { code: 'ENOENT' });
  await assert.rejects(run({ command: 'Write-Output never', cwd: '..' }), { code: 'ACCESS_DENIED' });
  const file = path.join(cwd, 'file.txt');
  await writeFile(file, 'fixture');
  await assert.rejects(run({ command: 'Write-Output never', cwd: file }), { code: 'NOT_DIRECTORY' });
});
