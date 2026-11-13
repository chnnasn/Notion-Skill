import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { authorizeAction } from '../src/approval.js';
import { automaticCommand, readOnlyCommand } from '../src/command-policy.js';
import { runCommand } from '../src/commands.js';
import { DesktopControl } from '../src/desktop.js';
import { FileAccessError, LocalFiles } from '../src/filesystem.js';

const windowsOnly = { skip: process.platform !== 'win32' };
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-risk-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, files: new LocalFiles([directory]) };
}

test('AI can escalate risk but cannot bypass local rules, including old requests', async () => {
  let prompts = 0;
  const deny = async () => { prompts++; return false; };
  const low = { risk: { level: 'low', reason: 'read only' } };
  assert.equal((await authorizeAction(low, true, undefined, deny)).decision, 'automatic');
  assert.equal(prompts, 0);
  for (const [action, automatic] of [[low, false], [{}, false], [{ risk: { level: 'high', reason: 'sensitive' } }, true], [{ risk: { level: 'unknown', reason: 'uncertain' } }, true]]) {
    await assert.rejects(authorizeAction(action, automatic, undefined, deny), { code: 'USER_DECLINED' });
  }
  assert.equal(prompts, 4);
  const confirmed = await authorizeAction(low, false, undefined, async () => true);
  assert.equal(confirmed.decision, 'confirmed');
  await assert.rejects(authorizeAction({}, false, undefined, async () => 'true'), { code: 'USER_DECLINED' });
  await assert.rejects(authorizeAction({ risk: { level: 'low', reason: 'x', approved: true } }, true, undefined, deny));
});

test('only complete read-only command forms are automatic', () => {
  for (const command of ['git status', 'git status --short --branch', 'git diff --stat', 'git log -n 3 --oneline', 'git rev-parse --show-toplevel', 'node --version']) {
    assert.ok(readOnlyCommand(command), command);
  }
  for (const command of [
    'git push', 'git pull', 'git reset --hard', 'git clean -fd', 'git commit -m x', 'npm test', 'python script.py',
    'git status; Remove-Item x', 'git status\nRemove-Item x', 'git status && echo x', 'git status | cmd',
    'git status > out.txt', 'git status $(whoami)', 'git status `n whoami', 'git -c core.pager=cmd status',
    'git diff --output=file', 'git log --ext-diff', 'git log --format=%G?', 'git log -n 3 --show-signature',
    '.\\git.exe status', 'git.exe status', 'node --version --require evil.js', 'cmd /c git status',
  ]) assert.equal(readOnlyCommand(command), null, command);
});

test('denial, timeout, unavailable UI and cancellation cannot start a command', windowsOnly, async (t) => {
  const { directory, files } = await fixture(t);
  const args = { command: 'Set-Content -LiteralPath marker.txt -Value executed', cwd: directory, risk: { level: 'low', reason: 'claims safe' } };
  const confirmers = [
    async () => false,
    async () => { throw new FileAccessError('APPROVAL_TIMEOUT', 'timeout'); },
    async () => { throw new FileAccessError('APPROVAL_UNAVAILABLE', 'unavailable'); },
  ];
  for (const confirm of confirmers) {
    await assert.rejects(runCommand(args, files, undefined, confirm));
    await assert.rejects(readFile(path.join(directory, 'marker.txt')), { code: 'ENOENT' });
  }
  const controller = new AbortController();
  await assert.rejects(runCommand(args, files, controller.signal, async () => { controller.abort(); return true; }), { name: 'AbortError' });
  await assert.rejects(readFile(path.join(directory, 'marker.txt')), { code: 'ENOENT' });
});

test('low-risk version queries skip approval and approved commands record the decision', windowsOnly, async (t) => {
  const { directory, files } = await fixture(t);
  const result = await runCommand({ command: 'node --version', cwd: directory }, files, undefined, async () => assert.fail('unexpected prompt'));
  assert.equal(result.stdout.trim(), process.version);
  assert.equal(result.safety.decision, 'automatic');
  let shown;
  const confirmed = await runCommand({ command: 'Write-Output approved', cwd: directory }, files, undefined, async (action) => { shown = action; return true; });
  assert.equal(confirmed.stdout.trim(), 'approved');
  assert.equal(confirmed.safety.decision, 'confirmed');
  assert.equal(shown.cwd, directory);
  assert.equal(shown.command, 'Write-Output approved');
});

test('automatic Git uses an absolute executable and blocks external helpers and network fetches', windowsOnly, async (t) => {
  const { directory } = await fixture(t);
  await writeFile(path.join(directory, 'git.cmd'), '@echo unsafe');
  const plan = await automaticCommand('git log -n 3 --oneline', directory);
  assert.ok(plan);
  assert.ok(path.isAbsolute(plan.executable));
  assert.notEqual(path.dirname(plan.executable), directory);
  assert.ok(plan.args.includes('--no-pager'));
  assert.ok(plan.args.includes('--no-textconv'));
  assert.ok(plan.args.includes('--no-show-signature'));
  assert.ok(plan.args.includes('core.fsmonitor=false'));
  assert.equal(plan.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(plan.env.GIT_NO_LAZY_FETCH, '1');
  assert.equal(plan.env.GIT_ALLOW_PROTOCOL, '');
  const git = promisify(execFile);
  await git(plan.executable, ['init', directory], { windowsHide: true });
  await git(plan.executable, ['config', 'filter.safety-test.clean', 'echo external-helper'], { cwd: directory, windowsHide: true });
  assert.equal(await automaticCommand('git status --short', directory), null);
  assert.equal(await automaticCommand('git diff --stat', directory), null);
});

test('desktop policy automatically reveals paths and gates arbitrary apps and default handlers', windowsOnly, async (t) => {
  const { directory, files } = await fixture(t);
  const target = path.join(directory, 'example.txt');
  await writeFile(target, 'content');
  let opens = 0;
  let launches = 0;
  let prompts = 0;
  const driver = { async processes() { return []; }, async open() { opens++; }, async launch() { launches++; return 123; } };
  const settings = { desktop: { enabled: true, openExtensions: ['.txt'], apps: {
    custom: { executable: process.execPath },
    notepad: { executable: path.join(process.env.SystemRoot, 'System32', 'notepad.exe') },
  } } };
  const desktop = new DesktopControl(settings, files, driver, async () => { prompts++; return false; });
  assert.equal((await desktop.openPath(target, 'reveal')).safety.decision, 'automatic');
  assert.equal((await desktop.openPath(directory, 'open')).safety.decision, 'automatic');
  assert.equal((await desktop.ensureApp('notepad')).safety.decision, 'automatic');
  assert.equal((await desktop.openPath(target, 'open', 'notepad')).safety.decision, 'automatic');
  const risk = { level: 'low', reason: 'claims safe' };
  await assert.rejects(desktop.ensureApp('custom', risk), { code: 'USER_DECLINED' });
  await assert.rejects(desktop.openPath(target, 'open', 'custom', risk), { code: 'USER_DECLINED' });
  await assert.rejects(desktop.openPath(target, 'open', undefined, risk), { code: 'USER_DECLINED' });
  await assert.rejects(desktop.openPath(target, 'reveal', undefined, { level: 'high', reason: 'private' }), { code: 'USER_DECLINED' });
  assert.equal(prompts, 4);
  assert.equal(opens, 2);
  assert.equal(launches, 2);
});
