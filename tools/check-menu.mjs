#!/usr/bin/env node
// Проверка целей меню и клиентских вызовов.
//
// Зачем. Apps Script связывает пункт меню с функцией ПО СТРОКЕ:
//   .addItem('Сформировать акты забора', 'makeIntakeActs')
// То же самое в HTML-формах: google.script.run.saveUnit(...).
// Для линтера это просто текст, поэтому опечатка в имени не ловится ничем —
// пункт меню молча перестаёт работать, и выясняется это в момент, когда он
// понадобился. Здесь мы сверяем каждую такую строку с объявленными функциями.
//
// Запуск: node tools/check-menu.mjs
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { topLevelNames } from './gas-globals.mjs';

const SRC = 'src';
const ADD_ITEM = /\.addItem\(\s*(['"`])(.*?)\1\s*,\s*(['"`])([\w$]+)\3/g;
const RUN_ENTRY = /google\.script\.run/g;

// Разбирает цепочку google.script.run: обработчики withSuccessHandler /
// withFailureHandler / withUserObject пропускаем вместе с их аргументами
// (внутри них — колбэки со своими скобками и переводами строк), а первое
// «обычное» звено и есть вызываемая серверная функция.
function serverCall(text, from) {
  let i = from;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '.') return null;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    let name = '';
    while (i < text.length && /[\w$]/.test(text[i])) name += text[i++];
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '(') return null;

    if (!/^with[A-Z]/.test(name)) return { name, index: i };

    // Проматываем аргумент обработчика по балансу скобок.
    let depth = 0;
    let quote = null;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
    }
  }
  return null;
}

function collect(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collect(path, exts));
    else if (exts.includes(extname(name))) out.push(path);
  }
  return out;
}

const code = collect(SRC, ['.js', '.gs']);
const pages = collect(SRC, ['.html']);

// Все функции проекта: Apps Script держит их в общей области видимости.
const declared = new Set();
for (const file of code) for (const name of topLevelNames(readFileSync(file, 'utf8'))) declared.add(name);

const findings = [];

for (const file of code) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(ADD_ITEM)) {
    if (declared.has(m[4])) continue;
    const line = text.slice(0, m.index).split('\n').length;
    findings.push({ file, line, what: `пункт меню «${m[2]}» → ${m[4]}()` });
  }
}

for (const file of pages) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(RUN_ENTRY)) {
    const call = serverCall(text, m.index + m[0].length);
    if (!call || declared.has(call.name)) continue;
    const line = text.slice(0, call.index).split('\n').length;
    findings.push({ file, line, what: `google.script.run.${call.name}()` });
  }
}

if (findings.length === 0) {
  console.log(`✓ цели меню и google.script.run: все функции на месте (файлов: ${code.length + pages.length})`);
  process.exit(0);
}

console.error('✗ вызовы по имени, для которых нет функции:\n');
for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.what}`);
console.error('\nИмя функции здесь — обычная строка, линтер её не проверяет.\nСверь написание с объявлением функции в src/.');
process.exit(1);
