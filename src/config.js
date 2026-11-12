import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const CONFIG_FILENAME = '.notion-local-mcp.json';

const configSchema = z.object({
  roots: z.array(z.string().min(1)).min(1),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  port: z.number().int().min(1).max(65535).default(3210),
  publicUrl: z.string().url().optional(),
  notion: z.object({
    deviceId: z.string().uuid(),
    oauthPort: z.number().int().min(1).max(65535).default(3211),
    pollSeconds: z.number().int().min(5).max(300).default(10),
  }).strict().optional(),
  desktop: z.object({
    enabled: z.boolean().default(false),
    apps: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/), z.object({
      executable: z.string().min(1),
      description: z.string().max(200).optional(),
      packageName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/).optional(),
    }).strict()).default({}),
    openExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).default([
      '.txt', '.md', '.json', '.csv', '.log', '.pdf', '.docx', '.xlsx', '.pptx',
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.html', '.htm',
    ]),
  }).strict().default({ enabled: false, apps: {}, openExtensions: [] }),
}).strict();

export function configPath(env = process.env) {
  return path.resolve(env.NOTION_MCP_CONFIG || CONFIG_FILENAME);
}

export async function loadConfig(env = process.env) {
  const filename = configPath(env);
  let data;
  try {
    data = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('配置文件不存在。请先运行 npm run setup。');
    }
    throw new Error('配置文件读取失败，请检查权限和 JSON 格式。');
  }
  const parsed = configSchema.safeParse({
    ...data,
    ...(env.NOTION_MCP_TOKEN ? { token: env.NOTION_MCP_TOKEN } : {}),
    ...(env.NOTION_MCP_PUBLIC_URL ? { publicUrl: env.NOTION_MCP_PUBLIC_URL } : {}),
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'config');
    throw new Error(`配置项无效，请检查 ${fields.join(', ')}。`);
  }
  const config = parsed.data;
  if (config.publicUrl) {
    const url = new URL(config.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('publicUrl 应为 HTTPS 来源地址，例如 https://files.example.com。');
    }
    config.publicUrl = url.origin;
  }
  const roots = await Promise.all(config.roots.map(async (root) => {
    const absolute = await realpath(path.resolve(path.dirname(filename), root));
    if (!(await stat(absolute)).isDirectory()) {
      throw new Error(`roots 必须指向目录，当前值为 ${root}`);
    }
    return absolute;
  }));
  for (const app of Object.values(config.desktop.apps)) {
    app.executable = await realpath(path.resolve(path.dirname(filename), app.executable));
    if (!(await stat(app.executable)).isFile() || (process.platform === 'win32' && path.extname(app.executable).toLowerCase() !== '.exe')) {
      throw new Error('desktop.apps 中的 executable 应为应用程序的可执行文件路径。');
    }
  }
  return { ...config, roots: [...new Set(roots)], configFile: await realpath(filename) };
}
