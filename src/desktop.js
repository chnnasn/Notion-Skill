import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { FileAccessError } from './filesystem.js';

const execFileAsync = promisify(execFile);

async function powershell(script, variables = {}) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(executable, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...variables },
  });
  return stdout.replace(/^\uFEFF/, '').trim();
}

export const windowsDesktop = {
  async drives() {
    if (process.platform !== 'win32') return ['/'];
    const output = await powershell(`
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      ConvertTo-Json -InputObject @([Environment]::GetLogicalDrives()) -Compress
    `);
    return JSON.parse(output);
  },

  async locations() {
    if (process.platform !== 'win32') return { home: os.homedir() };
    const output = await powershell(`
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $locations = [ordered]@{
        desktop = [Environment]::GetFolderPath('DesktopDirectory')
        documents = [Environment]::GetFolderPath('MyDocuments')
        home = [Environment]::GetFolderPath('UserProfile')
      }
      try {
        $downloads = (New-Object -ComObject Shell.Application).Namespace('shell:Downloads')
        if ($downloads) { $locations['downloads'] = $downloads.Self.Path }
      } catch { }
      $locations | ConvertTo-Json -Compress
    `);
    return Object.fromEntries(Object.entries(JSON.parse(output)).filter(([, value]) => value && path.isAbsolute(value)));
  },

  async openNotion() {
    await powershell(`
      $ErrorActionPreference = 'Stop'
      $target = 'https://www.notion.so'
      if (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Notion\\shell\\open\\command') {
        $target = 'notion://www.notion.so'
      }
      Start-Process -FilePath $target -WindowStyle Normal
    `);
  },

  async processes(packageNames = []) {
    const output = await powershell(`
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $sessionId = (Get-Process -Id $PID).SessionId
      $items = @(Get-CimInstance Win32_Process -Filter "SessionId = $sessionId" | Where-Object { $_.ExecutablePath } | Select-Object ProcessId, ExecutablePath)
      $names = ConvertFrom-Json -InputObject $env:NOTION_MCP_PACKAGES
      foreach ($name in $names) {
        $package = Get-AppxPackage -Name $name | Select-Object -First 1
        if ($package -and $package.InstallLocation) {
          $prefix = $package.InstallLocation.TrimEnd([char]92) + [char]92
          foreach ($item in $items) {
            if ($item.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
              $item | Add-Member -NotePropertyName PackageName -NotePropertyValue $package.Name -Force
            }
          }
        }
      }
      ConvertTo-Json -InputObject $items -Compress
    `, { NOTION_MCP_PACKAGES: JSON.stringify(packageNames) });
    return JSON.parse(output || '[]');
  },

  async open(target, reveal) {
    // File paths travel as environment data, preserving quotes and shell metacharacters.
    await powershell(`
      $ErrorActionPreference = 'Stop'
      if ($env:NOTION_MCP_REVEAL -eq '1') {
        $arguments = '/select,"' + $env:NOTION_MCP_TARGET + '"'
        Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList $arguments -WindowStyle Normal
      } else {
        Start-Process -FilePath $env:NOTION_MCP_TARGET -WindowStyle Normal
      }
    `, { NOTION_MCP_TARGET: target, NOTION_MCP_REVEAL: reveal ? '1' : '0' });
  },

  async launch(executable, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve(child.pid);
      });
    });
  },
};

export class DesktopControl {
  constructor(config, files, driver = windowsDesktop) {
    this.settings = config.desktop || { enabled: false, apps: {}, openExtensions: [] };
    this.files = files;
    this.driver = driver;
    this.pendingApps = new Map();
  }

  assertEnabled() {
    if (!this.settings.enabled) throw new FileAccessError('DESKTOP_DISABLED', '请先在本机配置 desktop.enabled。');
    if (process.platform !== 'win32') throw new FileAccessError('UNSUPPORTED_PLATFORM', '当前桌面操作支持 Windows。');
  }

  async listApps() {
    this.assertEnabled();
    const packages = [...new Set(Object.values(this.settings.apps).map((app) => app.packageName).filter(Boolean))];
    const processes = await this.driver.processes(packages);
    return {
      apps: Object.entries(this.settings.apps).map(([name, app]) => ({
        name,
        description: app.description || name,
        executable: app.executable,
        running_pids: processes.filter((item) => path.relative(item.ExecutablePath, app.executable) === ''
          || (app.packageName && item.PackageName === app.packageName
            && path.basename(item.ExecutablePath).toLowerCase() === path.basename(app.executable).toLowerCase()))
          .map((item) => item.ProcessId),
      })),
    };
  }

  async ensureApp(name) {
    this.assertEnabled();
    if (!Object.hasOwn(this.settings.apps, name)) throw new FileAccessError('UNKNOWN_APP', '请从 list_apps 返回的程序中选择。');
    if (this.pendingApps.has(name)) return this.pendingApps.get(name);
    const pending = this.startIfNeeded(name);
    this.pendingApps.set(name, pending);
    try {
      return await pending;
    } finally {
      this.pendingApps.delete(name);
    }
  }

  async startIfNeeded(name) {
    const { apps } = await this.listApps();
    const app = apps.find((item) => item.name === name);
    if (app.running_pids.length) return { name, status: 'already_running', pids: app.running_pids };
    const pid = await this.driver.launch(app.executable, []);
    return { name, status: 'launch_requested', pid };
  }

  async openPath(input, mode, appName) {
    this.assertEnabled();
    const info = await this.files.pathInfo(input);
    if (!['file', 'directory'].includes(info.type)) throw new FileAccessError('UNSUPPORTED_TYPE', '只能打开普通文件或目录。');
    if (appName) {
      if (mode === 'reveal') throw new FileAccessError('INVALID_MODE', '指定 app 时使用 open 模式。');
      if (!Object.hasOwn(this.settings.apps, appName)) throw new FileAccessError('UNKNOWN_APP', '请从 list_apps 返回的程序中选择。');
      const pid = await this.driver.launch(this.settings.apps[appName].executable, [info.path]);
      return { path: info.path, app: appName, status: 'open_requested', pid };
    }
    if (mode === 'open' && info.type === 'file' && !this.settings.openExtensions.includes(path.extname(info.path).toLowerCase())) {
      throw new FileAccessError('APP_REQUIRED', '请指定 list_apps 中的程序打开此文件，或使用 reveal 在资源管理器中定位。可在本机配置 openExtensions 调整默认应用打开的文件类型。');
    }
    await this.driver.open(info.path, mode === 'reveal' && info.type === 'file');
    return { path: info.path, status: 'open_requested', mode };
  }
}
