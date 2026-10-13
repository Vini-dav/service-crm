/***********************************************************************
 * Сервис — резервные копии таблицы.
 *
 * Зачем. Код проекта лежит в git и восстанавливается одной командой, а данные
 * таблицы — нет: их единственная копия и есть сама таблица. При этом reset()
 * удаляет «Реестр», «Справочники» и «Настройки» вместе со всеми заявками.
 * Поэтому копия снимается автоматически перед каждой пересборкой — и вручную
 * из меню, когда затевается что-то рискованное.
 *
 * Куда. В подпапку «Бэкапы сервиса» РЯДОМ С ТАБЛИЦЕЙ — в той же папке Google
 * Диска, где лежит она сама. Копия под рукой и не теряется среди прочих файлов.
 *
 * Сколько. Храним последние BACKUP_KEEP копий, что старше — в корзину: иначе
 * папка за год заполнится сотнями снимков.
 ***********************************************************************/

const BACKUP_FOLDER = 'Бэкапы сервиса';
const BACKUP_KEEP   = 20;

/** Пункт меню: снять копию вручную. */
function backupBook() {
  const copy = backupBook_('вручную');
  ui_('Копия сохранена:\n\n' + copy.getName() + '\n\nПапка «' + BACKUP_FOLDER + '» рядом с таблицей.');
}

/**
 * Снимает копию таблицы и возвращает файл копии.
 * reason попадает в имя файла — чтобы потом было видно, что происходило:
 * «вручную» или «перед reset».
 */
function backupBook_(reason) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const folder = backupFolder_();
  const stamp  = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH-mm');
  const copy   = DriveApp.getFileById(ss.getId())
    .makeCopy(ss.getName() + ' — ' + stamp + ' (' + reason + ')', folder);
  pruneBackups_(folder, ss.getName());
  return copy;
}

/** Папка «Бэкапы сервиса» в родительской папке таблицы. */
function backupFolder_() {
  const file    = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const parents = file.getParents();
  // У файла на «Моём диске» без папки родителя нет — тогда кладём в корень.
  const base    = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const found   = base.getFoldersByName(BACKUP_FOLDER);
  return found.hasNext() ? found.next() : base.createFolder(BACKUP_FOLDER);
}

/**
 * Оставляем последние BACKUP_KEEP копий, остальные — в корзину.
 * Трогаем только файлы, начинающиеся с имени таблицы: если в папку положили
 * что-то своё, оно должно там и остаться.
 */
function pruneBackups_(folder, bookName) {
  const ours = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf(bookName) === 0) ours.push(f);
  }
  if (ours.length <= BACKUP_KEEP) return;

  ours.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  ours.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
}
