import { open, stat } from 'node:fs/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FileAccessError } from './filesystem.js';

export const documentSchema = z.object({
  path: z.string().min(1).max(4096), offset: z.number().int().min(0).default(0),
  length: z.number().int().min(4).max(16000).default(8000),
}).strict();

export async function readDocument(args, files, signal) {
  args = documentSchema.parse(args);
  const filename = await files.resolve(args.path);
  const format = path.extname(filename).toLowerCase();
  if (!['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json'].includes(format)) {
    throw new FileAccessError('UNSUPPORTED_DOCUMENT', '支持 PDF、DOCX、XLSX、PPTX 和 UTF-8 文本，旧版 DOC/XLS/PPT 请先转换。');
  }
  const handle = await open(filename, 'r');
  let buffer;
  let info;
  try {
    info = await handle.stat();
    if (!info.isFile() || info.size > 20 * 1024 ** 2) throw new FileAccessError('DOCUMENT_LIMIT', '文档必须是最多 20 MiB 的普通文件。');
    await files.resolve(filename);
    const current = await stat(filename);
    if (current.ino !== info.ino || current.dev !== info.dev) throw new FileAccessError('FILE_CHANGED', '文档已被替换。');
    buffer = Buffer.alloc(info.size);
    let position = 0;
    while (position < buffer.length) {
      signal?.throwIfAborted();
      const part = await handle.read(buffer, position, buffer.length - position, position);
      if (!part.bytesRead) throw new FileAccessError('FILE_CHANGED', '文档读取期间已变化。');
      position += part.bytesRead;
    }
    const after = await handle.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw new FileAccessError('FILE_CHANGED', '文档读取期间已变化。');
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  const parsed = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { buffer, format }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const finish = (error, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new FileAccessError('DOCUMENT_TIMEOUT', '文档解析超过 30 秒，请拆分文档。')), 30000);
    const abort = () => finish(new FileAccessError('CANCELLED', '文档解析已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (value) => value.error ? finish(new FileAccessError('DOCUMENT_PARSE_ERROR', value.error)) : finish(null, value));
    worker.once('error', (error) => finish(new FileAccessError('DOCUMENT_PARSE_ERROR', error.message)));
    worker.once('exit', (code) => { if (code) finish(new FileAccessError('DOCUMENT_PARSE_ERROR', '文档解析进程已退出。')); });
    if (signal?.aborted) abort();
  });
  if (args.offset > parsed.text.length) throw new FileAccessError('INVALID_OFFSET', 'offset 超过提取正文长度。');
  let end = Math.min(args.offset + args.length, parsed.text.length);
  if (end < parsed.text.length && /[\uD800-\uDBFF]/.test(parsed.text[end - 1])) end--;
  return { path: filename, format: format.slice(1), modified_at: info.mtime.toISOString(),
    content: parsed.text.slice(args.offset, end), offset: args.offset, next_offset: end < parsed.text.length ? end : null,
    extracted_characters: parsed.text.length, extraction_truncated: parsed.truncated, warnings: parsed.warnings };
}

async function extract(buffer, format) {
  let text = '';
  let truncated = false;
  const warnings = [];
  const append = (value) => {
    const remaining = 1000000 - text.length;
    if (value.length > remaining) truncated = true;
    text += value.slice(0, remaining);
  };
  if (['.docx', '.xlsx', '.pptx'].includes(format)) {
    const { unzipSync } = await import('fflate');
    let bytes = 0;
    let entries = 0;
    unzipSync(buffer, { filter(entry) {
      bytes += entry.originalSize;
      if (++entries > 10000 || bytes > 100 * 1024 ** 2) throw new Error('Office 文档展开超过 100 MiB 或 10000 项。');
      return false;
    } });
  }
  if (format === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl = fileURLToPath(new URL('../../standard_fonts/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))).replaceAll('\\', '/');
    const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, standardFontDataUrl });
    const pdf = await task.promise;
    try {
      for (let number = 1; number <= Math.min(pdf.numPages, 200) && !truncated; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        append(`\n--- Page ${number} ---\n` + content.items.map((item) => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''));
        page.cleanup();
      }
      if (pdf.numPages > 200) truncated = true;
      warnings.push('提取文字层，扫描页和图片内容需要 OCR，版式可能变化。');
    } finally { await task.destroy(); }
  } else if (format === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) }, { externalFileAccess: false });
    append(result.value);
    warnings.push(...result.messages.slice(0, 20).map((item) => item.message));
    warnings.push('提取正文，图片、复杂版式及页眉页脚可能不完整。');
  } else if (format === '.xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    for (const sheet of workbook.worksheets) {
      append(`\n--- Sheet: ${sheet.name} ---\n`);
      sheet.eachRow((row, number) => {
        if (truncated) return;
        if (number > 100000 || row.cellCount > 1000) { truncated = true; return; }
        const cells = [];
        for (let index = 1; index <= row.cellCount; index++) cells.push(row.getCell(index).text.replaceAll('\t', ' ').replaceAll('\n', ' '));
        append(`${number}\t${cells.join('\t')}\n`);
      });
    }
    warnings.push('公式使用文件中的缓存值，解析时不重新计算，也不运行宏。');
  } else if (format === '.pptx') {
    const { unzipSync, strFromU8 } = await import('fflate');
    const { XMLParser } = await import('fast-xml-parser');
    const entries = unzipSync(buffer, { filter: (entry) => /^(ppt\/slides\/slide\d+\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels)$/.test(entry.name) });
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false });
    const parse = (name) => {
      const xml = strFromU8(entries[name] || new Uint8Array());
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持文档中的 DTD 或实体声明。');
      return parser.parse(xml);
    };
    const relations = parse('ppt/_rels/presentation.xml.rels').Relationships?.Relationship || [];
    const map = new Map([relations].flat().map((item) => [item['@_Id'], path.posix.normalize('ppt/' + item['@_Target'])]));
    const ids = parse('ppt/presentation.xml')['p:presentation']?.['p:sldIdLst']?.['p:sldId'] || [];
    let slides = [ids].flat().map((item) => map.get(item['@_r:id'])).filter((name) => entries[name]);
    if (!slides.length) slides = Object.keys(entries).filter((name) => /^ppt\/slides/.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'a:t') for (const item of [value].flat()) append(String(item) + '\n');
        else for (const item of [value].flat()) collect(item);
      }
    };
    for (let index = 0; index < Math.min(slides.length, 200) && !truncated; index++) { append(`\n--- Slide ${index + 1} ---\n`); collect(parse(slides[index])); }
    if (slides.length > 200) truncated = true;
    warnings.push('提取幻灯片文字，图片与图表需要另外解析。');
  } else append(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  return { text, truncated, warnings };
}

if (!isMainThread) {
  try { parentPort.postMessage(await extract(workerData.buffer, workerData.format)); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}
