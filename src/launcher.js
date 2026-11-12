import { spawn, execFile } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { configPath, loadConfig } from './config.js';
import { requestClient, saveJson } from './storage.js';
import { windowsDesktop } from './desktop.js';

const execFileAsync = promisify(execFile);

export async function startReceiver(config) {
  const runtime = path.join(path.dirname(config.configFile), '.runtime');
  const lock = path.join(runtime, 'client.lock');
  const current = await requestClient(lock);
  if (current?.role === 'worker' && current.phase !== 'stopping') return current;
  if (current) throw new Error('客户端正在配置或关闭，请稍后重试。');
  await mkdir(runtime, { recursive: true });
  const output = await open(path.join(runtime, 'client.log'), 'a');
  let errors;
  try {
    errors = await open(path.join(runtime, 'client-error.log'), 'a');
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'worker.js')], {
      cwd: path.dirname(config.configFile),
      env: { ...process.env, NOTION_MCP_CONFIG: config.configFile },
      detached: true, windowsHide: true, shell: false,
      stdio: ['ignore', output.fd, errors.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await output.close(); await errors?.close(); }
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const running = await requestClient(lock);
    if (running?.role === 'worker') return running;
  }
  throw new Error('后台接收器未能启动，请查看 .runtime/client-error.log。');
}

export async function stopReceiver(filename) {
  const lock = path.join(path.dirname(filename), '.runtime', 'client.lock');
  const current = await requestClient(lock);
  if (!current) return;
  if (current.role !== 'worker') throw new Error('当前进程正在配置，或属于旧版客户端，请等待配置完成或关闭旧客户端。');
  await requestClient(lock, 'stop');
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(1000);
    if (!(await requestClient(lock))) return;
  }
  throw new Error('客户端正在完成当前任务，停止请求已发送，请稍后重试。');
}

export async function createShortcut(config) {
  await saveJson(path.join(import.meta.dirname, '..', '.runtime', 'launcher.json'), {
    nodeExecutable: process.execPath, configFile: config.configFile,
  });
  const entrypoint = path.join(import.meta.dirname, '..', 'client.ps1');
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${entrypoint}" -Action Open`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPath = Join-Path $shell.SpecialFolders.Item('Desktop') 'Notion 本机助手.lnk'
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $env:NOTION_LAUNCHER_EXE
    $shortcut.Arguments = $env:NOTION_LAUNCHER_ARGS
    $shortcut.WorkingDirectory = $env:NOTION_LAUNCHER_ROOT
    $shortcut.WindowStyle = 7
    $shortcut.Description = '打开 Notion，同时连接本机文件和程序'
    $notion = Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Notion\\shell\\open\\command' -ErrorAction SilentlyContinue
    if ($notion -and $notion.'(default)' -match '^"([^"]+\\.exe)"') { $shortcut.IconLocation = $Matches[1] + ',0' }
    $shortcut.Save()
    [Console]::Out.Write($shortcutPath)
  `;
  const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15_000,
    env: { ...process.env, NOTION_LAUNCHER_EXE: executable, NOTION_LAUNCHER_ARGS: args, NOTION_LAUNCHER_ROOT: path.dirname(config.configFile) },
  });
  return stdout.trim();
}

async function main() {
  const action = process.argv[2] || 'open';
  if (action === 'stop') { await stopReceiver(configPath()); console.log('后台接收器已停止。'); return; }
  if (action === 'status') {
    console.log(JSON.stringify(await requestClient(path.join(path.dirname(configPath()), '.runtime', 'client.lock'))));
    return;
  }
  const config = await loadConfig();
  if (action === 'shortcut') { console.log(await createShortcut(config)); return; }
  if (!['open', 'start'].includes(action)) throw new Error('可用命令为 open、start、stop、status、shortcut。');
  const running = await startReceiver(config);
  if (action === 'open') await windowsDesktop.openNotion();
  console.log(`后台接收器已就绪，进程 ${running.pid}。MCP 将在收到任务后启动。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
