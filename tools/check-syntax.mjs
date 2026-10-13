#!/usr/bin/env node
// Проверка синтаксиса файлов Apps Script.
//
// Самый дешёвый барьер в пайплайне: `node --check` разбирает файл парсером V8 —
// тем же движком, на котором Apps Script исполняет код (runtimeVersion: V8).
// Незакрытая скобка или лишняя запятая ловятся здесь, а не в таблице, где
// синтаксическая ошибка молча выключает ВЕСЬ проект: перестаёт работать даже
// меню, потому что не компилируется onOpen.
//
// Запуск: node tools/check-syntax.mjs
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = 'src';

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collect(path));
    else if (['.js', '.gs', '.html'].includes(extname(name))) out.push(path);
  }
  return out;
}

const files = collect(SRC);
if (files.length === 0) {
  console.error(`✗ в ${SRC}/ нет файлов кода — нечего проверять`);
  process.exit(1);
}

// В .html кода не меньше, чем в .js: форма инженера — это страница со
// встроенным скриптом. Ошибка в нём выключает форму целиком, поэтому
// вырезаем содержимое <script> и проверяем его тем же парсером.
// Строки до скрипта заменяем переносами, чтобы номер строки в сообщении
// об ошибке совпадал с номером в исходном файле.
function inlineScripts(file) {
  const html = readFileSync(file, 'utf8');
  const out = [];
  const TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const m of html.matchAll(TAG)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;          // внешний файл — не наш код
    const before = html.slice(0, m.index + m[0].indexOf(m[2]));
    const padding = '\n'.repeat((before.match(/\n/g) || []).length);
    out.push(padding + m[2]);
  }
  return out;
}

let failed = 0;
for (const file of files) {
  const isHtml = extname(file) === '.html';
  const pieces = isHtml ? inlineScripts(file) : [null];

  if (isHtml && pieces.length === 0) {
    console.log(`· ${file} — встроенных скриптов нет`);
    continue;
  }

  let fileOk = true;
  for (const code of pieces) {
    try {
      // `node --check` только парсит, не исполняет: побочных эффектов нет.
      if (code === null) {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } else {
        execFileSync(process.execPath, ['--check', '-'], { input: code, stdio: 'pipe' });
      }
    } catch (err) {
      fileOk = false;
      console.error(`✗ ${file}`);
      console.error(String(err.stderr || err.message).trim());
    }
  }

  if (fileOk) console.log(`✓ ${file}`);
  else failed++;
}

console.log(`\nПроверено файлов: ${files.length}, с ошибками: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
