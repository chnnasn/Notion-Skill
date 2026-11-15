import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { FileAccessError } from './filesystem.js';

const execFileAsync = promisify(execFile);
export const APPROVAL_TIMEOUT_MS = 120_000;
export const hostApproval = async () => true;
export const riskSchema = z.object({
  level: z.enum(['low', 'high', 'unknown']),
  reason: z.string().min(1).max(1000),
}).strict().optional().describe('AI risk assessment. High or unknown requires local confirmation. Low is verified by local rules and cannot override them.');

let showingPrompt = false;

export async function confirmLocally(action, signal) {
  signal?.throwIfAborted();
  if (showingPrompt) throw new FileAccessError('APPROVAL_BUSY', '另一个操作正在等待本机确认，请在该操作结束后再试。');
  if (process.platform !== 'win32') throw new FileAccessError('APPROVAL_UNAVAILABLE', '当前平台无法显示本机确认窗口。');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Request content is passed as data and only rendered in a plain text control.
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Notion-skill 操作确认'
    $form.Size = New-Object System.Drawing.Size(780, 580)
    $form.MinimumSize = $form.Size
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true
    $form.Tag = 'DENIED'
    $details = New-Object System.Windows.Forms.TextBox
    $details.Multiline = $true
    $details.ReadOnly = $true
    $details.ScrollBars = 'Both'
    $details.WordWrap = $false
    $details.Dock = 'Fill'
    $details.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
    $details.Text = $env:NOTION_MCP_APPROVAL_TEXT
    $buttons = New-Object System.Windows.Forms.FlowLayoutPanel
    $buttons.Dock = 'Bottom'
    $buttons.Height = 55
    $buttons.FlowDirection = 'RightToLeft'
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = '取消'
    $cancel.Width = 120
    $cancel.Height = 35
    $cancel.Add_Click({ $form.Close() })
    $approve = New-Object System.Windows.Forms.Button
    $approve.Text = '允许本次'
    $approve.Width = 120
    $approve.Height = 35
    $approve.Add_Click({ $form.Tag = 'APPROVED'; $form.Close() })
    $buttons.Controls.Add($cancel)
    $buttons.Controls.Add($approve)
    $form.Controls.Add($details)
    $form.Controls.Add($buttons)
    $form.AcceptButton = $cancel
    $form.CancelButton = $cancel
    $form.Add_Shown({ $form.Activate(); [void]$cancel.Focus() })
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = ${APPROVAL_TIMEOUT_MS}
    $timer.Add_Tick({ $timer.Stop(); $form.Tag = 'TIMED_OUT'; $form.Close() })
    $timer.Start()
    try { [void]$form.ShowDialog(); [Console]::Write($form.Tag) }
    finally { $timer.Dispose(); $form.Dispose() }
  `;
  showingPrompt = true;
  try {
    const { stdout } = await execFileAsync(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      windowsHide: true, signal, timeout: APPROVAL_TIMEOUT_MS + 5000, maxBuffer: 16 * 1024,
      env: { ...process.env, NOTION_MCP_APPROVAL_TEXT: [
        '请核对完整操作。允许本次后将使用当前 Windows 账户权限执行。',
        '关闭窗口、按回车或 Esc 将取消，等待两分钟后自动取消。', '',
        JSON.stringify(action, null, 2),
      ].join('\r\n') },
    });
    if (stdout.trim() === 'TIMED_OUT') throw new FileAccessError('APPROVAL_TIMEOUT', '本机确认已超时，操作未执行。');
    return stdout.trim() === 'APPROVED';
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof FileAccessError) throw error;
    throw new FileAccessError('APPROVAL_UNAVAILABLE', '本机确认窗口不可用，操作未执行。');
  } finally {
    showingPrompt = false;
  }
}

export async function authorizeAction(action, automatic, signal, confirm = confirmLocally) {
  signal?.throwIfAborted();
  const risk = riskSchema.parse(action.risk);
  if (confirm === hostApproval) return { decision: 'host_managed', reason: '由已认证 MCP 客户端管理审批', ...(risk ? { ai: risk } : {}) };
  if (automatic && (!risk || risk.level === 'low')) {
    return { decision: 'automatic', reason: '本机规则验证为低风险操作', ...(risk ? { ai: risk } : {}) };
  }
  const approved = await confirm({ ...action, risk, local_reason: automatic
    ? 'AI 判断需要用户确认'
    : '操作涉及变更或本机规则无法确认其风险' }, signal);
  signal?.throwIfAborted();
  if (approved !== true) throw new FileAccessError('USER_DECLINED', '用户取消了本机确认，操作未执行。');
  return { decision: 'confirmed', reason: '用户在本机允许本次操作', ...(risk ? { ai: risk } : {}) };
}
