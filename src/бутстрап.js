/**
 * СЦ Пример — бутстрап таблицы актов приёма-передачи (v12).
 * Меню включает «Сформировать акты забора» (функция живёт в отдельном файле «Акты»).
 *
 * Жизненный цикл статусов (из конфига STATUSES):
 *   Заявка → Принят → Продиагностирован → Готов к выдаче → Возвращён
 *   • Заявка   — введён серийник и проблема со слов.
 *   • Принят   — назначен «Ответственный заказчика (забор)»; тогда же ставится дата приёма.
 *                С этого момента доступен АКТ ЗАБОРА.
 *   • Продиагностирован — заполнена диагностика.
 *   • Готов к выдаче    — стоит галочка «Готов».
 *   • Возвращён         — сформирован АКТ ВЫДАЧИ (возврата).
 *
 * ПЕРВЫЙ ЗАПУСК на пустой таблице  → bootstrap().
 * ПЕРЕСОБРАТЬ (листы уже есть)      → reset().
 * Поменял STATUSES / хочешь обновить без потери данных → меню «Сервис» →
 *   «Обновить статусы (формула, цвета, легенда)».
 * После обновления кода перезагрузи вкладку (F5) — появится меню «Сервис».
 */

/* ─────────  ЕДИНЫЙ КОНФИГ СТАТУСОВ (от «дальнего» к «ближнему» = приоритет)  ───────── */
// cond — условие для формулы-массива; у «Заявка» условия нет (статус по умолчанию).
// engineer — показывать ли железку в мобильной форме инженера. Признак живёт
// здесь, а не в коде формы: список статусов и так единственный источник правды,
// и при переименовании статуса фильтр формы не придётся править отдельно.
const STATUSES = [
  { label: 'Возвращён',         color: '#b6d7a8', cond: 'M2:M<>""',                 desc: 'сформирован акт выдачи (возврата)' },
  { label: 'Готов к выдаче',    color: '#d9ead3', cond: 'H2:H=TRUE',               engineer: true, desc: 'отмечена галочка «Готов»' },
  { label: 'Продиагностирован', color: '#fff2cc', cond: '(F2:F<>"")+(G2:G<>"")>0', engineer: true, desc: 'инженер заполнил диагностику (точные неисправности)' },
  { label: 'Принят',            color: '#cfe2f3', cond: 'E2:E<>""',                engineer: true, desc: 'назначен ответственный заказчика, проставлена дата приёма — доступен акт забора' },
  { label: 'Заявка',            color: '#efefef', cond: null,                      desc: 'введён серийник и проблема со слов; ещё не принято' },
];

const SHEET_REESTR   = 'Реестр';
const SHEET_REF      = 'Справочники';
const SHEET_SETTINGS = 'Настройки';
const LAST_ROW       = 500;

const COL = {
  ID: 1, SN: 2, PROBLEM: 3, DATE_IN: 4, RESP_IN: 5,
  DIAG_REPLACE: 6, DIAG_OK: 7, READY: 8, DATE_OUT: 9, RESP_OUT: 10,
  RESP_US: 11, ACT_IN: 12, ACT_OUT: 13, STATUS: 14, PDF_IN: 15, PDF_OUT: 16
};
const FAULTS_COL = 7; // столбец G в «Справочниках»

/* ─────────────────────────────  МЕНЮ  ───────────────────────────────── */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Сервис')
    .addItem('Проблема со слов (галочки)…', 'openProblemDialog')
    .addItem('Диагностика (галочки)…', 'openDiagnosticsDialog')
    .addSeparator()
    .addItem('Сформировать акты забора', 'makeIntakeActs')
    .addItem('Сформировать акты выдачи', 'makeHandoverActs')
    .addSeparator()
    .addItem('Обновить статусы (формула, цвета, легенда)', 'refreshStatuses')
    .addSeparator()
    .addItem('Заявка на запчасти', 'makePartsRequest')
    .addItem('Выгрузка счёта в 1С', 'makeInvoicePositions')
    .addSeparator()
    .addItem('Сделать копию таблицы', 'backupBook')
    .addItem('Telegram: включить приём заявок', 'tgSetupBot')
    .addItem('Telegram: проверить сейчас', 'tgPollNow')
    .addItem('Telegram: состояние приёма', 'tgStatus')
    .addToUi();
}

/* ──────────────────  Строим формулу статуса из STATUSES  ─────────────── */
function buildStatusFormula_() {
  const cond = STATUSES.filter(function (s) { return s.cond; });
  const def  = STATUSES[STATUSES.length - 1].label;
  let expr = '"' + def + '"';
  for (let i = cond.length - 1; i >= 0; i--) {
    expr = 'IF(' + cond[i].cond + ';"' + cond[i].label + '";' + expr + ')';
  }
  return '=ARRAYFORMULA(IF(B2:B="";"";' + expr + '))';
}

/* ────────────────────────────  БУТСТРАП  ────────────────────────────── */
function bootstrap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEET_REESTR, SHEET_REF, SHEET_SETTINGS].forEach(function (name) {
    if (ss.getSheetByName(name)) {
      throw new Error('Лист «' + name + '» уже существует. Запусти reset().');
    }
  });

  createSettings_(ss);
  createRef_(ss);
  createReestr_(ss);

  const def = ss.getSheetByName('Лист1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0) ss.deleteSheet(def);

  ss.setActiveSheet(ss.getSheetByName(SHEET_REESTR));
  ui_('Готово! Таблица размечена. Перезагрузи вкладку (F5), чтобы появилось меню «Сервис».');
}

function reset() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert('Пересобрать таблицу?',
    'Будут УДАЛЕНЫ листы «Реестр», «Справочники», «Настройки» со всеми данными ' +
    'и созданы заново.\n\nПеред удалением копия таблицы автоматически ляжет ' +
    'в папку «' + BACKUP_FOLDER + '» рядом с таблицей. Продолжить?', ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  // Данные заявок существуют в единственном экземпляре — в самой таблице.
  // Копию снимаем ДО удаления листов и до вопросов: если копия не сделалась,
  // пересборку продолжать нельзя.
  const copy = backupBook_('перед reset');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Пустой лист-заглушка: удалить все листы книги Google не даёт.
  ss.insertSheet('__tmp__');
  [SHEET_REESTR, SHEET_REF, SHEET_SETTINGS].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (sh) ss.deleteSheet(sh);
  });
  bootstrap();
  const t = ss.getSheetByName('__tmp__');
  if (t) ss.deleteSheet(t);
  ui_('Таблица пересобрана. Копия прежних данных: ' + copy.getName());
}

/** Обновить всё, что зависит от STATUSES, БЕЗ пересборки (данные не трогаются). */
function refreshStatuses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_REESTR);
  sh.getRange(2, COL.STATUS, sh.getMaxRows() - 1, 1).clearContent();
  sh.getRange(2, COL.STATUS).setFormula(buildStatusFormula_());
  applyConditionalFormatting_(sh, LAST_ROW - 1);
  const ref = ss.getSheetByName(SHEET_REF);
  if (ref) writeLegend_(ref);
  ui_('Статусы обновлены: формула, цвета, легенда.');
}

/* ─────────────────────────  ЛИСТ «Настройки»  ───────────────────────── */
function createSettings_(ss) {
  const sh = ss.insertSheet(SHEET_SETTINGS);
  const data = [
    ['Параметр', 'Значение'],
    ['Заказчик (организация)', 'ООО «Заказчик»'],
    ['Исполнитель', 'ИП Иванов И.И. (СЦ Пример)'],
    ['Суффикс номера акта', '/сб'],
    ['Последний номер акта', 0],
    ['Наш ответственный по умолчанию', 'Сидоров В.В.'],
    ['Начало серийного номера заказчика', 'SC'],
    ['ID папки Google Drive для PDF', ''],
    ['ID шаблона акта ЗАБОРА (Google Docs)', ''],
    ['ID шаблона акта ВЫДАЧИ (Google Docs)', ''],
  ];
  sh.getRange(1, 1, data.length, 2).setValues(data);
  sh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#d9d9d9');
  sh.getRange(2, 1, data.length - 1, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 300);
  sh.setColumnWidth(2, 340);
  sh.setFrozenRows(1);
}

/* ─────────────────────────  ЛИСТ «Справочники»  ─────────────────────── */
function createRef_(ss) {
  const sh = ss.insertSheet(SHEET_REF);

  sh.getRange('A1:B1').setValues([['Заказчик — ФИО', 'Должность']]);
  sh.getRange('D1:E1').setValues([['Наши — ФИО', 'Должность']]);
  sh.getRange('G1').setValue('Неисправности / компоненты');

  sh.getRange('A2:A3').setValues([['Иванова А.А.'], ['Петрова Б.Б.']]);
  sh.getRange('D2').setValue('Сидоров В.В.');

  const faults = [
    'кулер', 'ссд', 'озу', 'бп', 'мат.плата', 'процессор',
    'не включается', 'не загружает ОС'
  ];
  sh.getRange(2, 7, faults.length, 1).setValues(faults.map(function (f) { return [f]; }));

  writeLegend_(sh);

  ['A1:B1', 'D1:E1', 'G1'].forEach(function (a) {
    sh.getRange(a).setFontWeight('bold').setBackground('#d9d9d9');
  });
  sh.setColumnWidth(1, 180); sh.setColumnWidth(2, 180);
  sh.setColumnWidth(3, 30);
  sh.setColumnWidth(4, 180); sh.setColumnWidth(5, 180);
  sh.setColumnWidth(6, 30);
  sh.setColumnWidth(7, 200);
  sh.setColumnWidth(8, 30);
  sh.setColumnWidth(9, 170);
  sh.setColumnWidth(10, 360);
  sh.setFrozenRows(1);
}

/** Легенда статусов в «Справочниках» (I:J). Для людей; формулу не питает. */
function writeLegend_(sh) {
  sh.getRange('I1:J30').clearContent().setBackground(null);
  sh.getRange('I1:J1').setValues([['Статус', 'Что означает']])
    .setFontWeight('bold').setBackground('#d9d9d9');
  const legend = STATUSES.slice().reverse(); // по циклу: Заявка → … → Возвращён
  legend.forEach(function (s, i) {
    const r = i + 2;
    sh.getRange(r, 9).setValue(s.label).setBackground(s.color);
    sh.getRange(r, 10).setValue(s.desc);
  });
}

/* ─────────────────────────  ЛИСТ «Реестр»  ──────────────────────────── */
function createReestr_(ss) {
  const sh  = ss.insertSheet(SHEET_REESTR);
  const ref = ss.getSheetByName(SHEET_REF);

  const headers = [
    '№', 'Серийный номер', 'Проблема (со слов заказчика)',
    'Дата приёма', 'Ответственный заказчика (забор)',
    'Неисправно (под замену/ремонт)', 'Проверено, исправно',
    'Готов', 'Дата выдачи', 'Ответственный заказчика (выдача)',
    'Наш ответственный', '№ акта забора', '№ акта выдачи', 'Статус',
    'PDF забора', 'PDF выдачи'
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#d9d9d9')
    .setWrap(true).setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);

  const n = LAST_ROW - 1;

  applyList_(sh.getRange(2, COL.RESP_IN,  n, 1), ref.getRange('A2:A'));
  applyList_(sh.getRange(2, COL.RESP_OUT, n, 1), ref.getRange('A2:A'));
  applyList_(sh.getRange(2, COL.RESP_US,  n, 1), ref.getRange('D2:D'));

  sh.getRange(2, COL.DATE_IN,  n, 1).setNumberFormat('dd.mm.yyyy');
  sh.getRange(2, COL.DATE_OUT, n, 1).setNumberFormat('dd.mm.yyyy');

  sh.getRange(2, COL.STATUS).setFormula(buildStatusFormula_());

  applyConditionalFormatting_(sh, n);

  const widths = [45, 210, 240, 95, 190, 170, 170, 70, 95, 190, 150, 110, 110, 150, 90, 90];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

/* ─────────────────────────  Вспомогательные  ────────────────────────── */
function applyList_(targetRange, sourceRange) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(sourceRange, true)
    .setAllowInvalid(false)
    .build();
  targetRange.setDataValidation(rule);
}

function applyConditionalFormatting_(sh, n) {
  const rules = [];

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($B2<>"";$M2="";COUNTIFS($B$2:$B;$B2;$M$2:$M;"")>1)')  // активный дубль: тот же SN >1 раза среди строк без акта выдачи (M пуст)
    .setBackground('#f4cccc')
    .setRanges([sh.getRange(2, COL.SN, n, 1)])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    // Подсветка серийника непривычного вида. Префиксы и минимальная длина —
    // под формат вашего заказчика: поменяйте их на свои.
    .whenFormulaSatisfied('=AND($B2<>"";NOT(AND(OR(LEFT($B2;3)="SCA";LEFT($B2;3)="SCL");LEN($B2)>=15)))')
    .setBackground('#ffe0b2')
    .setRanges([sh.getRange(2, COL.SN, n, 1)])
    .build());

  STATUSES.forEach(function (s) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s.label)
      .setBackground(s.color)
      .setRanges([sh.getRange(2, COL.STATUS, n, 1)])
      .build());
  });

  sh.setConditionalFormatRules(rules);
}

/* ─────────────────  Автозаполнение (два триггера)  ──────────────────── */
/**
 * Обвязка новой строки «Реестра»: № записи, наш ответственный, флажки.
 *
 * Живёт отдельно от onEdit намеренно. onEdit — ПРОСТОЙ триггер: он срабатывает
 * только на правку человека в интерфейсе и молчит, когда строку добавляет
 * скрипт. Заявка, приехавшая из Telegram, без этого вызова оказалась бы без
 * номера, без ответственного и без флажков. Один и тот же код зовут оба пути.
 */
function applyNewRowDefaults_(sh, row) {
  const idCell = sh.getRange(row, COL.ID);
  if (idCell.getValue() === '') idCell.setValue(nextId_(sh));

  const usCell = sh.getRange(row, COL.RESP_US);
  if (usCell.getValue() === '') {
    const def = getSetting_('Наш ответственный по умолчанию');
    if (def) usCell.setValue(def);
  }

  const rCell = sh.getRange(row, COL.READY);
  if (rCell.getValue() === '') rCell.insertCheckboxes();

  const invCell = sh.getRange(row, INV_COL_IN);   // «В счёт» (R/18)
  if (invCell.getValue() === '') invCell.insertCheckboxes();
}

/**
 * Дописывает параметр в «Настройки», если его там ещё нет.
 * Нужно для таблиц, собранных до появления параметра: пересобирать книгу
 * ради одной строки нельзя — reset() удаляет заявки.
 */
function ensureSetting_(name, value) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  if (!sh) return '';
  const last = sh.getLastRow();
  const data = sh.getRange(1, 1, last, 2).getValues();
  for (let i = 0; i < data.length; i++) if (data[i][0] === name) return data[i][1];
  sh.getRange(last + 1, 1).setValue(name).setFontWeight('bold');
  sh.getRange(last + 1, 2).setValue(value);
  return value;
}

/** Ответственные заказчика из «Справочников» (колонка A) — для сверки при разборе. */
function knownResponsibles_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REF);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(String);
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() !== SHEET_REESTR) return;
  const row = e.range.getRow();
  if (row < 2) return;
  const col = e.range.getColumn();

  // 1) Ввод серийника (B): № записи, наш ответственный, флажки «Готов» и «В счёт».
  if (col === COL.SN && e.value) {
    applyNewRowDefaults_(sh, row);
    return;
  }

  // 2) Назначен ответственный заказчика (забор) (E): проставляем дату приёма.
  if (col === COL.RESP_IN && e.value) {
    const dCell = sh.getRange(row, COL.DATE_IN);
    if (dCell.getValue() === '') dCell.setValue(new Date());
    return;
  }
}

function nextId_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const ids = sh.getRange(2, COL.ID, last - 1, 1).getValues()
    .map(function (r) { return r[0]; })
    .filter(function (v) { return v !== '' && !isNaN(v); });
  return ids.length ? Math.max.apply(null, ids) + 1 : 1;
}

function getSetting_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  if (!sh) return '';
  const data = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (let i = 0; i < data.length; i++) if (data[i][0] === name) return data[i][1];
  return '';
}

function getFaults_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REF);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, FAULTS_COL, last - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(String);
}

function splitList_(val) {
  return String(val).split(',').map(function (s) { return s.trim(); }).filter(String);
}

function ui_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) {} }

function activeReestrRow_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  if (sh.getName() !== SHEET_REESTR) { ui_('Открой лист «Реестр» и встань на строку с записью.'); return 0; }
  const row = sh.getActiveRange().getRow();
  if (row < 2) { ui_('Встань на строку с записью (не на шапку).'); return 0; }
  return row;
}

/* ───────────────────  ОКНО: Проблема со слов  ───────────────────────── */
function openProblemDialog() {
  const row = activeReestrRow_();
  if (!row) return;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REESTR);
  const faults = getFaults_();
  const current = splitList_(sh.getRange(row, COL.PROBLEM).getValue());
  const html = buildProblemHtml_(row, faults, current);
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(360).setHeight(470),
    'Проблема со слов — строка ' + row
  );
}

function saveProblem(row, values) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REESTR)
    .getRange(row, COL.PROBLEM).setValue(values.join(', '));
}

function buildProblemHtml_(row, faults, current) {
  const data = { row: row, faults: faults, current: current };
  return '<!DOCTYPE html><html><head><base target="_top"><style>'
    + 'body{font-family:Arial,Helvetica,sans-serif;font-size:13px;margin:12px;color:#222}'
    + '.item{padding:7px 4px;border-bottom:1px solid #eee}'
    + '.item label{cursor:pointer}'
    + '.list{max-height:350px;overflow:auto}'
    + '.bar{margin-top:12px;text-align:right}'
    + 'button{font-size:13px;padding:6px 14px;margin-left:6px;border-radius:4px;border:1px solid #ccc;cursor:pointer}'
    + '.ok{background:#1a73e8;color:#fff;border-color:#1a73e8}'
    + '</style></head><body>'
    + '<div class="list" id="list"></div>'
    + '<div class="bar"><button onclick="google.script.host.close()">Отмена</button>'
    + '<button class="ok" onclick="save()">Сохранить</button></div>'
    + '<script>var D=' + JSON.stringify(data) + ';'
    + 'var L=document.getElementById("list");'
    + 'D.faults.forEach(function(f){'
    + ' var c=D.current.indexOf(f)>=0?"checked":"";'
    + ' L.innerHTML+=\'<div class="item"><label><input type="checkbox" value="\'+f+\'" \'+c+\'> \'+f+\'</label></div>\';'
    + '});'
    + 'function save(){var v=[],ch=L.querySelectorAll("input:checked");'
    + ' for(var i=0;i<ch.length;i++)v.push(ch[i].value);'
    + ' google.script.run.withSuccessHandler(function(){google.script.host.close();}).saveProblem(D.row,v);}'
    + '</script></body></html>';
}

/* ───────────────────  ОКНО: Диагностика  ────────────────────────────── */
function openDiagnosticsDialog() {
  const row = activeReestrRow_();
  if (!row) return;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REESTR);
  const faults  = getFaults_();
  const curRepl = splitList_(sh.getRange(row, COL.DIAG_REPLACE).getValue());
  const curOk   = splitList_(sh.getRange(row, COL.DIAG_OK).getValue());
  const html = buildDiagHtml_(row, faults, curRepl, curOk);
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(420).setHeight(480),
    'Диагностика — строка ' + row
  );
}

function saveDiagnostics(row, replaceArr, okArr) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REESTR);
  sh.getRange(row, COL.DIAG_REPLACE).setValue(replaceArr.join(', '));
  sh.getRange(row, COL.DIAG_OK).setValue(okArr.join(', '));
}

function buildDiagHtml_(row, faults, curRepl, curOk) {
  const data = { row: row, faults: faults, repl: curRepl, ok: curOk };
  return '<!DOCTYPE html><html><head><base target="_top"><style>'
    + 'body{font-family:Arial,Helvetica,sans-serif;font-size:13px;margin:12px;color:#222}'
    + 'table{width:100%;border-collapse:collapse}'
    + 'th,td{padding:6px 4px;border-bottom:1px solid #eee;text-align:left}'
    + 'th{font-size:12px;color:#555}'
    + '.c{text-align:center;width:110px}'
    + '.wrap{max-height:350px;overflow:auto}'
    + '.bar{margin-top:12px;text-align:right}'
    + 'button{font-size:13px;padding:6px 14px;margin-left:6px;border-radius:4px;border:1px solid #ccc;cursor:pointer}'
    + '.ok{background:#1a73e8;color:#fff;border-color:#1a73e8}'
    + '</style></head><body>'
    + '<div class="wrap"><table><thead><tr>'
    + '<th>Компонент / неисправность</th><th class="c">Неисправно</th><th class="c">Исправно</th>'
    + '</tr></thead><tbody id="tb"></tbody></table></div>'
    + '<div class="bar"><button onclick="google.script.host.close()">Отмена</button>'
    + '<button class="ok" onclick="save()">Сохранить</button></div>'
    + '<script>var D=' + JSON.stringify(data) + ';'
    + 'var TB=document.getElementById("tb");'
    + 'D.faults.forEach(function(f){'
    + ' var r=D.repl.indexOf(f)>=0?"checked":"";'
    + ' var w=D.ok.indexOf(f)>=0?"checked":"";'
    + ' TB.innerHTML+=\'<tr><td>\'+f+\'</td>\'+'
    + '  \'<td class="c"><input type="checkbox" class="r" data-f="\'+f+\'" \'+r+\'></td>\'+'
    + '  \'<td class="c"><input type="checkbox" class="w" data-f="\'+f+\'" \'+w+\'></td></tr>\';'
    + '});'
    + 'TB.addEventListener("change",function(e){var t=e.target;'
    + ' if(t.type!=="checkbox"||!t.checked)return;'
    + ' var f=t.getAttribute("data-f");'
    + ' var other=t.classList.contains("r")?".w":".r";'
    + ' var o=TB.querySelector(other+\'[data-f="\'+f+\'"]\');if(o)o.checked=false;});'
    + 'function save(){var repl=[],ok=[];'
    + ' var rr=TB.querySelectorAll("input.r:checked");for(var i=0;i<rr.length;i++)repl.push(rr[i].getAttribute("data-f"));'
    + ' var ww=TB.querySelectorAll("input.w:checked");for(var j=0;j<ww.length;j++)ok.push(ww[j].getAttribute("data-f"));'
    + ' google.script.run.withSuccessHandler(function(){google.script.host.close();}).saveDiagnostics(D.row,repl,ok);}'
    + '</script></body></html>';
}