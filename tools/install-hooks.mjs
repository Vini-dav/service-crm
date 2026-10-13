#!/usr/bin/env node
// Подключает git-хуки из .githooks/.
//
// Хуки git по умолчанию лежат в .git/hooks — каталоге, который НЕ попадает в
// репозиторий. Поэтому такой хук теряется при клонировании: он есть у того,
// кто его завёл, и больше ни у кого. Настройка core.hooksPath переносит каталог
// хуков внутрь репозитория, где он версионируется наравне с кодом.
//
// Запускается автоматически из npm-скрипта prepare, то есть после npm ci
// и npm install. На раннере CI не нужен и пропускается.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.CI) process.exit(0);          // на раннере хуки ни к чему
if (!existsSync('.git')) process.exit(0);     // не git-репозиторий — нечего настраивать

try {
  const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (current === '.githooks') process.exit(0);
} catch {
  // Настройки ещё нет — git выходит с ненулевым кодом. Это нормально.
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
console.log('✓ git-хуки подключены: .githooks (pre-push прогоняет npm run check)');
