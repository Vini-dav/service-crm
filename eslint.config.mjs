// Конфиг ESLint (flat config, ESLint 9+).
//
// Зачем он в проекте Apps Script: код исполняется на серверах Google, локально
// его не запустить. Единственный дешёвый способ поймать опечатку до заливки в
// таблицу — статический анализ. Главное правило здесь — no-undef: оно ловит
// обращение к несуществующему имени, то есть ровно ту ошибку, которая в Apps
// Script вылезает только в момент запуска.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { APPS_SCRIPT_SERVICES, topLevelNames } from './tools/gas-globals.mjs';

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collect(path));
    else if (['.js', '.gs'].includes(extname(name))) out.push(path);
  }
  return out;
}

const sources = collect('src');

// Имена верхнего уровня по файлам: { 'src/Акты.js': ['makeIntakeActs', ...], ... }
const declared = new Map(
  sources.map((file) => [file, topLevelNames(readFileSync(file, 'utf8'))])
);

// Apps Script исполняет все файлы проекта в ОДНОЙ области видимости: функция из
// «Акты.js» видна в «бутстрап.js». ESLint же разбирает файлы поодиночке и на
// такой вызов ругается no-undef.
//
// Поэтому на каждый файл собираем отдельный конфиг, где глобальными объявлены
// имена из ОСТАЛЬНЫХ файлов, но не из него самого. Если подать файлу его
// собственные имена, ESLint увидит объявление поверх глобала и выдаст
// no-redeclare — ошибку на ровном месте. Такой раскладкой обе проверки остаются
// в силе: no-undef ловит настоящие опечатки, no-redeclare — настоящие дубли.
const perFile = sources.map((file) => {
  const foreign = {};
  for (const [other, names] of declared) {
    if (other === file) continue;
    for (const name of names) foreign[name] = 'readonly';
  }
  return {
    // ESLint ждёт пути с прямыми слэшами независимо от платформы.
    files: [file.split(sep).join('/')],
    languageOptions: { globals: foreign },
  };
});

export default [
  {
    files: ['src/**/*.js', 'src/**/*.gs'],
    languageOptions: {
      ecmaVersion: 2022,
      // Apps Script исполняет файлы как обычные скрипты в общей области видимости,
      // а не как ES-модули: import/export там не работают.
      sourceType: 'script',
      globals: { ...APPS_SCRIPT_SERVICES },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // Опечатка в имени функции или переменной — самая дорогая ошибка здесь.
      'no-undef': 'error',
      // vars: 'local' — верхний уровень не проверяем: в Apps Script функции
      // верхнего уровня и есть публичный интерфейс проекта. Их вызывают из меню,
      // из HTML через google.script.run и из триггеров — по коду этих вызовов не
      // видно, так что «нигде не используется» там означало бы ложную тревогу.
      'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-sparse-arrays': 'error',
      'no-self-compare': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      eqeqeq: ['warn', 'smart'],
    },
  },
  ...perFile,
];
