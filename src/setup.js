import { randomBytes } from 'node:crypto';
import { realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configPath } from './config.js';

async function setup() {
  const inputs = process.argv.slice(2);
  if (inputs.includes('--help')) {
    console.log('用法：npm run setup -- "E:\\Documents" "E:\\Projects"');
    console.log('省略目录时开启全电脑访问，当前工作目录作为相对路径基准。指定目录时使用限定目录模式。配置位置可通过 NOTION_MCP_CONFIG 指定。');
    return;
  }
  const roots = await Promise.all((inputs.length ? inputs : [process.cwd()]).map(async (input) => {
    const absolute = await realpath(path.resolve(input));
    if (!(await stat(absolute)).isDirectory()) {
      throw new Error(`目录无效：${input}`);
    }
    return absolute;
  }));
  const filename = configPath();
  const config = {
    accessMode: inputs.length ? 'restricted' : 'all',
    roots: [...new Set(roots)], token: randomBytes(32).toString('base64url'), port: 3210,
  };
  await writeFile(filename, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`已创建配置 ${filename}`);
  console.log(config.accessMode === 'all' ? '已开启全电脑访问，使用当前 Windows 账户权限。' : `可访问目录\n${config.roots.join('\n')}`);
  console.log('接下来运行 npm run login，在浏览器中登录 Notion 并授权。');
  console.log('随后运行 npm run install-skill 安装此设备的 Skill，再运行 npm run client 接收任务。');
}

setup().catch((error) => {
  console.error(error.code === 'EEXIST'
    ? '配置文件已存在。请编辑现有配置以调整 accessMode 或 roots，随后运行 npm run login。'
    : error.message);
  process.exitCode = 1;
});
