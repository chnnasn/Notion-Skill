import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configPath, loadConfig } from './config.js';
import { requestClient, saveJson } from './storage.js';

const action = process.argv[2] || 'start';
const filename = configPath();
const runtime = path.join(path.dirname(filename), '.runtime');
const lock = path.join(runtime, 'native.lock');
try {
  if (action === 'configure') {
    const config = await loadConfig();
    await saveJson(path.join(import.meta.dirname, '..', '.runtime', 'native-runtime.json'), { nodeExecutable: process.execPath, configFile: config.configFile });
  } else if (action === 'status') {
    console.log(JSON.stringify(await requestClient(lock)));
  } else if (action === 'stop') {
    await requestClient(lock, 'stop');
    for (let attempt = 0; attempt < 40 && await requestClient(lock); attempt++) await delay(250);
    if (await requestClient(lock)) throw new Error('服务仍在停止，请稍后查询状态。');
    console.log('原生 MCP 已停止。');
  } else if (action === 'start') {
    const current = await requestClient(lock);
    if (current) { console.log(JSON.stringify(current)); }
    else {
      await mkdir(runtime, { recursive: true });
      const output = await open(path.join(runtime, 'native.log'), 'a');
      const errors = await open(path.join(runtime, 'native-error.log'), 'a');
      try {
        const child = spawn(process.execPath, [path.join(import.meta.dirname, 'native.js')], {
          cwd: path.dirname(filename), env: { ...process.env, NOTION_MCP_CONFIG: filename },
          detached: true, windowsHide: true, stdio: ['ignore', output.fd, errors.fd],
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { await output.close(); await errors.close(); }
      for (let attempt = 0; attempt < 65; attempt++) {
        await delay(1000);
        const state = await requestClient(lock);
        if (state?.phase === 'ready') { console.log(JSON.stringify(state)); break; }
        if (attempt === 64) throw new Error('原生 MCP 未就绪，请查看 .runtime/native-error.log。');
      }
    }
  } else throw new Error('可用命令为 start、stop、status、configure。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
