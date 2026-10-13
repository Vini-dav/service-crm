/***********************************************************************
 * Сервис — хук развёртывания.
 *
 * Зачем. `clasp push` заливает КОД, но ничего не выполняет. Часть разметки
 * таблицы живёт не в ячейках, а в коде: формула статуса и цветовые правила
 * собираются из конфига STATUSES. Поменял STATUSES, залил — в таблице по-
 * прежнему старая формула, пока кто-то не нажмёт «Обновить статусы» в меню.
 * Этот файл закрывает разрыв: после успешной заливки CI дёргает веб-хук,
 * и таблица приводит себя в соответствие с кодом сама.
 *
 * Безопасность. Веб-приложение развёрнуто с доступом ANYONE_ANONYMOUS (так
 * работает мобильная форма диагностики), поэтому POST может прислать кто
 * угодно, кто знает адрес. Защита — общий секрет:
 *
 *   1. в Свойствах скрипта задаётся DEPLOY_TOKEN
 *      (Apps Script → Настройки проекта → Свойства скрипта);
 *   2. тот же токен лежит в секретах GitHub;
 *   3. без совпадения хук не делает НИЧЕГО.
 *
 * Если свойство не задано — хук отвечает отказом. Отключён по умолчанию:
 * забыть настроить безопаснее, чем забыть защитить.
 *
 * Разрушительных действий здесь нет намеренно. reset() удаляет заявки, и его
 * в белом списке быть не может: автоматика не должна иметь права стереть
 * данные, даже с правильным токеном.
 ***********************************************************************/

/** Что разрешено запускать снаружи. Всё, чего здесь нет, — запрещено. */
function deployAction_(name) {
  switch (name) {
    // Перечитать конфиг STATUSES: формула статуса, цвета, легенда. Данные не трогает.
    case 'refresh':
      refreshStatuses();
      return 'статусы обновлены (формула, цвета, легенда)';

    // Снять копию таблицы на Google Диск — на случай рискованного деплоя.
    case 'backup':
      return 'копия: ' + backupBook_('перед деплоем').getName();

    // Проверка связи: ничего не меняет, только отвечает.
    case 'ping':
      return 'на связи, таблица «' + SpreadsheetApp.getActiveSpreadsheet().getName() + '»';

    default:
      return null;
  }
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return deployJson_({ ok: false, error: 'тело запроса — не JSON' });
  }

  const expected = PropertiesService.getScriptProperties().getProperty('DEPLOY_TOKEN');
  if (!expected) {
    return deployJson_({ ok: false, error: 'хук не настроен: в свойствах скрипта нет DEPLOY_TOKEN' });
  }

  if (!deployTokenOk_(String(body.token || ''), expected)) {
    console.warn('Хук развёртывания: отказано, токен не совпал.');
    return deployJson_({ ok: false, error: 'отказано' });
  }

  const action = String(body.action || 'refresh');
  try {
    const result = deployAction_(action);
    if (result === null) return deployJson_({ ok: false, error: 'неизвестное действие: ' + action });
    console.log('Хук развёртывания: ' + action + ' — ' + result);
    return deployJson_({ ok: true, action: action, result: result });
  } catch (err) {
    console.error('Хук развёртывания: ' + action + ' упало — ' + err);
    return deployJson_({ ok: false, action: action, error: String(err) });
  }
}

/**
 * Сравнение токенов за постоянное время: обычное === выходит на первом
 * несовпавшем символе, и по времени ответа секрет можно подбирать посимвольно.
 */
function deployTokenOk_(given, expected) {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function deployJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
