import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { configPath, loadConfig } from './config.js';
import { connectNotion } from './notion-auth.js';
import { acquireLock, readJson, saveJson } from './storage.js';

async function login() {
  const filename = configPath();
  const config = await readJson(filename, null);
  if (!config) throw new Error('请先运行 npm run setup。');
  const runtime = path.join(path.dirname(filename), '.runtime');
  const unlock = await acquireLock(path.join(runtime, 'setup.lock'));
  try {
    config.notion ||= { deviceId: randomUUID(), oauthPort: 3211 };
    config.desktop ||= { enabled: true, apps: { notepad: { executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe'), description: '记事本', packageName: 'Microsoft.WindowsNotepad' } } };
    config.desktop.enabled = true;
    await saveJson(filename, config);
    const loaded = await loadConfig();
    const client = await connectNotion(loaded, { interactive: true });
    try {
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools({ cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      await saveJson(path.join(runtime, 'notion-tools.json'), tools);
      console.log(`Notion 登录成功，可用工具 ${tools.length} 个。`);
    } finally { await client.close(); }
  } finally { await unlock(); }
}

login().catch((error) => { console.error([error.message, error.cause?.code].filter(Boolean).join(' ')); process.exitCode = 1; });
