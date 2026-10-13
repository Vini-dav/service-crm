/**
 * СЦ Пример — формирование актов ЗАБОРА и ВЫДАЧИ (v6).
 * Исправлено: убраны пустые ячейки и пустые абзацы (DocumentApp их не принимает).
 * Отдельный файл; добавляется в проект рядом с бутстрапом.
 * Запуск: меню «Сервис» → «Сформировать акты забора».
 */

function makeIntakeActs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_REESTR);
  const last = sh.getLastRow();
  if (last < 2) { ui_('В «Реестре» нет данных.'); return; }

  const vals = sh.getRange(2, 1, last - 1, COL.PDF_OUT).getValues();

  const groups = {};
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    const sn       = r[COL.SN - 1];
    const respBank = r[COL.RESP_IN - 1];
    const respUs   = r[COL.RESP_US - 1];
    const actIn    = r[COL.ACT_IN - 1];
    const diagRepl = r[COL.DIAG_REPLACE - 1];
    const diagOk   = r[COL.DIAG_OK - 1];
    const ready    = r[COL.READY - 1];
    const actOut   = r[COL.ACT_OUT - 1];
    // Только «Принят»: принято, но ещё не продиагностировано / не готово / не выдано / без акта забора.
    if (!sn || !respBank || actIn) continue;
    if (diagRepl || diagOk || ready === true || actOut) continue;
    const key = respBank + ' || ' + respUs;
    if (!groups[key]) groups[key] = { respBank: respBank, respUs: respUs, rows: [] };
    groups[key].rows.push({ rowIndex: i + 2, sn: sn, problem: r[COL.PROBLEM - 1] });
  }

  const keys = Object.keys(groups);
  if (!keys.length) {
    ui_('Нет строк для акта забора.\nБерутся только со статусом «Принят» (продиагностированные и далее — не включаются).');
    return;
  }

  const folder  = getPdfFolder_();
  const suffix  = getSetting_('Суффикс номера акта') || '/сб';
  let   counter = Number(getSetting_('Последний номер акта')) || 0;
  const today   = new Date();
  let   made    = 0;

  keys.forEach(function (k) {
    const g = groups[k];
    counter++;
    const actNo = counter + suffix;
    const url = buildIntakeActPdf_(folder, actNo, today, g.respBank, g.respUs, g.rows);
    g.rows.forEach(function (row) {
      sh.getRange(row.rowIndex, COL.ACT_IN).setValue(actNo);
      setLinkCell_(sh, row.rowIndex, COL.PDF_IN, 'Акт забора №' + actNo, url);
    });
    made++;
  });

  setSetting_('Последний номер акта', counter);
  ui_('Готово. Сформировано актов забора: ' + made + '.\nPDF — в папке «Акты сервиса» на Google Drive.');
}

/* ─────────────────────  Сборка PDF одного акта  ──────────────────────── */
function buildIntakeActPdf_(folder, actNo, dateObj, respBank, respUs, rows) {
  const FONT = 'Times New Roman';
  const doc  = DocumentApp.create('Акт забора ' + actNo.replace('/', '-'));
  const body = doc.getBody();
  body.setMarginLeft(56).setMarginRight(42).setMarginTop(42).setMarginBottom(42);

  // Заголовок — в уже существующий первый абзац (без пустой строки сверху).
  const title = body.getChild(0).asParagraph();
  title.setText('АКТ приёма-передачи ТМЦ');
  title.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  title.editAsText().setFontFamily(FONT).setFontSize(13).setBold(true);

  const sub = body.appendParagraph('№ ' + actNo + ' от ' + formatActDate_(dateObj));
  sub.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingAfter(12);
  sub.editAsText().setFontFamily(FONT).setFontSize(12).setBold(false);

  appendBody_(body, FONT,
    'ООО «ЗАКАЗЧИК», в лице ' + respBank + ' с одной стороны, и ИП Иванов И.И. (СЦ Пример), в лице ' +
    respUs + ' с другой стороны (далее Стороны), составили настоящий Акт о нижеследующем:');
  appendBody_(body, FONT,
    'Для проведения гарантийного ремонта ' + respBank + ' передала, а ' + respUs + ' принял:');

  // Таблица позиций (пустых ячеек быть не должно — вместо пусто ставим пробел).
  const data = [['№ п/п', 'Серийный №', 'Проблема (со слов заказчика)']];
  rows.forEach(function (r, i) { data.push([String(i + 1), r.sn, r.problem ? r.problem : ' ']); });
  data.push(['Итого:', String(rows.length), ' ']);
  const table = body.appendTable(data);
  styleActTable_(table, FONT);

  const note = appendBody_(body, FONT,
    'Настоящий Акт составлен в двух экземплярах, имеющих равную юридическую силу, ' +
    'по одному экземпляру для каждой из Сторон.', false);
  note.setSpacingBefore(12).setSpacingAfter(18);

  // Подписи — таблица 2×1 без границ.
  const sig = body.appendTable([[
    'ПЕРЕДАЛ\n«___»_____________2026 г.\nООО «Заказчик»\n\n___________ ' + respBank,
    'ПРИНЯЛ\n«___»_____________2026 г.\nИП Иванов И.И. (СЦ Пример)\n\n___________ ' + respUs
  ]]);
  sig.setBorderWidth(0);
  for (let c = 0; c < 2; c++) {
    const cell = sig.getCell(0, c);
    cell.editAsText().setFontFamily(FONT).setFontSize(12).setBold(false);
    boldFirstWord_(cell);
  }

  appendCornerTag_(body, FONT, 'забор');

  doc.saveAndClose();
  const id  = doc.getId();
  const pdf = DriveApp.getFileById(id).getAs('application/pdf')
                .setName('Акт_забора_' + actNo.replace('/', '-') + '.pdf');
  const file = folder.createFile(pdf);
  DriveApp.getFileById(id).setTrashed(true);
  return file.getUrl();
}

/* ─────────────────────────  Вспомогательные  ────────────────────────── */
function appendBody_(body, font, text, indent) {
  const p = body.appendParagraph(text);
  p.setAlignment(DocumentApp.HorizontalAlignment.JUSTIFY).setSpacingAfter(8);
  p.editAsText().setFontFamily(font).setFontSize(12).setBold(false);
  if (indent !== false) p.setIndentFirstLine(28);
  return p;
}

function styleActTable_(table, font) {
  const nRows = table.getNumRows();
  for (let r = 0; r < nRows; r++) {
    const isHead = (r === 0);
    const isTot  = (r === nRows - 1);
    const nCells = table.getRow(r).getNumCells();
    for (let c = 0; c < nCells; c++) {
      const cell = table.getCell(r, c);
      cell.setPaddingTop(3).setPaddingBottom(3).setPaddingLeft(5).setPaddingRight(5);
      if (isHead) cell.setBackgroundColor('#e8e8e8');
      else if (isTot) cell.setBackgroundColor('#f2f2f2');
      const para = cell.getChild(0).asParagraph();
      para.editAsText().setFontFamily(font).setFontSize(11).setBold(isHead || isTot);
      if (isHead || c === 0) para.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      else para.setAlignment(DocumentApp.HorizontalAlignment.LEFT);
    }
  }
  table.setColumnWidth(0, 50);
  table.setColumnWidth(1, 165);
  table.setColumnWidth(2, 235);
}

function boldFirstWord_(cell) {
  const t = cell.editAsText();
  const s = t.getText();
  const nl = s.indexOf('\n');
  const end = (nl < 0 ? s.length : nl) - 1;
  if (end >= 0) t.setBold(0, end, true);
}

function formatActDate_(d) {
  const m = ['января','февраля','марта','апреля','мая','июня',
             'июля','августа','сентября','октября','ноября','декабря'];
  const dd = ('0' + d.getDate()).slice(-2);
  return '«' + dd + '» ' + m[d.getMonth()] + ' ' + d.getFullYear() + ' г.';
}

function getPdfFolder_() {
  const id = getSetting_('ID папки Google Drive для PDF');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const folder = DriveApp.createFolder('Акты сервиса');
  setSetting_('ID папки Google Drive для PDF', folder.getId());
  return folder;
}

function setSetting_(name, value) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const data = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === name) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
}

/** Пишет в ячейку кликабельное имя-ссылку (текст + URL), без голого пути. */
function setLinkCell_(sh, row, col, text, url) {
  const rich = SpreadsheetApp.newRichTextValue().setText(text).setLinkUrl(url).build();
  sh.getRange(row, col).setRichTextValue(rich);
}

/** Метка типа акта в правом нижнем углу (мелкий серый курсив). */
function appendCornerTag_(body, font, tag) {
  const p = body.appendParagraph(tag);
  p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT).setSpacingBefore(24);
  p.editAsText().setFontFamily(font).setFontSize(9).setItalic(true)
    .setForegroundColor('#999999').setBold(false);
}

/* ════════════════════════════════════════════════════════════════════════
 *  АКТЫ ВЫДАЧИ (возврат починенного заказчику)
 *  Берём строки: галочка «Готов» + назначен «Ответственный заказчика (выдача)»
 *  + пустой «№ акта выдачи». Дата — текущая, ставится и в «Дату выдачи».
 *  Стороны зеркальны забору: передаём мы, принимает заказчик.
 * ════════════════════════════════════════════════════════════════════════ */

function makeHandoverActs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_REESTR);
  const last = sh.getLastRow();
  if (last < 2) { ui_('В «Реестре» нет данных.'); return; }

  const vals = sh.getRange(2, 1, last - 1, COL.PDF_OUT).getValues();

  const groups = {};
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    const sn      = r[COL.SN - 1];
    const respOut = r[COL.RESP_OUT - 1];
    const respUs  = r[COL.RESP_US - 1];
    const ready   = r[COL.READY - 1];
    const actOut  = r[COL.ACT_OUT - 1];
    if (!sn) continue;
    if (ready !== true) continue;   // не «Готов»
    if (!respOut) continue;         // не назначен ответственный за выдачу
    if (actOut) continue;           // уже выдан
    const key = respOut + ' || ' + respUs;
    if (!groups[key]) groups[key] = { respOut: respOut, respUs: respUs, rows: [] };
    groups[key].rows.push({ rowIndex: i + 2, sn: sn, replaced: r[COL.DIAG_REPLACE - 1] });
  }

  const keys = Object.keys(groups);
  if (!keys.length) {
    ui_('Нет строк для акта выдачи.\nНужно: галочка «Готов», назначен «Ответственный заказчика (выдача)» и пустой «№ акта выдачи».');
    return;
  }

  const folder  = getPdfFolder_();
  const suffix  = getSetting_('Суффикс номера акта') || '/сб';
  let   counter = Number(getSetting_('Последний номер акта')) || 0;
  const today   = new Date();
  let   made    = 0;

  keys.forEach(function (k) {
    const g = groups[k];
    counter++;
    const actNo = counter + suffix;
    const url = buildHandoverActPdf_(folder, actNo, today, g.respOut, g.respUs, g.rows);
    g.rows.forEach(function (row) {
      sh.getRange(row.rowIndex, COL.ACT_OUT).setValue(actNo);
      setLinkCell_(sh, row.rowIndex, COL.PDF_OUT, 'Акт выдачи №' + actNo, url);
      sh.getRange(row.rowIndex, COL.DATE_OUT).setValue(today);
    });
    made++;
  });

  setSetting_('Последний номер акта', counter);
  ui_('Готово. Сформировано актов выдачи: ' + made + '.\nPDF — в папке «Акты сервиса» на Google Drive.');
}

function buildHandoverActPdf_(folder, actNo, dateObj, respBank, respUs, rows) {
  const FONT = 'Times New Roman';
  const doc  = DocumentApp.create('Акт выдачи ' + actNo.replace('/', '-'));
  const body = doc.getBody();
  body.setMarginLeft(56).setMarginRight(42).setMarginTop(42).setMarginBottom(42);

  const title = body.getChild(0).asParagraph();
  title.setText('АКТ приёма-передачи ТМЦ');
  title.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  title.editAsText().setFontFamily(FONT).setFontSize(13).setBold(true);

  const sub = body.appendParagraph('№ ' + actNo + ' от ' + formatActDate_(dateObj));
  sub.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingAfter(12);
  sub.editAsText().setFontFamily(FONT).setFontSize(12).setBold(false);

  appendBody_(body, FONT,
    'ООО «ЗАКАЗЧИК», в лице ' + respBank + ' с одной стороны, и ИП Иванов И.И. (СЦ Пример), в лице ' +
    respUs + ' с другой стороны (далее Стороны), составили настоящий Акт о нижеследующем:');
  appendBody_(body, FONT,
    'После проведения гарантийного ремонта ' + respBank + ' приняла, а ' + respUs + ' передал:');

  const data = [['№ п/п', 'Серийный №', 'Заменено']];
  rows.forEach(function (r, i) { data.push([String(i + 1), r.sn, r.replaced ? r.replaced : ' ']); });
  data.push(['Итого:', String(rows.length), ' ']);
  const table = body.appendTable(data);
  styleActTable_(table, FONT);

  const note = appendBody_(body, FONT,
    'Настоящий Акт составлен в двух экземплярах, имеющих равную юридическую силу, ' +
    'по одному экземпляру для каждой из Сторон.', false);
  note.setSpacingBefore(12).setSpacingAfter(18);

  // Подписи зеркальны забору: слева ПРИНЯЛ (заказчик), справа ПЕРЕДАЛ (мы).
  const sig = body.appendTable([[
    'ПРИНЯЛ\n«___»_____________2026 г.\nООО «Заказчик»\n\n___________ ' + respBank,
    'ПЕРЕДАЛ\n«___»_____________2026 г.\nИП Иванов И.И. (СЦ Пример)\n\n___________ ' + respUs
  ]]);
  sig.setBorderWidth(0);
  for (let c = 0; c < 2; c++) {
    const cell = sig.getCell(0, c);
    cell.editAsText().setFontFamily(FONT).setFontSize(12).setBold(false);
    boldFirstWord_(cell);
  }

  appendCornerTag_(body, FONT, 'возврат');

  doc.saveAndClose();
  const id  = doc.getId();
  const pdf = DriveApp.getFileById(id).getAs('application/pdf')
                .setName('Акт_выдачи_' + actNo.replace('/', '-') + '.pdf');
  const file = folder.createFile(pdf);
  DriveApp.getFileById(id).setTrashed(true);
  return file.getUrl();
}

/***********************************************************************
 * Сервис — ЗАЯВКА НА ЗАПЧАСТИ (v1)
 * Вставить в файл «Акты» (НЕ создавать третий файл — засада про дубли).
 *
 * Что делает:
 *   Собирает из «Реестра» железки, которым нужны ЗАКАЗНЫЕ запчасти,
 *   печатает PDF: таблицу (серийник → что требуется + уточнение вручную)
 *   и в конце сводку «сколько каких запчастей заказать всего».
 *
 * РАЗОВАЯ НАСТРОЙКА перед первым запуском:
 *   1) Лист «Справочники», столбец H: напротив строк столбца G, которые
 *      являются ЗАКАЗНЫМИ запчастями (кулер, ссд, озу, бп, мат.плата,
 *      процессор), поставить любую метку — например «да».
 *      Симптомы («не включается», «не загружает ОС») метку НЕ получают.
 *   2) Лист «Реестр», столбец Q (17-й): шапка «Уточнение по запчастям».
 *      Инженер вручную пишет детали, когда нужно (сокет процессора,
 *      объём ССД и т.п.). Заполнять не обязательно — код работает и без Q.
 *      Столбцы U (21) и V (22) — серийники исходного и установленного SSD,
 *      их заводит форма инженера. Исходный пишут при любой проверке диска,
 *      установленный — только когда диск меняли. В документ попадают у КАЖДОЙ
 *      железки: он работает и отчётом о диагностике. Слово «снят» ставится
 *      лишь там, где накопитель значится среди заказных запчастей.
 *   3) В onOpen добавить пункт меню:
 *        .addItem('Заявка на запчасти', 'makePartsRequest')
 ***********************************************************************/

function makePartsRequest() {
  var ss  = SpreadsheetApp.getActive();
  var reg = ss.getSheetByName('Реестр');
  var ref = ss.getSheetByName('Справочники');
  var ui  = SpreadsheetApp.getUi();
  if (!reg || !ref) { ui.alert('Не найден лист «Реестр» или «Справочники».'); return; }

  // Колонки «Реестра» (1-based)
  var SN = 2, DIAG_REPLACE = 6, DIAG_OK = 7, READY = 8, ACT_OUT = 13, PART_NOTE = 17;
  var SSD_OUT = 21, SSD_IN = 22;        // серийники снятого и установленного накопителя

  // --- 1. Множество «заказных запчастей» из «Справочников» (G — имя, H — метка) ---
  var refLast = ref.getLastRow();
  var partsFlag = {};                 // нормализованное имя -> каноничное имя для печати
  if (refLast >= 1) {
    var refVals = ref.getRange(1, 7, refLast, 2).getValues(); // G:H
    for (var i = 0; i < refVals.length; i++) {
      var name = String(refVals[i][0]).trim();
      var flag = String(refVals[i][1]).trim();
      if (name !== '' && flag !== '') partsFlag[prNorm(name)] = name;
    }
  }
  if (Object.keys(partsFlag).length === 0) {
    ui.alert('В «Справочниках» (столбец H) не отмечена ни одна заказная запчасть.\n' +
             'Поставьте метку напротив нужных строк столбца G.');
    return;
  }

  // --- 2. Проход по «Реестру» ---
  var lastRow = reg.getLastRow();
  if (lastRow < 2) { ui.alert('В «Реестре» нет данных.'); return; }
  var lastCol  = reg.getLastColumn();
  // Крайние столбцы в старой таблице могут отсутствовать — читаем сколько есть
  // и дальше смотрим на флаги, а не на длину строки.
  var numCols  = Math.min(SSD_IN, lastCol);
  var haveNote = (PART_NOTE <= lastCol);
  var haveSsd  = (SSD_OUT <= lastCol);
  var data = reg.getRange(2, 1, lastRow - 1, numCols).getValues();

  var machines = [];                  // {sn, parts:[can...], note, ssd} — к заказу
  var checked  = [];                  // {sn, result, ssd} — осмотрены, заказ не нужен
  var totals   = {};                  // каноничное имя -> кол-во (по числу железок)

  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var sn  = String(row[SN - 1]).trim();
    if (sn === '') continue;
    if (String(row[ACT_OUT - 1]).trim() !== '') continue; // уже выдано
    if (row[READY - 1] === true) continue;                // уже готово

    var items = prSplit(row[DIAG_REPLACE - 1]);
    var need  = [];
    for (var k = 0; k < items.length; k++) {
      var key = prNorm(items[k]);
      if (partsFlag.hasOwnProperty(key)) {
        var can = partsFlag[key];
        need.push(can);
        totals[can] = (totals[can] || 0) + 1;
      }
    }
    // Серийник накопителя печатаем у КАЖДОЙ железки: документ работает не
    // только заявкой на заказ, но и отчётом о диагностике, а там номер диска
    // нужен независимо от того, меняли его или нет.
    //
    // Формулировка зависит от того, меняют ли диск: «снят» уместно только
    // когда накопитель значится среди заказных запчастей. Для машины, где
    // диск проверили и оставили, это был бы подлог в подписываемой бумаге.
    var replacing = need.some(function (n) { return /ссд|ssd/i.test(n); });
    var out = haveSsd ? String(row[SSD_OUT - 1] || '').trim() : '';
    var inn = (haveSsd && SSD_IN <= lastCol) ? String(row[SSD_IN - 1] || '').trim() : '';

    var ssd;
    if (out === '' && inn === '') {
      ssd = 'не указан';
    } else if (!replacing) {
      // Бывает, что заполнен только номер установленного диска, а исходный нет.
      // Пустая графа в отчёте читается как «забыли», поэтому и здесь пишем прямо.
      ssd = out !== '' ? out : 'не указан';
    } else {
      var bits = [];
      if (out !== '') bits.push('снят ' + out);
      if (inn !== '') bits.push('установлен ' + inn);
      ssd = bits.join('; ');
    }

    if (need.length > 0) {
      machines.push({
        sn: sn,
        parts: need,
        note: haveNote ? String(row[PART_NOTE - 1]).trim() : '',
        ssd: ssd
      });
      continue;
    }

    // Заказывать нечего. Если железку всё же осматривали — она идёт во второй
    // раздел: документ служит и отчётом, а «ничего не нужно» — тоже результат
    // диагностики. Непродиагностированные (F и G пусты) не попадают никуда:
    // по ним сказать нечего, и в отчёте они создавали бы ложное впечатление
    // осмотренных.
    var fine = String(row[DIAG_OK - 1] || '').trim();
    if (fine === '' && items.length === 0) continue;

    var result = [];
    if (fine !== '')        result.push('исправно: ' + fine);
    if (items.length > 0)   result.push('отмечено: ' + items.join(', '));

    checked.push({
      sn: sn,
      result: result.length ? result.join('; ') : 'замена не требуется',
      ssd: ssd
    });
  }

  if (machines.length === 0 && checked.length === 0) {
    ui.alert('Нет железок в работе: ни заказных запчастей, ни результатов диагностики.');
    return;
  }

  // --- 3. PDF ---
  var url = prBuildPdf(machines, totals, checked);
  ss.toast('Заявка сформирована.', 'Готово', 5);
  ui.alert('Заявка на запчасти сформирована.\n\nСсылка:\n' + url);
}

/* ============================ helpers ============================ */

function prNorm(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

function prSplit(cell) {
  if (cell === null || cell === undefined) return [];
  return String(cell).split(/[\n,;]+/)
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; });
}

// Засада: DocumentApp не терпит пустой текст — '' заменяем пробелом.
function prSafe(s) { s = (s === null || s === undefined) ? '' : String(s).trim(); return s === '' ? ' ' : s; }

function prBuildPdf(machines, totals, checked) {
  var tz      = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy');

  var doc  = DocumentApp.create('Заявка на запчасти от ' + dateStr);
  var body = doc.getBody();
  body.setMarginTop(50).setMarginBottom(50).setMarginLeft(50).setMarginRight(50);

  body.appendParagraph('Заявка на запчасти')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1).setFontFamily('Times New Roman');
  body.appendParagraph('от ' + dateStr + ' · СЦ Пример (ИП Иванов И.И.)')
      .setFontFamily('Times New Roman').setSpacingAfter(12);

  // Раздел 1 — то, ради чего документ подписывают: что заказать.
  // Столбец с накопителем стоит всегда: документ служит и отчётом о
  // диагностике, а в отчёте пропуск графы неотличим от «забыли записать».
  // Пустых мест там быть не должно — вместо них «не указан».
  if (machines.length > 0) {
    body.appendParagraph('Требуется заказать')
        .setHeading(DocumentApp.ParagraphHeading.HEADING2).setFontFamily('Times New Roman');

    var t1 = [['№', 'Серийный №', 'Требуется', 'Серийный № SSD']];
    for (var i = 0; i < machines.length; i++) {
      var m = machines[i];
      var need = m.parts.join(', ');
      if (m.note !== '') need += ' (' + m.note + ')';

      t1.push([String(i + 1), prSafe(m.sn), prSafe(need), prSafe(m.ssd)]);
    }
    prStyleTable(body.appendTable(t1));

    body.appendParagraph('Итого заказать')
        .setHeading(DocumentApp.ParagraphHeading.HEADING2).setFontFamily('Times New Roman').setSpacingBefore(16);

    var names = Object.keys(totals).sort();
    var t2 = [['Запчасть', 'Кол-во, шт']];
    for (var j = 0; j < names.length; j++) t2.push([prSafe(names[j]), String(totals[names[j]])]);
    prStyleTable(body.appendTable(t2));

    body.appendParagraph('Где важны характеристики (сокет процессора, объём/интерфейс ССД, тип ОЗУ) — ' +
                         'см. уточнения в таблице по железкам выше.')
        .setFontFamily('Times New Roman').setItalic(true).setFontSize(9).setSpacingBefore(8);
  }

  // Раздел 2 — осмотренные железки, которым заказ не нужен. Отдельной
  // таблицей, а не строками в первой: иначе подписант читает заявку на заказ
  // вперемешку с тем, что заказывать не надо.
  if (checked && checked.length > 0) {
    body.appendParagraph('Проверено, заказ не требуется')
        .setHeading(DocumentApp.ParagraphHeading.HEADING2).setFontFamily('Times New Roman').setSpacingBefore(16);

    var t3 = [['№', 'Серийный №', 'Результат осмотра', 'Серийный № SSD']];
    for (var k = 0; k < checked.length; k++) {
      var ch = checked[k];
      t3.push([String(k + 1), prSafe(ch.sn), prSafe(ch.result), prSafe(ch.ssd)]);
    }
    prStyleTable(body.appendTable(t3));
  }

  doc.saveAndClose();

  var file   = DriveApp.getFileById(doc.getId());
  var folder = prFolder('Акты сервиса');
  var pdf    = folder.createFile(file.getAs('application/pdf'))
                     .setName('Заявка на запчасти ' + dateStr + '.pdf');
  file.setTrashed(true);   // временный Док — в корзину
  return pdf.getUrl();
}

function prStyleTable(table) {
  table.setBorderWidth(1);
  for (var r = 0; r < table.getNumRows(); r++) {
    var trow = table.getRow(r);
    for (var c = 0; c < trow.getNumCells(); c++) {
      var cell = trow.getCell(c);
      cell.setPaddingTop(3).setPaddingBottom(3).setPaddingLeft(5).setPaddingRight(5);
      var p = cell.getChild(0).asParagraph();
      p.setFontFamily('Times New Roman').setFontSize(11).setSpacingBefore(0).setSpacingAfter(0);
      if (r === 0) p.setBold(true);
    }
  }
}

function prFolder(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}