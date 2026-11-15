import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import ExcelJS from 'exceljs';
import { FileActions } from '../src/file-actions.js';
import { LocalFiles } from '../src/filesystem.js';
import { hostApproval } from '../src/approval.js';
import { readDocument } from '../src/documents.js';
import { CommandTasks } from '../src/command-tasks.js';
import { runCommand } from '../src/commands.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notion-extended-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new LocalFiles([root], [path.join(root, 'secret.json'), path.join(root, '.runtime')]);
  return { root, files, actions: new FileActions(files, hostApproval) };
}

test('move, rename and directory copy preserve data and reject collisions, nesting, links and protected ancestors', async (t) => {
  const { root, actions } = await fixture(t);
  await mkdir(path.join(root, 'source/sub'), { recursive: true });
  await writeFile(path.join(root, 'source/sub/a.txt'), '中文内容');
  await actions.copyDirectory({ source: 'source', destination: 'copied' });
  assert.equal(await readFile(path.join(root, 'copied/sub/a.txt'), 'utf8'), '中文内容');
  await actions.rename({ path: 'copied/sub/a.txt', name: 'b.txt' });
  await actions.move({ source: 'copied/sub/b.txt', destination: 'moved.txt' });
  assert.equal(await readFile(path.join(root, 'moved.txt'), 'utf8'), '中文内容');
  await actions.move({ source: 'copied', destination: 'moved-directory' });
  await assert.rejects(stat(path.join(root, 'copied')), { code: 'ENOENT' });
  await assert.rejects(actions.move({ source: 'moved.txt', destination: 'source' }), { code: 'EEXIST' });
  await assert.rejects(actions.copyDirectory({ source: 'source', destination: 'source/inside' }), { code: 'INVALID_DESTINATION' });
  await assert.rejects(actions.move({ source: '.', destination: 'root-moved' }), { code: 'ACCESS_DENIED' });
  await symlink(path.join(root, 'source'), path.join(root, 'source/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(actions.copyDirectory({ source: 'source', destination: 'failed-copy' }), { code: 'LINK_UNSUPPORTED' });
  await assert.rejects(stat(path.join(root, 'failed-copy')), { code: 'ENOENT' });
});

test('partial edits require unambiguous matches and keep backups, encodings and conflict checks', async (t) => {
  const { root, files, actions } = await fixture(t);
  const target = path.join(root, 'edit.txt');
  await writeFile(target, '\uFEFF你好\r\nrepeat repeat', 'utf16le');
  await assert.rejects(actions.edit({ path: target, encoding: 'utf16le', edits: [{ old_text: 'repeat', new_text: 'x' }] }), { code: 'EDIT_MATCH' });
  const result = await actions.edit({ path: target, encoding: 'utf16le', edits: [{ old_text: '你好', new_text: '完成' }, { old_text: 'repeat', new_text: '$&', replace_all: true }] });
  assert.equal(await readFile(target, 'utf16le'), '\uFEFF完成\r\n$& $&');
  assert.equal(await readFile(result.backup_path, 'utf16le'), '\uFEFF你好\r\nrepeat repeat');
  await assert.rejects(actions.edit({ path: target, encoding: 'utf16le', expected_sha256: '0'.repeat(64), edits: [{ old_text: '完成', new_text: 'bad' }] }), { code: 'FILE_CHANGED' });
  const changing = new FileActions(files, async () => { await writeFile(target, 'external edit'); return true; });
  await assert.rejects(changing.edit({ path: target, encoding: 'utf16le', edits: [{ old_text: '完成', new_text: 'bad' }] }), { code: 'FILE_CHANGED' });
  assert.equal(await readFile(target, 'utf8'), 'external edit');
});

test('document extraction parses DOCX, XLSX, PPTX, PDF and paginated UTF-8 text', async (t) => {
  const { root, files } = await fixture(t);
  const pack = (entries) => zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])));
  await writeFile(path.join(root, 'word.docx'), pack({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 中文正文</w:t></w:r></w:p></w:body></w:document>',
  }));
  assert.match((await readDocument({ path: 'word.docx' }, files)).content, /Word 中文正文/);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('表格').addRow(['名字', '张三', 42]);
  await writeFile(path.join(root, 'sheet.xlsx'), Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.match((await readDocument({ path: 'sheet.xlsx' }, files)).content, /张三\t42/);
  await writeFile(path.join(root, 'slides.pptx'), pack({ 'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:p><a:r><a:t>Slide 中文</a:t></a:r></a:p></p:cSld></p:sld>' }));
  assert.match((await readDocument({ path: 'slides.pptx' }, files)).content, /Slide 中文/);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 12 Tf 50 700 Td (Hello PDF) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(path.join(root, 'test.pdf'), pdf);
  assert.match((await readDocument({ path: 'test.pdf' }, files)).content, /Hello PDF/);
  await writeFile(path.join(root, 'text.txt'), '中文😀abcdef');
  const first = await readDocument({ path: 'text.txt', length: 4 }, files);
  const second = await readDocument({ path: 'text.txt', offset: first.next_offset }, files);
  assert.equal(first.content + second.content, '中文😀abcdef');
  await writeFile(path.join(root, 'secret.json'), 'protected');
  await assert.rejects(readDocument({ path: 'secret.json' }, files), { code: 'ACCESS_DENIED' });
});

test('tasks persist final results and live logs, and recover interrupted records without rerunning', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, '.runtime/tasks');
  const tasks = new CommandTasks(directory);
  let finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  const task = await tasks.start(async (signal, log) => { log('stdout', '实时中文😀\n'); await wait; return { status: 'completed', exit_code: 0 }; }, { command: 'test' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const live = await tasks.logs(task.task_id);
  assert.equal(live.status, 'running');
  assert.match(live.content, /实时中文😀/);
  finish(); await tasks.close();
  const recovered = new CommandTasks(directory);
  assert.equal((await recovered.get(task.task_id)).result.exit_code, 0);
  assert.match((await recovered.logs(task.task_id)).content, /实时中文😀/);
  const abandonedId = randomUUID();
  await writeFile(path.join(directory, `${abandonedId}.json`), JSON.stringify({ task_id: abandonedId, status: 'running', started_at: new Date().toISOString() }));
  const restart = new CommandTasks(directory);
  assert.equal((await restart.get(abandonedId)).status, 'interrupted');
  assert.equal((await restart.list()).tasks.length, 2);
});

test('command output is available in logs before the shell finishes', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, files } = await fixture(t);
  const tasks = new CommandTasks(path.join(root, '.runtime/tasks'));
  t.after(() => tasks.close());
  const task = await tasks.start((signal, log) => runCommand({ command: 'Write-Output "first中文"; Start-Sleep -Seconds 3; Write-Output done', cwd: root }, files, signal, hostApproval, log));
  let live;
  for (let attempt = 0; attempt < 30; attempt++) {
    live = await tasks.logs(task.task_id);
    if (live.content.includes('first中文')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.match(live.content, /first中文/);
  assert.equal(live.status, 'running');
  await tasks.close();
});
