import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { connectNotion } from './notion-auth.js';
import { callNotion, deviceTag, pageId } from './notion-queue.js';
import { acquireLock, readJson, saveJson } from './storage.js';

const skillTitle = 'Notion-skill';

export async function findDeviceSkill(client, deviceId) {
  const matches = new Map();
  const titles = [skillTitle, `本机文件与程序 ${deviceId.slice(0, 8)}`];
  for (const title of titles) {
    const found = await callNotion(client, 'notion-search', { query: title, page_size: 50 });
    for (const result of (found.results || []).filter((page) => page.title === title)) {
      const page = await callNotion(client, 'notion-fetch', { id: result.url });
      if (!page.text?.includes(deviceId)) continue;
      const id = pageId(page.url).replaceAll('-', '').toLowerCase();
      matches.set(id, { deviceId, pageId: id, url: page.url });
    }
  }
  if (matches.size > 1) throw new Error('找到多个属于当前设备的 Skill 页面，请检查后重试。');
  return matches.values().next().value || null;
}

async function install() {
  const config = await loadConfig();
  if (!config.notion) throw new Error('请先运行 npm run login。');
  const runtime = path.join(path.dirname(config.configFile), '.runtime');
  const unlock = await acquireLock(path.join(runtime, 'client.lock'));
  let client;
  try {
    const template = await readFile(new URL('../skills/notion-local-files/SKILL.md', import.meta.url), 'utf8');
    const markdown = template.replaceAll('{{DEVICE_ID}}', config.notion.deviceId).replaceAll('{{DEVICE_TAG}}', deviceTag(config.notion.deviceId));
    const description = markdown.match(/^description: (.+)$/m)[1];
    const content = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    const folder = path.join(runtime, 'notion-local-files');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), markdown, 'utf8');
    client = await connectNotion(config);
    await callNotion(client, 'notion-fetch', { id: 'notion://docs/skills' });
    await callNotion(client, 'notion-fetch', { id: 'notion://docs/notion-flavored-markdown-spec' });
    const filename = path.join(runtime, 'skill.json');
    let state = await readJson(filename, null);
    if (state && state.deviceId !== config.notion.deviceId) throw new Error('已保存的 Skill 属于其他设备，请检查本机配置。');
    if (!state) {
      state = await findDeviceSkill(client, config.notion.deviceId);
      if (!state) {
        const created = await callNotion(client, 'notion-create-pages', {
          creation_mode: 'draft', allow_async: false,
          pages: [{ properties: { title: skillTitle }, content, is_skill: true }],
        });
        if (created.warnings?.length) console.log(`Notion 提示 ${JSON.stringify(created.warnings)}`);
        const page = created.pages?.[0];
        if (!page) throw new Error('Notion 创建结果缺少 Skill 页面。');
        state = { deviceId: config.notion.deviceId, pageId: pageId(page.id || page.url), url: page.url };
      }
      await saveJson(filename, state);
    }
    const fetched = await callNotion(client, 'notion-fetch', { id: state.pageId });
    if (!fetched.text?.includes(config.notion.deviceId)) throw new Error('已保存的 Skill 页面设备标识不匹配。');
    await callNotion(client, 'notion-update-page', { page_id: state.pageId, command: 'replace_content', new_str: content, allow_async: false });
    await callNotion(client, 'notion-update-page', {
      page_id: state.pageId, command: 'update_properties', is_skill: true,
      properties: { title: skillTitle, skill_description: description }, allow_async: false,
    });
    const settings = await callNotion(client, 'notion-update-skill-settings', {
      skill_url: state.url, settings: { enabled: true, use_automatically: true, show_in_chat: true },
    });
    await saveJson(path.join(runtime, 'skill-settings.json'), settings);
    const confirmed = await callNotion(client, 'notion-fetch', { id: state.pageId });
    if (confirmed.title !== skillTitle) throw new Error('Skill 名称尚未确认保存。');
    if (!confirmed.text?.includes(description)) throw new Error('Skill 描述尚未确认保存。');
    state.installed = new Date().toISOString();
    await saveJson(filename, state);
    console.log(`Skill 已安装并开启自动调用 ${state.url}`);
    console.log('在 Notion 新建聊天后使用。接收器在线期间，可以通过 Skill 开启、关闭或按需启动 MCP。');
  } finally {
    await client?.close();
    await unlock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  install().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
