#!/usr/bin/env node
// Снимки кода Apps Script и безопасное скачивание.
//
//   node tools/sync.mjs backup  — снять снимок удалённого кода в backups/
//   node tools/sync.mjs pull    — снять снимок и обновить src/ из веб-редактора
//
// Зачем снимок при pull. Веб-редактор и репозиторий — два источника правды,
// которые расходятся, стоит кому-то поправить код в браузере. `clasp pull`
// затирает src/ содержимым редактора, и незакоммиченная локальная работа
// исчезает. Снимок перед скачиванием делает эту операцию обратимой.
//
// Почему через временный каталог. В clasp 3.x pull применяет rootDir дважды и
// раскладывает файлы в src/src/, хотя push при этом работает правильно.
// Поэтому качаем во временный каталог с rootDir "." и раскладываем файлы сами.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const CODE_EXT = ['.js', '.gs', '.html', '.json'];
const CLASP = join('node_modules', '.bin', 'clasp');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

/** Скачивает проект во временный каталог и возвращает путь к нему. */
function fetchRemote() {
  const { scriptId } = JSON.parse(readFileSync('.clasp.json', 'utf8'));
  if (!scriptId || scriptId.startsWith('ЗАПОЛНИ')) {
    console.error('✗ в .clasp.json не заполнен scriptId — смотри README, раздел «Разовая настройка».');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'kinetika-'));
  writeFileSync(join(dir, '.clasp.json'), JSON.stringify({ scriptId, rootDir: '.' }, null, 2));
  execFileSync(join(process.cwd(), CLASP), ['pull'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function codeFiles(dir) {
  // Точечные файлы (.clasp.json и прочая служебка) — не код проекта.
  return readdirSync(dir).filter(
    (f) => !f.startsWith('.') && CODE_EXT.includes(extname(f)) && statSync(join(dir, f)).isFile()
  );
}

function snapshot(from, reason) {
  const dir = join('backups', `apps-script_${stamp()}`);
  mkdirSync(dir, { recursive: true });
  const files = codeFiles(from);
  for (const f of files) copyFileSync(join(from, f), join(dir, f));
  writeFileSync(
    join(dir, 'СНИМОК.txt'),
    [
      'Снимок кода Apps Script проекта «Сервис».',
      `Снят: ${new Date().toLocaleString('ru-RU')}`,
      `Повод: ${reason}`,
      `Файлов: ${files.length}`,
      '',
      'Это состояние ВЕБ-РЕДАКТОРА на момент снимка.',
      'Восстановление: скопировать файлы в src/ и выполнить npm run push',
      '',
      'Данные таблицы сюда НЕ попадают — их копии делает сам скрипт,',
      'в папку «Бэкапы сервиса» рядом с таблицей на Google Диске.',
    ].join('\n')
  );
  return { dir, files };
}

const command = process.argv[2];

if (command === 'backup') {
  const remote = fetchRemote();
  const { dir, files } = snapshot(remote, 'ручной снимок');
  rmSync(remote, { recursive: true, force: true });
  console.log(`✓ снимок: ${dir} (файлов: ${files.length})`);
} else if (command === 'pull') {
  const remote = fetchRemote();
  const { dir } = snapshot(remote, 'перед pull');

  const before = new Set(codeFiles('src'));
  const after = codeFiles(remote);
  mkdirSync('src', { recursive: true });
  for (const f of after) copyFileSync(join(remote, f), join('src', f));
  // Файл, удалённый в веб-редакторе, должен исчезнуть и локально — иначе push
  // вернёт его обратно.
  for (const f of before) if (!after.includes(f)) rmSync(join('src', f));
  rmSync(remote, { recursive: true, force: true });

  const added = after.filter((f) => !before.has(f));
  const removed = [...before].filter((f) => !after.includes(f));
  console.log(`✓ src/ обновлён из веб-редактора (файлов: ${after.length})`);
  if (added.length) console.log(`  добавлены: ${added.join(', ')}`);
  if (removed.length) console.log(`  удалены:   ${removed.join(', ')}`);
  console.log(`  снимок до обновления: ${dir}`);
  console.log('\nДальше: git diff — посмотреть, что менялось в редакторе мимо репозитория.');
} else {
  console.error('Использование: node tools/sync.mjs backup | pull');
  process.exit(1);
}
