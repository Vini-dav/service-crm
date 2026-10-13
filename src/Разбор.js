/***********************************************************************
 * Сервис — разбор распознанного текста заявки.
 *
 * Сюда приходит текст, который Drive вернул после OCR картинки, отсюда
 * выходят три поля: серийный номер, ответственный от заказчика и проблема
 * со слов. Файл намеренно не знает ни про таблицу, ни про Telegram, ни про
 * Drive — только строки на входе и объект на выходе. Поэтому правила разбора
 * покрыты обычными тестами (tests/разбор.test.mjs) и гоняются в CI: править
 * их придётся часто, а проверять руками через фотографирование бланка дорого.
 *
 * Что усложняет разбор:
 *   • В бланке ДВА серийных номера — оборудования и блока питания. Берём
 *     первый и обязаны не спутать со вторым.
 *   • Значение может стоять и в той же строке, что подпись, и в следующей:
 *     OCR разбирает ячейки таблицы как придётся.
 *   • Подпись «ПОДРОБНОЕ описание неисправности с описанием процесса
 *     диагностики:» переносится на две строки.
 *   • В серийниках OCR подставляет кириллические двойники латинских букв:
 *     «С» вместо «C», «В» вместо «B». Глазами не отличить, для таблицы это
 *     разные строки.
 *   • Шаблоны здесь пишутся классом [а-яё], а не \\w: в JavaScript \\w — это
 *     [A-Za-z0-9_], кириллицу он не покрывает, и «описани\\w*» молча не
 *     совпадает с «описание». По той же причине \\b не годится как граница
 *     русского слова.
 *   • Длина серийника не постоянна, зато у заказчика есть узнаваемое начало
 *     («SC»). Оно и служит главным признаком — задаётся в «Настройках»,
 *     а не в коде: появится второй заказчик, поменяется строка в таблице.
 ***********************************************************************/

/** Кириллические буквы, неотличимые от латинских. Для серийников — только вред. */
const HOMOGLYPHS = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
  'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ѕ': 'S',
};

/** Строки текста: без пустых, без двойных пробелов, без неразрывных. */
function razborLines_(text) {
  return String(text || '')
    .replace(/ /g, ' ')
    .split(/\r?\n/)
    .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
    .filter(function (s) { return s !== ''; });
}

/** Хвост строки после подписи: «ФИО: Иванова А.А.» → «Иванова А.А.» */
function razborTail_(line, label) {
  const m = line.match(label);
  if (!m) return '';
  return line.slice(m.index + m[0].length).replace(/^[\s:.\-—]+/, '').trim();
}

/**
 * Кириллические двойники → латиница.
 *
 * Замена делается только если после неё от кириллицы ничего не остаётся:
 * значит перед нами латинский серийник, который OCR прочитал русскими
 * буквами. Если в токене есть буквы без латинского двойника (Д, Ж, Ы),
 * это настоящий русский текст — трогать его нельзя, иначе «НЕСТАНДАРТНЫЙ»
 * превратится в кашу из латиницы и кириллицы.
 */
function razborDelatin_(token) {
  const mapped = token.replace(/[А-ЯЁІЅ]/g, function (ch) { return HOMOGLYPHS[ch] || ch; });
  return /[А-ЯЁІЅ]/.test(mapped) ? token : mapped;
}

/**
 * Похоже ли на серийный номер.
 *
 * Два режима. Если токен начинается с префикса заказчика (это
 * «SC»), верим ему почти на слово: префикс — сильный признак, длина у таких
 * серийников гуляет. Без префикса требуем что-то заведомо длинное, иначе в
 * серийники запишется «PC» из «PC Office» или любой артикул из бланка.
 */
function razborIsSerial_(token, prefix) {
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(token) || !/\d/.test(token)) return false;
  if (prefix && token.indexOf(prefix) === 0) return token.length >= prefix.length + 4;
  return token.length >= 8;
}

/** Токены строки, приведённые к виду серийника. */
function razborTokens_(line, prefix) {
  return String(line || '').split(/\s+/)
    .map(function (raw) { return razborDelatin_(raw.toUpperCase().replace(/[^0-9A-ZА-ЯЁЅІ-]/g, '')); })
    .filter(function (token) { return razborIsSerial_(token, prefix); });
}

/**
 * Серийный номер оборудования.
 *
 * Порядок поиска. Сначала рядом с подписью «Серийный номер», пропуская строки
 * про блок питания: в бланке есть отдельное поле «Серийный номер Блока
 * питания», оно идёт ниже, и без явного отсева разбор возьмёт именно его.
 * Внутри найденного предпочитаем токен с префиксом заказчика.
 *
 * Если у подписи ничего не нашлось — ищем токен с префиксом по всему тексту.
 * Это надёжно ровно потому, что серийник блока питания префикса не имеет.
 */
function razborSerial_(lines, prefix) {
  const LABEL = /серийн[а-яё]*\s+номер/i;
  const POWER = /(блок[а-яё]*\s+питани|(^|[^а-яё])бп([^а-яё]|$))/i;
  const fallback = [];

  for (let i = 0; i < lines.length; i++) {
    if (!LABEL.test(lines[i]) || POWER.test(lines[i])) continue;

    // Значение либо в этой же строке после подписи, либо в следующих.
    const candidates = [razborTail_(lines[i], LABEL)].concat(lines.slice(i + 1, i + 3));
    for (const candidate of candidates) {
      for (const token of razborTokens_(candidate, prefix)) {
        if (prefix && token.indexOf(prefix) === 0) return token;
        fallback.push(token);
      }
    }
  }

  if (prefix) {
    for (const line of lines) {
      if (POWER.test(line)) continue;
      for (const token of razborTokens_(line, prefix)) {
        if (token.indexOf(prefix) === 0) return token;
      }
    }
  }

  return fallback.length ? fallback[0] : '';
}

/**
 * Ответственный от заказчика. Распознанное ФИО сверяется со справочником:
 * в «Реестре» на этой колонке стоит выпадающий список, и произвольная строка
 * там будет ошибкой проверки данных. Сверяем по фамилии — инициалы OCR путает
 * чаще всего («С.В.» легко становится «C.B.»).
 */
function razborResponsible_(lines, known) {
  const list = (known || []).filter(String);
  if (list.length === 0) return '';

  const surname = function (s) {
    return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^а-я\s-]/g, '').trim().split(/\s+/)[0] || '';
  };

  // Сначала — строка с подписью «ФИО».
  const ФИО = /(^|[^а-яёa-z])фио(?![а-яёa-z])/i;
  const labelled = lines.filter(function (l) { return ФИО.test(l); })
    .map(function (l) { return razborTail_(l, ФИО); });

  for (const value of labelled) {
    const want = surname(value);
    if (!want) continue;
    for (const item of list) if (surname(item) === want) return item;
  }

  // Подписи нет или OCR её потерял — ищем известную фамилию в любом месте текста.
  const haystack = lines.join(' ').toLowerCase().replace(/ё/g, 'е');
  for (const item of list) {
    const want = surname(item);
    if (want && haystack.indexOf(want) !== -1) return item;
  }
  return '';
}

/**
 * Проблема со слов заказчика. Подпись в бланке длинная и переносится на две
 * строки, поэтому текст собираем после слова «диагностики» (или сразу после
 * подписи, если OCR перенос потерял) и до следующего поля бланка.
 */
function razborProblem_(lines) {
  const LABEL = /описани[а-яё]*\s+неисправност/i;
  const CONT = /диагностик[а-яё]*\s*:?/i;
  const STOP = /(серийн[а-яё]*\s+номер|модель\s+диска|производител|оперативн[а-яё]*\s+памят|^модель|^город|^заказчик)/i;

  for (let i = 0; i < lines.length; i++) {
    if (!LABEL.test(lines[i])) continue;

    let start = i;
    let head = razborTail_(lines[i], LABEL);
    // Подпись растянута на две строки — ищем её продолжение рядом.
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      if (CONT.test(lines[j])) { start = j; head = razborTail_(lines[j], CONT); break; }
    }

    const parts = [];
    if (head) parts.push(head);
    for (let j = start + 1; j < lines.length && parts.length < 4; j++) {
      if (STOP.test(lines[j])) break;
      parts.push(lines[j]);
    }
    const problem = parts.join(' ').replace(/^[\s:.\-—]+/, '').trim();
    if (problem) return problem;
  }
  return '';
}

/**
 * Главная точка разбора.
 *   known  — список ответственных из «Справочников» (колонка A);
 *   prefix — начало серийников заказчика из «Настроек» (например, «SC»).
 */
function razborParse_(text, known, prefix) {
  const lines = razborLines_(text);
  const pref = String(prefix || '').toUpperCase().trim();
  return {
    serial: razborSerial_(lines, pref),
    responsible: razborResponsible_(lines, known),
    problem: razborProblem_(lines),
  };
}

/* ───────────────────────────  РУЧНОЙ ВВОД  ──────────────────────────── */

/**
 * Нормализация серийника, введённого человеком: регистр, лишние символы,
 * кириллические двойники. Проверку «похоже ли на серийник» здесь НЕ делаем:
 * человек ввёл осознанно, и заявка от другого заказчика с непривычным номером
 * должна проходить. Отсев нужен машине, которая гадает по распознанному тексту.
 */
function razborCleanSerial_(text) {
  return razborDelatin_(String(text || '').toUpperCase().replace(/[^0-9A-ZА-ЯЁЅІ-]/g, ''));
}

/**
 * Заявка, набранная в Telegram руками: «SCA10100510L122318286 не включается»
 * или те же две части на отдельных строках. Первый токен, похожий на серийник,
 * становится номером, остальное — проблемой со слов.
 */
function razborManual_(text, prefix) {
  const pref = String(prefix || '').toUpperCase().trim();
  const lines = razborLines_(text);

  for (let i = 0; i < lines.length; i++) {
    for (const raw of lines[i].split(/\s+/)) {
      const token = razborCleanSerial_(raw);
      if (!razborIsSerial_(token, pref)) continue;

      // Проблема — весь остальной текст: хвост этой строки плюс следующие.
      const rest = lines[i].split(/\s+/)
        .filter(function (word) { return razborCleanSerial_(word) !== token; })
        .join(' ');
      const problem = [rest].concat(lines.slice(i + 1)).join(' ').replace(/\s+/g, ' ').trim();
      return { serial: token, problem: problem };
    }
  }
  return { serial: '', problem: '' };
}
