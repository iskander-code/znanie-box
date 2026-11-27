// Разбор темы библиотеки для урока: главное, термины, формулы, вопросы «Проверь себя».
// Без нейросети и без интернета — из текста темы.

export const sentencesOf = (text) => (text.match(/[^.!?]+[.!?]+/g) || [text]).map((x) => x.trim()).filter(Boolean);

/**
 * Разбор параграфа на части для урока: главное, термины, формулы и вопросы «Проверь себя».
 * Всё вычисляется из текста темы, поэтому работает для всех 700 тем и без нейросети.
 */
export function docStructure(doc) {
  const sents = sentencesOf(doc.text);
  const terms = [];
  sents.forEach((x, i) => {
    // «Кислород — газ…», «Фотосинтез — это…», «… называют …», «… называется …»
    let m = x.match(/^([А-ЯЁA-Z][А-Яа-яЁёA-Za-z0-9₀-₉ -]{2,40}?)\s+—\s+(?:это\s+)?(.{8,})$/);
    if (m && !/^\d/.test(m[1]) && !/^(если|когда|чем)/i.test(m[1])) { terms.push({ term: m[1].trim(), def: m[2].replace(/[.!?]+$/, '') }); return; }
    m = x.match(/^(.{6,80}?)\s+(?:называют|называется|называются)\s+([^,.]{3,50})/i);
    if (!m) return;
    const term = m[2].trim().replace(/^[«"]|[»"]$/g, '');
    if (/(ом|ем|ой|ей|ами|ями)$/i.test(term.split(/\s+/)[0])) { // «называют фотосинтезом» — термин в творительном падеже: берём основу
      const base = term.replace(/(ом|ем|ой|ей|ами|ями)(?=\s|$)/i, '');
      // определение — предыдущее предложение, если в этом стоит «Этот процесс», «Это», «Он»…
      const def = /^(этот|эта|это|эти|он|она|они)/i.test(m[1]) ? (sents[i - 1] || m[1]) : m[1];
      terms.push({ term: base.charAt(0).toUpperCase() + base.slice(1), def: def.replace(/[.!?]+$/, '') });
    } else {
      terms.push({ term: term.charAt(0).toUpperCase() + term.slice(1), def: m[1].trim() });
    }
  });
  const formulas = [...new Set((doc.text.match(/(?:[A-Za-zА-Яа-я][A-Za-z0-9₀-₉²³]*|\d+)\s*=\s*[^,;.!?]*[A-Za-z0-9²³√π][^,;.!?]*/g) || [])
    .map((f) => f.trim().replace(/\s+(—|поэтому|значит|то есть).*$/i, ''))
    .filter((f) => /[A-Za-z]/.test(f) && f.length <= 40))].slice(0, 4);
  const blanks = sents
    .map((x) => ({ x, word: (x.match(/[А-Яа-яЁё]{7,}/g) || []).filter((w) => !doc.title.toLowerCase().includes(w.toLowerCase().slice(0, 5))).sort((a, b) => b.length - a.length)[0] }))
    .filter((c) => c.word);
  const questions = blanks.slice(0, 2).map((c) => ({ q: `Вставь пропущенное слово: «${c.x.replace(c.word, '_____')}»`, a: c.word }));
  const cause = sents.find((x) => /(поэтому|потому что|из-за|благодаря|приводит|вызывает|чем больше|чем меньше|если)/i.test(x));
  if (cause) questions.push({ q: 'Объясни своими словами: почему так происходит?', a: cause });
  questions.push({ q: `Расскажи своими словами, о чём тема «${doc.title}», в 2–3 предложениях.`, a: sents.slice(0, 2).join(' ') });
  return { main: sents[0] || doc.text, terms: terms.slice(0, 4), formulas, questions: questions.slice(0, 4) };
}

