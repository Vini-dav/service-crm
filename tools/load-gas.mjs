// Загрузка файлов Apps Script в песочницу Node для тестов.
//
// Файлы проекта — обычные скрипты в общей области видимости, без import/export:
// в Apps Script модулей нет. Поэтому подключить их через import нельзя, а
// добавлять экспорт ради тестов — значит писать код, который в бою не работает.
//
// Вместо этого файл выполняется в контексте vm: объявления `function` на верхнем
// уровне становятся свойствами глобального объекта песочницы, и до них можно
// дотянуться. Так тестируется ровно тот код, который уезжает в таблицу.
//
// Сервисы Google (SpreadsheetApp, DriveApp…) сюда не подставляются намеренно:
// тестируем чистую логику. Файлу, которому нужен SpreadsheetApp, в тестах не место.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadGas(files) {
  const context = vm.createContext({ console });
  for (const file of files) {
    vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  }
  return {
    /** Достать функцию по имени: `const f = gas.fn('razborParse_')`. */
    fn: (name) => vm.runInContext(name, context),
  };
}
