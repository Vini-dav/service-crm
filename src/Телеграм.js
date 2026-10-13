/***********************************************************************
 * Сервис — приём заявок фотографией через Telegram.
 *
 * Путь заявки:
 *   фото в бот → Telegram шлёт вебхук на /exec → скачали файл →
 *   Drive распознал текст → разобрали (см. «Разбор.js») → показали, что поняли,
 *   и ждём кнопку → «Записать» → строка в «Реестре».
 *
 * ПОЧЕМУ ОПРОС, А НЕ ВЕБХУК. Сначала бот работал вебхуком на /exec, и это
 * не заработало: Apps Script ВСЕГДА отвечает на POST редиректом 302 на
 * googleusercontent — тело ответа лежит там. Наш хук развёртывания поэтому и
 * вызывается из CI с `curl -L`. Telegram по редиректам не ходит и считает
 * доставку неудачной: «Wrong response from the webhook: 302 Found», обновления
 * копятся в очереди. Обойти нельзя — редирект встроен в то, как Apps Script
 * отдаёт ответ.
 *
 * Поэтому скрипт сам спрашивает Telegram, что нового: getUpdates по таймеру
 * раз в несколько минут. Публичный адрес в приёме заявок больше не участвует вообще,
 * что заодно снимает вопрос анонимного доступа. Цена — задержка до минуты.
 *
 * OCR — штатный, гугловский и бесплатный: Drive распознаёт текст, когда
 * конвертирует картинку в Google Документ. Ключей и сторонних сервисов не надо.
 *
 * ДОСТУП. Кто может присылать заявки, решает белый список Telegram ID в
 * свойстве TG_ALLOWED: чужой напишет боту и не получит ничего, кроме отказа.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   TELEGRAM_TOKEN — токен бота от @BotFather;
 *   TG_ALLOWED     — Telegram ID через запятую, кому можно слать заявки;
 *   TG_OFFSET      — служебное: с какого обновления продолжать опрос.
 ***********************************************************************/

const TG_API = 'https://api.telegram.org/bot';
const TG_DRAFT_TTL = 3600;          // сколько живёт черновик до подтверждения, сек
const TG_PROBLEM_LIMIT = 500;       // на случай, если OCR принесёт полбланка
// Как часто спрашиваем Telegram. Пустой опрос — один запрос и примерно
// секунда: 1440 тиков в сутки укладываются в квоту триггеров с запасом.
// Основной расход даёт распознавание фотографий, а его частота зависит от
// числа заявок, а не от интервала — экономить на тиках смысла нет.
const TG_POLL_MINUTES = 1;
// Apps Script обрывает выполнение на шести минутах. Пачку скриншотов можно
// не успеть разобрать за один заход, поэтому останавливаемся заранее и
// оставляем остальное следующему — недобранные обновления Telegram вернёт снова.
const TG_RUN_BUDGET_MS = 240000;

/* ─────────────────────────────  ОПРОС  ──────────────────────────────── */

/**
 * Забрать у Telegram новые сообщения и обработать. Вызывается таймером раз в
 * минуту; из меню — как «Telegram: проверить сейчас».
 */
function tgPoll() {
  // Прошлый запуск мог ещё разбирать фотографию: распознавание занимает
  // секунды, а таймер тикает каждую минуту. Два разбора одного обновления
  // дали бы две строки в «Реестре».
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Telegram: предыдущий опрос ещё идёт, пропускаю.');
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const offset = Number(props.getProperty('TG_OFFSET') || 0);

    const response = tgApi_('getUpdates', {
      offset: offset,
      timeout: 0,
      allowed_updates: ['message', 'callback_query'],
    });
    if (!response.ok) return;

    const updates = response.result || [];
    const started = Date.now();

    for (const update of updates) {
      // Проверяем бюджет ДО того, как двинуть смещение: иначе обновление,
      // которое мы не начали разбирать, было бы отмечено обработанным
      // и потерялось бы навсегда.
      if (Date.now() - started > TG_RUN_BUDGET_MS) {
        console.log('Telegram: бюджет времени исчерпан, остальное разберу следующим заходом.');
        break;
      }

      // Смещение двигаем ДО обработки и сохраняем сразу. Иначе одно
      // неудачное обновление будет возвращаться при каждом опросе вечно.
      props.setProperty('TG_OFFSET', String(update.update_id + 1));
      try {
        if (update.callback_query) tgOnButton_(update.callback_query);
        else if (update.message) tgOnMessage_(update.message);
      } catch (err) {
        console.error('Telegram: ' + (err && err.stack ? err.stack : err));
        const chat = tgChatOf_(update);
        if (chat) tgSend_(chat, 'Не смог обработать: ' + err);
      }
    }

    // Отметка нужна для диагностики: по ней видно, работает ли таймер вообще.
    // Без неё на вопрос «бот завис или ещё не дошла очередь» ответить нечем.
    props.setProperty('TG_LAST_POLL', String(Date.now()));
  } finally {
    lock.releaseLock();
  }
}

function tgChatOf_(update) {
  if (update.message && update.message.chat) return update.message.chat.id;
  if (update.callback_query && update.callback_query.message) return update.callback_query.message.chat.id;
  return 0;
}

/* ────────────────────────────  СООБЩЕНИЯ  ───────────────────────────── */

function tgOnMessage_(message) {
  const chat = message.chat.id;
  const from = message.from ? message.from.id : 0;

  if (!tgAllowed_(from)) {
    tgSend_(chat, 'Доступ не открыт.\nТвой Telegram ID: <code>' + from + '</code>\n' +
      'Добавь его в свойство скрипта TG_ALLOWED, чтобы присылать заявки.');
    return;
  }

  const fileId = tgPhotoId_(message);
  if (fileId) { tgFromPhoto_(chat, fileId); return; }

  const text = String(message.text || '').trim();
  if (!text || /^\/(start|help)/i.test(text)) { tgHelp_(chat); return; }

  // Ждём значение для правки черновика? Тогда текст — это оно, а не новая заявка.
  const pending = tgEditLoad_(from);
  if (pending) { tgApplyEdit_(chat, from, pending, text); return; }

  tgFromText_(chat, text);
}

/** Заявка с фотографии бланка. */
function tgFromPhoto_(chat, fileId) {
  // Отдельного «распознаю…» нет намеренно: карточка уходит через пару секунд
  // в том же заходе опроса, а на пачке скриншотов такие сообщения удваивают
  // переписку без всякой пользы.
  const text = tgOcr_(tgFileBlob_(fileId));
  const draft = razborParse_(text, knownResponsibles_(), tgSerialPrefix_());

  if (!draft.serial) {
    tgSend_(chat, 'Серийный номер не распознан — записывать нечего.\n\n' +
      'Часто помогает скриншот вместо фото экрана, либо снимок ближе и без бликов.\n' +
      'Либо заведи заявку текстом: серийный номер, дальше проблема.');
    return;
  }

  draft.problem = String(draft.problem || '').slice(0, TG_PROBLEM_LIMIT);
  tgOffer_(chat, draft);
}

/** Заявка, набранная руками: «SC0099123 не включается». */
function tgFromText_(chat, text) {
  const parsed = razborManual_(text, tgSerialPrefix_());
  if (!parsed.serial) { tgHelp_(chat); return; }

  tgOffer_(chat, {
    serial: parsed.serial,
    problem: String(parsed.problem || '').slice(0, TG_PROBLEM_LIMIT),
    responsible: '',
    manual: true,
  });
}

/** Показать черновик и ждать кнопку. */
function tgOffer_(chat, draft) {
  const key = tgDraftSave_(draft);
  tgSend_(chat, tgDraftText_(draft), tgButtons_(key));
}

/** Правка поля черновика: пришедший текст кладём в то поле, которое ждали. */
function tgApplyEdit_(chat, userId, pending, text) {
  tgEditDrop_(userId);

  const draft = tgDraftLoad_(pending.key);
  if (!draft) {
    tgSend_(chat, 'Черновик устарел — пришли фото или заведи заявку заново.');
    return;
  }

  if (pending.field === 'serial') {
    // Введено человеком осознанно — чистим, но не отбраковываем по шаблону.
    const serial = razborCleanSerial_(text);
    if (!serial) { tgSend_(chat, 'Пустой серийный номер — пришли ещё раз.'); return; }
    draft.serial = serial;
  } else {
    draft.problem = text.slice(0, TG_PROBLEM_LIMIT);
  }

  tgDraftPut_(pending.key, draft);
  tgSend_(chat, tgDraftText_(draft), tgButtons_(pending.key));
}

function tgHelp_(chat) {
  tgSend_(chat, [
    'Два способа завести заявку:',
    '',
    '• прислать <b>фото или скриншот</b> бланка — распознаю сам;',
    '• написать <b>текстом</b>: серийный номер, дальше проблема. Например:',
    '<code>SC0099123 не включается</code>',
    '',
    'В обоих случаях сначала покажу, что понял, и дам поправить кнопками.',
  ].join('\n'));
}

/** Самая крупная версия фото либо картинка, присланная файлом. */
function tgPhotoId_(message) {
  if (message.photo && message.photo.length) {
    return message.photo[message.photo.length - 1].file_id;
  }
  if (message.document && /^image\//.test(String(message.document.mime_type || ''))) {
    return message.document.file_id;
  }
  return '';
}

function tgDraftText_(draft) {
  const lines = [
    'Распознал:',
    '',
    'Серийный номер:',
    '<code>' + tgEscape_(draft.serial) + '</code>',
    '',
    'Проблема со слов: ' + (draft.problem ? tgEscape_(draft.problem) : '<i>не распознана</i>'),
  ];

  // ФИО показываем, но в таблицу не пишем: колонка «Ответственный заказчика
  // (забор)» переводит заявку в статус «Принят» и проставляет дату приёма.
  // Это должно происходить, когда железку действительно забрали.
  if (draft.responsible) {
    lines.push('Заявитель: ' + tgEscape_(draft.responsible) + ' <i>(в таблицу не пишу)</i>');
  }

  const twin = tgFindSerial_(draft.serial);
  if (twin) {
    lines.push('', '⚠️ Такой серийный номер уже есть — строка ' + twin + '.');
  }

  lines.push('', draft.manual
    ? 'Не то — поправь кнопками ниже.'
    : 'Сверь серийный номер по символам: в нём OCR ошибается чаще всего. ' +
      'Не сошлось — «✏️ Серийник».');
  return lines.join('\n');
}

function tgButtons_(key) {
  // Префиксы ровно в три символа: обработчик режет их одинаково для всех кнопок.
  return {
    inline_keyboard: [
      [
        { text: '✅ Записать', callback_data: 'ok:' + key },
        { text: '✖️ Отмена', callback_data: 'no:' + key },
      ],
      [
        { text: '✏️ Серийник', callback_data: 'es:' + key },
        { text: '✏️ Проблема', callback_data: 'ep:' + key },
      ],
    ],
  };
}

/* ────────────────────────────  КНОПКИ  ──────────────────────────────── */

function tgOnButton_(query) {
  const chat = query.message ? query.message.chat.id : 0;
  const messageId = query.message ? query.message.message_id : 0;
  const from = query.from ? query.from.id : 0;

  if (!tgAllowed_(from)) {
    tgApi_('answerCallbackQuery', { callback_query_id: query.id, text: 'Доступ не открыт' });
    return;
  }

  const data = String(query.data || '');
  const key = data.slice(3);

  // Кнопки правки: запоминаем, какое поле ждём, и следующее сообщение уйдёт туда.
  if (data.indexOf('es:') === 0 || data.indexOf('ep:') === 0) {
    if (!tgDraftLoad_(key)) {
      tgApi_('answerCallbackQuery', { callback_query_id: query.id, text: 'Черновик устарел' });
      tgEdit_(chat, messageId, 'Черновик устарел — пришли фото или заведи заявку заново.');
      return;
    }
    const field = data.indexOf('es:') === 0 ? 'serial' : 'problem';
    tgEditSave_(from, { key: key, field: field });
    tgApi_('answerCallbackQuery', { callback_query_id: query.id, text: 'Жду значение' });
    tgSend_(chat, field === 'serial'
      ? 'Пришли правильный <b>серийный номер</b> одним сообщением.'
      : 'Пришли <b>проблему со слов</b> одним сообщением.');
    return;
  }

  if (data.indexOf('no:') === 0) {
    tgDraftDrop_(key);
    tgEditDrop_(from);
    tgApi_('answerCallbackQuery', { callback_query_id: query.id, text: 'Отменено' });
    tgEdit_(chat, messageId, 'Отменено, в таблицу ничего не записано.');
    return;
  }

  const draft = tgDraftLoad_(key);
  if (!draft) {
    tgApi_('answerCallbackQuery', { callback_query_id: query.id, text: 'Черновик устарел' });
    tgEdit_(chat, messageId, 'Черновик устарел — пришли фото заново.');
    return;
  }

  // Двойное нажатие кнопки не должно давать две строки.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    tgDraftDrop_(key);
    tgEditDrop_(from);
    const written = tgAppendRequest_(draft);
    tgApi_('answerCallbackQuery', { callback_query_id: query.id, text: 'Записано' });
    tgEdit_(chat, messageId,
      'Записано в «Реестр», № ' + written.id + ' (строка ' + written.row + ').\n\n' +
      'Серийный номер: <code>' + tgEscape_(draft.serial) + '</code>\n' +
      'Проблема со слов: ' + (draft.problem ? tgEscape_(draft.problem) : '—') + '\n\n' +
      'Статус — «Заявка». Ответственного назначишь в таблице, когда железку заберут.');
  } finally {
    lock.releaseLock();
  }
}

/* ─────────────────────────────  ТАБЛИЦА  ────────────────────────────── */

/** Первая строка «Реестра» без серийного номера. */
function tgFirstFreeRow_(sh) {
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  const values = sh.getRange(2, COL.SN, rows, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === '') return i + 2;
  }
  return sh.getMaxRows() + 1;
}

/** Строка с таким же серийником, если он уже заводился. */
function tgFindSerial_(serial) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REESTR);
  if (!sh || sh.getLastRow() < 2) return 0;
  const values = sh.getRange(2, COL.SN, sh.getLastRow() - 1, 1).getValues();
  const want = String(serial).trim().toUpperCase();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() === want) return i + 2;
  }
  return 0;
}

function tgAppendRequest_(draft) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REESTR);
  const row = tgFirstFreeRow_(sh);

  sh.getRange(row, COL.SN).setValue(draft.serial);
  if (draft.problem) sh.getRange(row, COL.PROBLEM).setValue(draft.problem);

  // onEdit — простой триггер и на запись скриптом не срабатывает, поэтому
  // обвязку строки (№, наш ответственный, флажки) ставим руками.
  applyNewRowDefaults_(sh, row);

  return { row: row, id: sh.getRange(row, COL.ID).getValue() };
}

function tgSerialPrefix_() {
  return ensureSetting_('Начало серийного номера заказчика', 'SC');
}

/* ────────────────────────────  ЧЕРНОВИКИ  ───────────────────────────── */

function tgDraftSave_(draft) {
  const key = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  tgDraftPut_(key, draft);
  return key;
}

function tgDraftPut_(key, draft) {
  CacheService.getScriptCache().put('tg:' + key, JSON.stringify(draft), TG_DRAFT_TTL);
}

/**
 * Чего ждём от следующего сообщения этого человека: {key, field}.
 * Состояние привязано к отправителю, а не к чату: в общем чате двое могут
 * править разные черновики одновременно.
 */
function tgEditSave_(userId, state) {
  CacheService.getScriptCache().put('tged:' + userId, JSON.stringify(state), TG_DRAFT_TTL);
}

function tgEditLoad_(userId) {
  const raw = CacheService.getScriptCache().get('tged:' + userId);
  return raw ? JSON.parse(raw) : null;
}

function tgEditDrop_(userId) {
  CacheService.getScriptCache().remove('tged:' + userId);
}

function tgDraftLoad_(key) {
  const raw = CacheService.getScriptCache().get('tg:' + key);
  return raw ? JSON.parse(raw) : null;
}

function tgDraftDrop_(key) {
  CacheService.getScriptCache().remove('tg:' + key);
}

/* ──────────────────────────────  OCR  ───────────────────────────────── */

/**
 * Распознавание текста силами Google: картинка загружается в Drive сразу как
 * Google Документ, и при такой конвертации Drive прогоняет OCR. Документ нужен
 * только ради текста, поэтому сразу уезжает в корзину.
 */
function tgOcr_(blob) {
  const file = Drive.Files.create(
    { name: 'ocr-' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
    blob,
    { ocrLanguage: 'ru' }
  );
  try {
    return DocumentApp.openById(file.id).getBody().getText();
  } finally {
    try { DriveApp.getFileById(file.id).setTrashed(true); } catch (err) {
      console.warn('Не удалось убрать временный документ OCR: ' + err);
    }
  }
}

/* ──────────────────────────  API TELEGRAM  ──────────────────────────── */

function tgToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('не задан TELEGRAM_TOKEN в свойствах скрипта');
  return token;
}

function tgAllowed_(userId) {
  const raw = PropertiesService.getScriptProperties().getProperty('TG_ALLOWED') || '';
  const list = raw.split(/[,\s]+/).filter(String);
  return list.indexOf(String(userId)) !== -1;
}

function tgApi_(method, payload) {
  const response = UrlFetchApp.fetch(TG_API + tgToken_() + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const body = JSON.parse(response.getContentText());
  if (!body.ok) console.warn('Telegram ' + method + ': ' + response.getContentText());
  return body;
}

function tgSend_(chat, text, keyboard) {
  const payload = { chat_id: chat, text: text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = keyboard;
  return tgApi_('sendMessage', payload);
}

function tgEdit_(chat, messageId, text) {
  return tgApi_('editMessageText', {
    chat_id: chat, message_id: messageId, text: text, parse_mode: 'HTML',
  });
}

function tgFileBlob_(fileId) {
  const info = tgApi_('getFile', { file_id: fileId });
  if (!info.ok) throw new Error('Telegram не отдал файл: ' + JSON.stringify(info));
  const url = 'https://api.telegram.org/file/bot' + tgToken_() + '/' + info.result.file_path;
  return UrlFetchApp.fetch(url).getBlob();
}

function tgEscape_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ────────────────────────────  ПОДКЛЮЧЕНИЕ  ─────────────────────────── */

const TG_TRIGGER = 'tgPoll';

/** Пункт меню: включить приём заявок. Разовая операция. */
function tgSetupBot() {
  const props = PropertiesService.getScriptProperties();

  // Про ошибки здесь throw, а не ui_(): ui_ глушит исключения в try/catch —
  // правильно для рядового пункта меню, губительно для настройки. Запусти
  // функцию из редактора, где диалог показать не в чем, и она молча ничего
  // не сделает. Исключение видно в обоих местах.
  if (!props.getProperty('TELEGRAM_TOKEN')) {
    throw new Error('Нет свойства скрипта TELEGRAM_TOKEN — это токен бота от @BotFather. ' +
      'Настройки проекта → Свойства скрипта.');
  }

  // Пока у бота висит вебхук, getUpdates отвечает отказом: Telegram отдаёт
  // обновления либо туда, либо сюда, но не в оба места сразу.
  const dropped = tgApi_('deleteWebhook', { drop_pending_updates: false });
  if (!dropped.ok) throw new Error('Не вышло снять вебхук: ' + JSON.stringify(dropped));

  // Старые триггеры сносим и заводим заново: у существующего триггера интервал
  // не поменять, а пункт меню должен уметь применить новое значение
  // TG_POLL_MINUTES, а не тихо оставить прежнее.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TG_TRIGGER) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(TG_TRIGGER).timeBased().everyMinutes(TG_POLL_MINUTES).create();

  tgSerialPrefix_();   // заодно заводим параметр в «Настройках», если его нет

  // Ссылка-кнопка для телефона. В мобильном приложении Google Таблиц
  // пользовательских меню нет, поэтому «проверить сейчас» с телефона иначе
  // не вызвать. Токен генерируем один раз и держим в свойствах.
  if (!props.getProperty('TG_POKE_TOKEN')) {
    props.setProperty('TG_POKE_TOKEN', Utilities.getUuid());
  }
  const base = props.getProperty('TG_WEBAPP_URL');
  const poke = base ? base + '?poll=' + props.getProperty('TG_POKE_TOKEN') : '';

  const allowed = props.getProperty('TG_ALLOWED');
  const message = 'Приём заявок включён: проверяю Telegram раз в ' + TG_POLL_MINUTES + ' мин.\n\n' +
    (poke ? 'Ссылка «забрать сейчас» — сохрани на телефоне:\n' + poke + '\n\n' : '') + (allowed
    ? 'Разрешены ID: ' + allowed
    : 'Осталось разрешить отправителей: напиши боту — он ответит твоим ID, ' +
      'добавь его в свойство скрипта TG_ALLOWED.');
  console.log(message);
  ui_(message);
}

/** Пункт меню: что происходит с приёмом заявок. Первое, куда смотреть, если бот молчит. */
function tgStatus() {
  const props = PropertiesService.getScriptProperties();
  const lines = [];

  const running = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === TG_TRIGGER;
  });
  lines.push('Опрос раз в ' + TG_POLL_MINUTES + ' мин: ' +
    (running ? 'включён' : 'ВЫКЛЮЧЕН — запусти «Telegram: включить приём заявок»'));

  const info = tgApi_('getWebhookInfo', {});
  if (info.ok) {
    const url = String((info.result && info.result.url) || '');
    // Вебхук и опрос несовместимы: пока адрес задан, getUpdates не работает.
    lines.push('Вебхук: ' + (url ? 'ЗАДАН (' + url + ') — мешает опросу, сними его' : 'снят, как и надо'));
  } else {
    lines.push('Telegram не ответил: ' + JSON.stringify(info));
  }

  const last = Number(props.getProperty('TG_LAST_POLL') || 0);
  if (!last) {
    lines.push('Последний опрос: НИ РАЗУ — таймер ещё не отработал');
  } else {
    const minutesAgo = Math.round((Date.now() - last) / 60000);
    const clock = Utilities.formatDate(new Date(last),
      SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'dd.MM HH:mm');
    lines.push('Последний опрос: ' + clock + ' (' + minutesAgo + ' мин назад)' +
      (minutesAgo > TG_POLL_MINUTES * 3 ? ' — ТАЙМЕР ОТСТАЁТ' : ''));
  }

  lines.push('Обработано обновлений до: ' + (props.getProperty('TG_OFFSET') || '—'));
  lines.push('Разрешённые отправители: ' + (props.getProperty('TG_ALLOWED') || 'никого — заполни TG_ALLOWED'));

  ui_(lines.join('\n'));
}

/** Пункт меню: не ждать таймер, забрать сообщения сейчас. */
function tgPollNow() {
  tgPoll();
  ui_('Проверил Telegram.');
}


/**
 * Страница по ссылке «забрать сейчас»: опрашивает Telegram немедленно.
 *
 * Зачем. Пункт меню «Telegram: проверить сейчас» есть только в таблице на
 * компьютере — мобильное приложение Google Таблиц пользовательских меню не
 * показывает. А ускорить бота из самого бота невозможно: на опросе он узнаёт
 * о любом сообщении, включая команду «поторопись», только когда сам спросит
 * Telegram. Ссылка обходит и то, и другое: она бьёт прямо в скрипт.
 */
function tgPoke_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('TG_POKE_TOKEN');

  if (!expected || String(token) !== expected) {
    return tgPokePage_('Ссылка не опознана', 'Проверь адрес — токен не совпал.', '');
  }

  tgPoll();

  const clock = Utilities.formatDate(new Date(),
    SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'HH:mm:ss');
  return tgPokePage_('Забрал',
    'Telegram опрошен в ' + clock + '. Карточки, если что-то пришло, уже в боте.', expected);
}

/** Простая страница под палец: крупно и с кнопкой повтора. */
function tgPokePage_(title, text, token) {
  const again = token
    ? '<p><a class="btn" href="?poll=' + token + '">Забрать ещё раз</a></p>'
    : '';
  const html =
    '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;text-align:center}' +
    'h1{font-size:22px;margin:0 0 12px}p{color:#444}' +
    '.btn{display:inline-block;margin-top:16px;padding:14px 28px;background:#1a73e8;' +
    'color:#fff;text-decoration:none;border-radius:8px}</style>' +
    '<h1>' + title + '</h1><p>' + text + '</p>' + again;

  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
