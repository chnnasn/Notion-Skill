import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { findDeviceSkill } from '../src/install.js';

test('fixed-name Skill discovery selects the matching device and recovers legacy titles', async () => {
  const deviceId = randomUUID();
  const otherDeviceId = randomUUID();
  const currentId = randomUUID().replaceAll('-', '');
  const otherId = randomUUID().replaceAll('-', '');
  const current = { title: 'Notion-skill', url: `https://www.notion.so/${currentId}`, text: `设备标识为 ${deviceId}` };
  const other = { title: 'Notion-skill', url: `https://www.notion.so/${otherId}`, text: `设备标识为 ${otherDeviceId}` };
  const pages = [other, current];
  const client = {
    async callTool({ name, arguments: args }) {
      if (name === 'notion-search') {
        return { structuredContent: { results: pages.filter((page) => page.title === args.query) } };
      }
      assert.equal(name, 'notion-fetch');
      return { structuredContent: pages.find((page) => page.url === args.id) };
    },
  };
  assert.equal((await findDeviceSkill(client, deviceId)).pageId, currentId);
  current.title = `本机文件与程序 ${deviceId.slice(0, 8)}`;
  assert.equal((await findDeviceSkill(client, deviceId)).pageId, currentId);
  current.text = `设备标识为 ${otherDeviceId}`;
  assert.equal(await findDeviceSkill(client, deviceId), null);
  current.text = `设备标识为 ${deviceId}`;
  other.text = `设备标识为 ${deviceId}`;
  await assert.rejects(findDeviceSkill(client, deviceId), /多个属于当前设备/);
});
