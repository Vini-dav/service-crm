// Глобальное окружение Google Apps Script для ESLint.
//
// В npm-пакете globals набора Apps Script нет, а тянуть ради него плагин незачем:
// список сервисов конечный и меняется раз в пятилетку. Держим его здесь явно —
// одна зависимость меньше, и видно, что именно считается «известным именем».
export const APPS_SCRIPT_SERVICES = Object.fromEntries(
  [
    // Таблицы, документы, диск
    'SpreadsheetApp', 'DocumentApp', 'DriveApp', 'SlidesApp', 'FormApp',
    // Почта, календарь, пользователи
    'GmailApp', 'MailApp', 'CalendarApp', 'ContactsApp', 'GroupsApp', 'Session',
    // Служебное
    'ScriptApp', 'PropertiesService', 'CacheService', 'LockService',
    'UrlFetchApp', 'Utilities', 'Logger', 'console', 'Browser',
    // Веб-приложения (нужно для doGet/doPost)
    'HtmlService', 'ContentService',
    // Прочее
    'LanguageApp', 'Maps', 'Charts', 'XmlService', 'Jdbc', 'CardService',
    // Продвинутые сервисы (включаются в манифесте)
    'Sheets', 'Drive', 'Docs', 'Gmail', 'Calendar', 'People', 'Tasks',
    'AdminDirectory', 'BigQuery', 'Analytics',
  ].map((name) => [name, 'readonly'])
);

// Имена, объявленные в файле на верхнем уровне: function f(), const X = …
// Нужны, чтобы описать ESLint'у общую область видимости Apps Script
// (подробности — в комментарии в eslint.config.mjs).
export function topLevelNames(code) {
  const TOP_LEVEL =
    /^(?:function\s+([A-Za-zА-Яа-яЁё_$][\w$А-Яа-яЁё]*)|(?:const|let|var)\s+([A-Za-zА-Яа-яЁё_$][\w$А-Яа-яЁё]*)\s*=)/gm;
  const names = [];
  for (const m of code.matchAll(TOP_LEVEL)) names.push(m[1] || m[2]);
  return names;
}
