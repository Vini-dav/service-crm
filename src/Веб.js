/***********************************************************************
 * Сервис — ВЕБ-ФОРМА ДИАГНОСТИКИ (мобильная). Отдельный файл.
 * Пара к файлу «Форма.html».
 *
 * Разворачивание: Publish/Deploy → New deployment → тип «Web app»
 *   Execute as: Me (владелец)
 *   Who has access: Anyone with Google account (или Anyone)
 *   Скопировать URL, открыть на телефоне, «на экран Домой».
 * После правок кода — повторный Deploy (или тест через «Test deployments»).
 *
 * Пишет в «Реестр»: F (диагностика), «Уточнение по запчастям», «Комментарий»,
 * серийники снятого и установленного SSD.
 * Колонки находятся по заголовкам, с числовым запасным индексом.
 ***********************************************************************/

function doGet(e) {
  // Один адрес обслуживает две вещи: форму инженера и ссылку «забрать сейчас»
  // из Telegram-приёмки (см. tgPoke_). Развёртывание у веб-приложения одно,
  // поэтому маршрутизируем по параметру.
  const params = (e && e.parameter) || {};
  if (params.poll) return tgPoke_(params.poll);

  return HtmlService.createHtmlOutputFromFile('Форма')
    .setTitle('Диагностика — Сервис')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

/* ---------- колонки по заголовкам ---------- */
function webCols_(sh) {
  var lc = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lc).getValues()[0];
  function find(cands, fb) {
    for (var i = 0; i < headers.length; i++) {
      var h = String(headers[i]).toLowerCase();
      for (var j = 0; j < cands.length; j++) if (h.indexOf(cands[j]) !== -1) return i + 1;
    }
    return fb;
  }
  return {
    ID:        find(['№ запис', 'запис', 'id'], 1),
    SN:        find(['серийн'], 2),
    PROBLEM:   find(['со слов', 'жалоб', 'проблем'], 3),
    REPLACE:   find(['под замену', 'замену/ремонт'], 6),
    READY:     find(['готов'], 8),
    STATUS:    find(['статус'], 14),
    PART_NOTE: find(['уточнение'], 17),
    COMMENT:   find(['коммент'], 20),
    SSD_OUT:   find(['исходн', 'снят'], 21),
    SSD_IN:    find(['установлен'], 22)
  };
}

/**
 * Столбцы, которых в старой таблице может не быть, заводим на месте.
 *
 * Базовые шестнадцать создаёт bootstrap, а эти добавлялись по мере того, как
 * росли задачи. Пересобирать ради них «Реестр» нельзя — reset() стирает данные,
 * поэтому столбец появляется сам при первом открытии формы.
 */
function webEnsureCols_(sh, c) {
  var extra = [
    { col: c.COMMENT, title: 'Комментарий',               width: 220 },
    // Переименование: столбец завели как «Снятый SSD», но серийник пишут при
    // любой проверке накопителя, а не только при замене. «Снятый» для машины,
    // где диск исправен и остался на месте, — враньё в шапке.
    { col: c.SSD_OUT, title: 'SSD исходный (S/N)',        width: 190,
      wasCalled: ['Снятый SSD (S/N)'] },
    { col: c.SSD_IN,  title: 'SSD установленный (S/N)',   width: 190,
      wasCalled: ['Установленный SSD (S/N)'] }
  ];

  var widest = 0;
  extra.forEach(function (e) { if (e.col > widest) widest = e.col; });
  if (sh.getMaxColumns() < widest) {
    sh.insertColumnsAfter(sh.getMaxColumns(), widest - sh.getMaxColumns());
  }

  extra.forEach(function (e) {
    var cell    = sh.getRange(1, e.col);
    var current = String(cell.getValue()).trim();

    if (current === '') {
      cell.setValue(e.title).setFontWeight('bold');
      sh.setColumnWidth(e.col, e.width);
      return;
    }

    // Старое название — переписываем шапку, данные под ней не трогаем.
    if (e.wasCalled && e.wasCalled.indexOf(current) !== -1) {
      cell.setValue(e.title);
    }
  });
}

/**
 * Какие статусы инженер видит в форме — берём из конфига STATUSES.
 * Не список строк здесь, а флаг там: переименуют статус — фильтр не отвалится.
 */
function webVisibleStatuses_() {
  return STATUSES
    .filter(function (s) { return s.engineer; })
    .map(function (s) { return s.label; });
}

/** Список активных железок для формы. */
function getActiveUnits() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Реестр');
  var c  = webCols_(sh);
  webEnsureCols_(sh, c);

  var faults  = getFaults_();              // из «Справочников», уже есть в проекте
  var visible = webVisibleStatuses_();
  var last    = sh.getLastRow();
  var units   = [];

  if (last >= 2) {
    var width = Math.max(c.ID, c.SN, c.PROBLEM, c.REPLACE, c.READY, c.STATUS,
      c.PART_NOTE, c.COMMENT, c.SSD_OUT, c.SSD_IN);
    var data  = sh.getRange(2, 1, last - 1, width).getValues();
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var sn  = String(row[c.SN - 1]).trim();
      if (sn === '') continue;

      // Единственный признак отбора — статус из таблицы. Раньше здесь стояли
      // две самодельные проверки (есть дата приёма, нет акта выдачи), и они
      // расходились со статусом: строка в статусе «Заявка», которой почему-то
      // проставили дату приёма, попадала инженеру в работу.
      var status = String(row[c.STATUS - 1]).trim();
      if (visible.indexOf(status) === -1) continue;

      var checked   = splitFaults_(row[c.REPLACE - 1]);
      units.push({
        id:        row[c.ID - 1],
        serial:    sn,
        problem:   String(row[c.PROBLEM - 1]).trim(),
        status:    status,
        ready:     row[c.READY - 1] === true,
        diagnosed: checked.length > 0,
        checked:   checked,
        partNote:  String(row[c.PART_NOTE - 1]).trim(),
        comment:   String(row[c.COMMENT - 1]).trim(),
        ssdOut:    String(row[c.SSD_OUT - 1]).trim(),
        ssdIn:     String(row[c.SSD_IN - 1]).trim()
      });
    }
  }

  // непродиагностированные сверху → продиагностированные → готовые; внутри новые сверху
  units.sort(function (a, b) {
    var ra = a.ready ? 2 : (a.diagnosed ? 1 : 0);
    var rb = b.ready ? 2 : (b.diagnosed ? 1 : 0);
    if (ra !== rb) return ra - rb;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });

  return { faults: faults, units: units };
}

/** Сохранение одной карточки. */
function saveUnit(payload) {
  var sh = SpreadsheetApp.getActive().getSheetByName('Реестр');
  var c  = webCols_(sh);
  webEnsureCols_(sh, c);

  var last = sh.getLastRow();
  if (last < 2) return { ok: false, msg: 'Нет данных в «Реестре».' };

  var ids = sh.getRange(2, c.ID, last - 1, 1).getValues();
  var target = -1;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(payload.id)) { target = i + 2; break; }
  }
  if (target === -1) return { ok: false, msg: 'Запись не найдена — обновите список.' };

  var checked = payload.checked || [];
  sh.getRange(target, c.REPLACE).setValue(checked.join(', '));
  sh.getRange(target, c.PART_NOTE).setValue(payload.partNote || '');
  sh.getRange(target, c.COMMENT).setValue(payload.comment || '');
  sh.getRange(target, c.READY).setValue(payload.ready === true);

  // Серийники SSD приходят, только когда в диагностике отмечен ссд и поля
  // показаны. Если ключа нет — не трогаем ячейки: снятая галочка не должна
  // стирать уже записанные номера, иначе одно случайное нажатие уносит данные,
  // которые больше неоткуда взять.
  if (payload.ssdOut !== undefined) sh.getRange(target, c.SSD_OUT).setValue(payload.ssdOut);
  if (payload.ssdIn  !== undefined) sh.getRange(target, c.SSD_IN).setValue(payload.ssdIn);

  return { ok: true, diagnosed: checked.length > 0 };
}

function splitFaults_(v) {
  if (v === null || v === undefined) return [];
  return String(v).split(/[\n,;]+/).map(function (x) { return x.trim(); }).filter(String);
}