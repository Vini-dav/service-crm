/***********************************************************************
 * Сервис — ВЫГРУЗКА СЧЁТА В 1С (CSV)
 * Самодостаточный файл. Меню: .addItem('Выгрузка счёта в 1С', 'makeInvoicePositions')
 *                             .addItem('Настроить столбцы счёта', 'setupInvoiceColumns')
 *
 * makeInvoicePositions:
 *   Берёт строки «Реестра» с галочкой «В счёт» (ещё не выставленные),
 *   пишет CSV в папку «Выгрузка 1С», отдаёт ссылку,
 *   ставит метку «№n от дата» и снимает галочки.
 *
 * CSV — ровно 4 колонки, со строкой заголовка:
 *   Наименование  — всегда «Ремонт системного блока» (без кавычек)
 *   Количество    — 1
 *   Цена          — 1500
 *   Содержание    — «...Office <серийник> (замена ...)» либо «(переборка системного блока)»
 * Формат: разделитель «;», UTF-8 с BOM, CRLF; все поля без кавычек (в «Содержании» «;» и переносы -> пробел).
 *
 * Столбцы «Реестра»: R(18) «В счёт» (галочка), S(19) «Счёт» (метка).
 * Разово: setupInvoiceColumns(); в onEdit — reg.getRange(row,18).insertCheckboxes();
 ***********************************************************************/

var INV_CONTRAGENT    = 'ООО «Контрагент»';
var INV_BASE          = 'Ремонт системного блока';
var INV_DEFAULT_PRICE = 1500;
var INV_FOLDER        = 'Выгрузка 1С';
var INV_COL_IN        = 18;   // R — «В счёт»
var INV_COL_MARK      = 19;   // S — «Счёт»
var INV_COL_SN        = 2;    // B — серийный номер
var INV_COL_REPLACE   = 6;    // F — «Неисправно (под замену/ремонт)»

/** Разовая подготовка столбцов «В счёт» и «Счёт». */
function setupInvoiceColumns() {
  var ss  = SpreadsheetApp.getActive();
  var reg = ss.getSheetByName('Реестр');
  if (!reg) { SpreadsheetApp.getUi().alert('Не найден лист «Реестр».'); return; }

  reg.getRange(1, INV_COL_IN).setValue('В счёт').setFontWeight('bold');
  reg.getRange(1, INV_COL_MARK).setValue('Счёт').setFontWeight('bold');

  var lastRow = reg.getLastRow();
  if (lastRow >= 2) {
    reg.getRange(2, INV_COL_IN, lastRow - 1, 1).insertCheckboxes(); // только по данным
  }
  reg.setColumnWidth(INV_COL_IN, 60);
  reg.setColumnWidth(INV_COL_MARK, 150);
  ss.toast('Столбцы «В счёт» и «Счёт» готовы.', 'Настройка', 5);
}

/** Выгрузка счёта в 1С: CSV из отмеченных строк + маркировка. */
function makeInvoicePositions() {
  var ss  = SpreadsheetApp.getActive();
  var ui  = SpreadsheetApp.getUi();
  var reg = ss.getSheetByName('Реестр');
  if (!reg) { ui.alert('Не найден лист «Реестр».'); return; }

  var lastRow = reg.getLastRow();
  if (lastRow < 2) { ui.alert('В «Реестре» нет данных.'); return; }
  if (reg.getLastColumn() < INV_COL_MARK) {
    ui.alert('Сначала выполните «Настроить столбцы счёта».');
    return;
  }

  var data    = reg.getRange(2, 1, lastRow - 1, INV_COL_MARK).getValues();
  var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy');

  // Номер счёта = максимальный из проставленных в «Счёт» + 1
  var maxN = 0;
  for (var i = 0; i < data.length; i++) {
    var mm = String(data[i][INV_COL_MARK - 1]).match(/№\s*(\d+)/);
    if (mm) { var n = parseInt(mm[1], 10); if (n > maxN) maxN = n; }
  }
  var invNo = maxN + 1;

  // Отбор: галочка «В счёт», серийник есть, «Счёт» пуст
  var picked = [];   // {rowAbs, soderjanie}
  var skipped = 0;
  for (var r = 0; r < data.length; r++) {
    if (data[r][INV_COL_IN - 1] !== true) continue;
    var sn = String(data[r][INV_COL_SN - 1]).trim();
    if (sn === '') continue;
    if (String(data[r][INV_COL_MARK - 1]).trim() !== '') { skipped++; continue; }

    var items = invSplit(data[r][INV_COL_REPLACE - 1]);
    var soderjanie = INV_BASE + ' ' + sn +
      (items.length ? ' (замена ' + items.join(', ') + ')' : ' (переборка системного блока)');
    picked.push({ rowAbs: r + 2, soderjanie: soderjanie });
  }

  if (picked.length === 0) {
    ui.alert('Не выбрано ни одной новой позиции.\nПоставьте галочки «В счёт».' +
             (skipped ? '\n(' + skipped + ' отмеченных уже выставлены — пропущены.)' : ''));
    return;
  }

  // --- Сборка CSV (со строкой заголовка; все поля без кавычек) ---
  var lines = [];
  lines.push(['Наименование', 'Количество', 'Цена', 'Содержание'].join(';'));
  for (var p = 0; p < picked.length; p++) {
    lines.push([
      INV_BASE,
      1,                               // Количество
      INV_DEFAULT_PRICE,               // Цена
      csvRaw_(picked[p].soderjanie)    // ; и переносы -> пробел
    ].join(';'));
  }
  var csv = '\uFEFF' + lines.join('\r\n');   // \uFEFF — BOM для корректной кириллицы

  // --- Сохранение файла ---
  var folder   = invFolder(INV_FOLDER);
  var fileName = 'Счёт №' + invNo + ' ООО «Контрагент» ' + dateStr + '.csv';
  var file     = folder.createFile(fileName, csv, 'text/csv');

  // --- Маркировка: № и снятие галочек ---
  for (var q = 0; q < picked.length; q++) {
    reg.getRange(picked[q].rowAbs, INV_COL_MARK).setValue('№' + invNo + ' от ' + dateStr);
    reg.getRange(picked[q].rowAbs, INV_COL_IN).setValue(false);
  }

  ui.alert('Выгрузка счёта №' + invNo + ' готова: ' + picked.length + ' поз.' +
           (skipped ? ' (' + skipped + ' уже были выставлены)' : '') +
           '\n\nCSV-файл (контрагент — ' + INV_CONTRAGENT + '):\n' + file.getUrl());
}

/* ---------- helpers (свои, файл самодостаточный) ---------- */

// Поле без кавычек: убираем то, что сломало бы «;»-разбор (точку с запятой и переносы).
function csvRaw_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[\r\n;]+/g, ' ').trim();
}

function invFolder(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function invSplit(cell) {
  if (cell === null || cell === undefined) return [];
  return String(cell).split(/[\n,;]+/)
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; });
}