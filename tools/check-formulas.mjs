#!/usr/bin/env node
// Проверка формул на локаль таблицы.
//
// Зачем. Таблица живёт в русской локали (ru_RU), где разделитель аргументов —
// точка с запятой: =ЕСЛИ(A1>0; 1; 0). Google НЕ конвертирует разделители при
// записи через Apps Script: формула с запятыми ложится в ячейку как есть и даёт
// «#ERROR! синтаксическая ошибка в формуле». Ошибка не видна в коде и не ловится
// ни синтаксисом, ни линтером — только глазами в таблице после деплоя.
//
// Что проверяем. Все строковые литералы в коде, а не только аргументы
// setFormula: формулы часто собираются по кусочкам в функции-строителе
// (buildStatusFormula_ в «бутстрап.js» — ровно такой случай), и проверка,
// смотрящая лишь на место записи в ячейку, прошла бы мимо.
//
// Подозрительным считается литерал, который либо начинается с «=», либо
// содержит вызов функции таблицы (ИМЯ_ЗАГЛАВНЫМИ«(»), и при этом имеет запятую
// на уровне аргументов — вне кавычек формулы "…" и вне имён листов '…'.
//
// Две легальные ситуации не считаются ошибкой:
//   1) строка обёрнута в хелпер-переводчик: setFormula(loc('=IF(A1>0,1,0)'))
//   2) в строке кода стоит маркер // locale-ok — осознанное исключение
//
// Запуск: node tools/check-formulas.mjs
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const SRC = 'src';
const WRAPPERS = /\bloc(All)?\s*\(/; // хелперы, которые сами переводят формулу
const ESCAPE_MARKER = 'locale-ok';
// Вызов функции таблицы: IF( , ARRAYFORMULA( , СУММЕСЛИМН( …
// Только заглавные и вплотную к скобке — иначе проза вида «ИП Иванов И.И. (СЦ)»
// принимается за формулу.
const SHEET_FUNC = /(^|[^A-Za-zА-Яа-яЁё0-9_.])[A-ZА-ЯЁ]{2,}\(/;

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collect(path));
    else if (['.js', '.gs'].includes(extname(name))) out.push(path);
  }
  return out;
}

// Строковые литералы файла вместе с номером строки и номером инструкции.
// Комментарии пропускаем: пример формулы в комментарии — не код.
//
// Номер инструкции нужен, потому что формулы часто собираются конкатенацией:
//   expr = 'IF(' + cond + ',"да",' + expr + ')'
// Поодиночке ни один кусок не выглядит подозрительным — запятая в одном
// литерале, имя функции в другом. Поэтому куски одной инструкции склеиваются
// и проверяются вместе.
function stringLiterals(code) {
  const out = [];
  let quote = null;
  let buf = '';
  let startLine = 1;
  let line = 1;
  let comment = null; // 'line' | 'block'
  let statement = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n') line++;

    if (comment) {
      if (comment === 'line' && ch === '\n') comment = null;
      else if (comment === 'block' && ch === '*' && code[i + 1] === '/') { comment = null; i++; }
      continue;
    }

    if (quote) {
      if (ch === '\\') { buf += code[i + 1]; i++; }
      else if (ch === quote) { out.push({ text: buf, line: startLine, statement }); buf = ''; quote = null; }
      else buf += ch;
      continue;
    }

    if (ch === '/' && code[i + 1] === '/') { comment = 'line'; i++; }
    else if (ch === '/' && code[i + 1] === '*') { comment = 'block'; i++; }
    else if (ch === '"' || ch === "'" || ch === '`') { quote = ch; startLine = line; }
    // Границы инструкции: дальше этих символов конкатенация не тянется.
    else if (ch === ';' || ch === '{' || ch === '}') statement++;
  }
  return out;
}

// Запятая на уровне аргументов формулы: не внутри "текста" и не в 'Имени листа'.
function hasArgumentComma(formula) {
  let quote = null;
  for (const ch of formula) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') return true;
  }
  return false;
}

const files = collect(SRC);
const findings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // Склеиваем литералы одной инструкции. Вместо кусков-невидимок (переменных,
  // вызовов) ставим \u0001 — символ-заполнитель, который не спутать ни с
  // запятой, ни с кавычкой.
  const byStatement = new Map();
  for (const lit of stringLiterals(text)) {
    if (!byStatement.has(lit.statement)) byStatement.set(lit.statement, { parts: [], line: lit.line });
    byStatement.get(lit.statement).parts.push(lit.text);
  }

  for (const { parts, line } of byStatement.values()) {
    const joined = parts.join('\u0001');
    const looksLikeFormula = joined.trimStart().startsWith('=') || SHEET_FUNC.test(joined);
    if (!looksLikeFormula || !hasArgumentComma(joined)) continue;

    const lineText = lines[line - 1] ?? '';
    if (lineText.includes(ESCAPE_MARKER) || WRAPPERS.test(lineText)) continue;

    findings.push({ file, line, literal: joined.replace(/\u0001/g, '…').slice(0, 90) });
  }
}

if (findings.length === 0) {
  console.log(`✓ формулы под локаль: проблем нет (файлов проверено: ${files.length})`);
  process.exit(0);
}

console.error('✗ формулы с запятой в качестве разделителя аргументов:\n');
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.literal}`);
}
console.error(
  '\nВ локали ru_RU разделитель аргументов — «;». Варианты: заменить запятые на «;»,' +
  '\nпровести формулу через хелпер-переводчик loc(), либо пометить строку // locale-ok,' +
  '\nесли запятая там законна.'
);
process.exit(1);
