import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';

export async function saveJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true });
  await rename(temporary, filename);
}

export async function readJson(filename, fallback) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function lockPipe(filename) {
  const key = createHash('sha256').update(path.resolve(filename).toLowerCase()).digest('hex');
  return `\\\\.\\pipe\\notion-local-${key}`;
}

export async function requestClient(filename, command = 'status') {
  const owner = await readJson(filename, null);
  if (!owner) return null;
  return new Promise((resolve, reject) => {
    const socket = createConnection(lockPipe(filename));
    let reply = '';
    let connected = false;
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('客户端状态查询超时。')));
    socket.once('connect', () => { connected = true; socket.write(`${JSON.stringify({ id: owner.id, command })}\n`); });
    socket.on('data', (chunk) => { reply += chunk; if (reply.length > 8192) socket.destroy(new Error('客户端响应过长。')); });
    socket.once('error', (error) => {
      if (error.code === 'ECONNRESET' && connected) resolve({ pid: owner.pid, role: 'legacy' });
      else if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) resolve(null);
      else reject(error);
    });
    socket.once('end', () => {
      if (!reply) { resolve({ pid: owner.pid, role: 'legacy' }); return; }
      try { resolve(JSON.parse(reply)); }
      catch { reject(new Error('客户端状态响应无效。')); }
    });
  });
}

export async function acquireLock(filename, onCommand = () => ({ role: 'setup' })) {
  if (process.platform !== 'win32') throw new Error('本机客户端需要 Windows。');
  await mkdir(path.dirname(filename), { recursive: true });
  const owner = { pid: process.pid, id: randomUUID() };
  // Windows releases the named pipe on process exit, including abrupt crashes.
  // The JSON file is informational and cannot cause stale-lock recovery races.
  const mutex = createServer((socket) => {
    let input = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      try {
        const request = JSON.parse(input.trim());
        if (request.id !== owner.id || !['status', 'stop'].includes(request.command)) { socket.destroy(); return; }
        socket.end(`${JSON.stringify({ pid: owner.pid, ...onCommand(request.command) })}\n`);
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => {
    mutex.once('error', (error) => reject(error.code === 'EADDRINUSE' ? new Error('本机客户端已运行。') : error));
    mutex.listen(lockPipe(filename), resolve);
  });
  try { await saveJson(filename, owner); }
  catch (error) { await new Promise((resolve) => mutex.close(resolve)); throw error; }
  return async () => {
    try {
      const current = await readJson(filename, null);
      if (current?.id === owner.id) await unlink(filename);
    } finally { await new Promise((resolve) => mutex.close(resolve)); }
  };
}

async function dpapi(input, decrypt) {
  if (process.platform !== 'win32') throw new Error('当前登录凭据存储使用 Windows DPAPI。');
  const script = decrypt
    ? `Add-Type -AssemblyName System.Security; $value = [Console]::In.ReadToEnd(); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value), $null, 'CurrentUser')))`
    : `Add-Type -AssemblyName System.Security; $value = [Console]::In.ReadToEnd(); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value), $null, 'CurrentUser')))`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error('Windows 凭据加密或解密失败，请在相同的 Windows 用户下重新登录。'));
    });
    child.stdin.end(input);
  });
}

export async function saveSecret(filename, value) {
  await saveJson(filename, { encrypted: await dpapi(JSON.stringify(value), false) });
}

export async function readSecret(filename) {
  const value = await readJson(filename, null);
  return value ? JSON.parse(await dpapi(value.encrypted, true)) : {};
}
