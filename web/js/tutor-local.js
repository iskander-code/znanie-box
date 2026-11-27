// Наставник «Сова» без нейросети: поиск по библиотеке + сократические шаблоны.
// Используется на статическом сайте (GitHub Pages) и как запасной режим,
// когда на коробке не запущена модель.

const STOP = new Set('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между почему зачем расскажи объясни скажи такое это сколько какой какая какие каким каков такие такая тому будут равна равно равен бывает значит делать нужно хочу знать'.split(' '));

export function stem(word) {
  const w = word.toLowerCase().replace(/ё/g, 'е');
  return w.length > 6 ? w.slice(0, 6) : w.length > 4 ? w.slice(0, w.length - 1) : w;
}

export function tokens(text) {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}

export function splitSentences(text) {
  return text.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()) || [text];
}

export class Library {
  constructor(docs) {
    this.docs = docs;
    this.chunks = [];
    for (const d of docs) {
      const sents = splitSentences(d.text);
      for (let i = 0; i < sents.length; i += 2) {
        const text = sents.slice(i, i + 2).join(' ');
        this.chunks.push({ doc: d, text, toks: tokens(text + ' ' + d.title) });
      }
    }
    const df = new Map();
    this.chunks.forEach((c) => new Set(c.toks).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
    const N = this.chunks.length;
    this.idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))]));
    // Слово, которого нет нигде в библиотеке, — сильный знак, что тема не покрыта.
    this.unknownIdf = 1.5 * Math.log(1 + (N + 0.5) / 0.5);
    this.avgLen = this.chunks.reduce((a, c) => a + c.toks.length, 0) / N;
  }

  // BM25 по фрагментам из двух предложений.
  search(query, k = 4) {
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const w = (t) => this.idf.get(t) ?? this.unknownIdf;
    const totalW = q.reduce((a, t) => a + w(t), 0);
    const scored = this.chunks.map((c) => {
      let s = 0;
      for (const t of q) {
        const tf = c.toks.filter((x) => x === t).length;
        if (!tf) continue;
        s += this.idf.get(t) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * c.toks.length / this.avgLen));
      }
      // matched — доля «веса» слов вопроса, найденных во фрагменте (редкие слова важнее).
      return { ...c, score: s, matched: q.filter((t) => c.toks.includes(t)).reduce((a, t) => a + w(t), 0) / totalW };
    });
    return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k)
      .map(({ doc, text, score, matched }) => ({ title: doc.title, docId: doc.id, graph: doc.graph || null, text, score, matched }));
  }
}

export const RELEVANT = (f) => f.length > 0 && (f[0].relevant ?? (f[0].score >= 1.5 && f[0].matched >= 0.45));

function questionKind(msg) {
  const m = msg.toLowerCase();
  if (/почему|зачем|из-за чего|причин/.test(m)) return 'why';
  if (/что будет|что если|что произойд|если .*то|как изменит|к чему привед/.test(m)) return 'whatif';
  if (/что такое|кто такой|что значит|определени/.test(m)) return 'define';
  return 'other';
}

const LEADING = {
  why: 'Давай найдём причину вместе. В этом фрагменте она названа прямо — какие слова на неё указывают?',
  whatif: 'Попробуй сначала предсказать сам: что изменится первым, а что — потом? А затем проверь себя на схеме «Что будет, если…».',
  define: 'Как бы ты объяснил это своими словами младшему брату или сестре? Начни с того, что уже знаешь, и сверься с фрагментом.',
  other: 'Что ты уже знаешь об этом? Прочитай фрагмент и подумай, какая мысль в нём главная.',
};

/**
 * Ответ без нейросети. level: 0 — подсказка, 1 — наводящий вопрос с фрагментом, 2 — полный ответ.
 * Возвращает { text, sources, graph }.
 */
export function localAnswer({ message, mode, level, fragments }) {
  if (!RELEVANT(fragments)) {
    return {
      text: 'В моей библиотеке нет ответа на этот вопрос. Попробуй сказать иначе или спроси учителя. В библиотеке 400 тем по истории Казахстана, физике, алгебре и геометрии. А если включить нейросеть (ссылка «как включить» в шапке), я смогу отвечать и на другие вопросы.',
      sources: [], graph: null,
    };
  }
  const top = fragments[0];
  const graph = fragments.find((f) => f.graph)?.graph || null;
  const sources = [...new Map(fragments.slice(0, 2).map((f) => [f.title, f])).values()];

  if (mode === 'explain' || level >= 2) {
    const body = fragments.slice(0, 2).map((f) => f.text).join(' ');
    return { text: `${body}\n\nПроверь себя: перескажи это одним предложением своими словами.`, sources, graph };
  }
  if (mode === 'simpler') {
    const sents = fragments.slice(0, 2).flatMap((f) => splitSentences(f.text)).sort((a, b) => a.length - b.length);
    return { text: `Если коротко: ${sents[0]}`, sources: [top], graph };
  }
  const kind = questionKind(message);
  if (level === 0) {
    const q = new Set(tokens(message));
    const best = splitSentences(top.text)
      .map((s) => ({ s, hit: tokens(s).filter((t) => q.has(t)).length }))
      .sort((a, b) => b.hit - a.hit)[0].s;
    return { text: `${LEADING[kind]}\n\nПодсказка в источнике «${top.title}»: «${best}»`, sources: [top], graph };
  }
  return {
    text: `Вот фрагмент целиком: «${top.text}»\n\nКакая связь между тем, что здесь написано, и твоим вопросом? Попробуй ответить сам, а потом нажми «Покажи ответ».`,
    sources: [top], graph,
  };
}

// Режим «Проверь меня»: вопрос с пропуском ключевого слова.
export function makeQuiz(fragments) {
  if (!RELEVANT(fragments)) return null;
  const sents = fragments.flatMap((f) => splitSentences(f.text).map((s) => ({ s, f })));
  const cands = sents.map(({ s, f }) => {
    const words = s.match(/[А-Яа-яЁё]{7,}/g) || [];
    return { s, f, word: words.sort((a, b) => b.length - a.length)[0] };
  }).filter((c) => c.word);
  if (!cands.length) return null;
  const c = cands[0];
  return { question: c.s.replace(c.word, '_____'), answer: c.word, source: c.f };
}

export function checkQuiz(quiz, reply) {
  const ok = tokens(reply).includes(stem(quiz.answer));
  return ok
    ? `Верно! Правильное слово — «${quiz.answer}». Можешь объяснить, почему именно оно?`
    : `Пока не то. Правильный ответ — «${quiz.answer}». Полное предложение: «${quiz.question.replace('_____', quiz.answer)}»`;
}

// ---------- проверка прогноза словами без нейросети («Что будет, если…») ----------
const UP_WORDS = /^(вырас|выраст|увелич|больш|рост|подним|подним|усил|повыс|прибав|расш|ускор|улучш|станет больше|прибыв)/;
const DOWN_WORDS = /^(упад|упаде|уменьш|меньш|сократ|погиб|исчез|умр|сниз|нечег|пересох|обмел|высох|ослаб|разруш|пропад|сокращ|ухудш|паден|снижен|гибел)/;
const wordStem = (w) => w.slice(0, Math.max(4, Math.min(5, w.length - 2)));

/**
 * Сравнивает прогноз ученика, написанный словами, с результатом симуляции.
 * graph — схема, total — {узел: изменение}, changes — что ученик изменил сам,
 * chain(id) — цепочка «почему» для узла (строка). Возвращает разбор в Markdown.
 */
export function checkPredictionText(text, graph, total, changes, chain = () => '') {
  const words = (String(text).toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z0-9]+/g) || []);
  const trendOf = (id) => ((total[id] || 0) > 0.05 ? 'up' : (total[id] || 0) < -0.05 ? 'down' : 'same');
  const found = [];
  const used = new Set();
  for (const n of graph.nodes) {
    if (n.id in changes) continue;
    const ns = new Set((n.label.toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z0-9]+/g) || []).filter((w) => w.length > 3).map(wordStem));
    const hit = words.findIndex((w, i) => !used.has(i) && w.length > 3 && ns.has(wordStem(w)));
    if (hit < 0) continue;
    used.add(hit);
    // направление — ближайшее слово «вырастет / упадёт / погибнут…» в окне вокруг названия фактора
    let dir = null;
    for (let d = 1; d <= 4 && !dir; d++) {
      for (const j of [hit + d, hit - d]) {
        const w = words[j];
        if (!w || dir) continue;
        if (DOWN_WORDS.test(w)) dir = 'down';
        else if (UP_WORDS.test(w)) dir = 'up';
      }
    }
    found.push({ id: n.id, label: n.label, dir, actual: trendOf(n.id) });
  }
  const label = (id) => graph.nodes.find((n) => n.id === id)?.label || id;
  const right = found.filter((f) => f.dir && f.dir === f.actual);
  const wrong = found.filter((f) => f.dir && f.actual !== 'same' && f.dir !== f.actual);
  const still = found.filter((f) => f.dir && f.actual === 'same');
  const word = { up: 'растёт', down: 'уменьшается', same: 'не меняется' };
  const changed = Object.keys(total).filter((id) => !(id in changes) && trendOf(id) !== 'same')
    .sort((a, b) => Math.abs(total[b]) - Math.abs(total[a]));
  const missed = changed.filter((id) => !found.some((f) => f.id === id));
  const out = [];
  if (!found.length) {
    out.push('Я не нашла в твоём прогнозе названий факторов из схемы. Попробуй написать так: «*уровень моря упадёт, потому что…*» — тогда я смогу сравнить прогноз с результатом.');
  } else {
    if (right.length) out.push(`**Верно!** Ты правильно предсказал: ${right.map((f) => `${f.dir === 'up' ? '▲' : '▼'} «${f.label}»`).join(', ')}.`);
    for (const f of wrong.slice(0, 2)) out.push(`**Посмотри ещё раз:** «${f.label}» на схеме ${word[f.actual]}, а ты думал, что ${f.dir === 'up' ? 'вырастет' : 'уменьшится'}. ${chain(f.id) ? `Цепочка: ${chain(f.id)}.` : ''}`);
    for (const f of still.slice(0, 1)) out.push(`«${f.label}» по схеме не меняется: изменение до него не дошло или оказалось слишком слабым.`);
    const noDir = found.filter((f) => !f.dir);
    if (noDir.length) out.push(`Ты упомянул ${noDir.map((f) => `«${f.label}»`).join(', ')}, но не написал, вырастет это или уменьшится.`);
  }
  if (missed.length) out.push(`**Ты не упомянул:** ${missed.slice(0, 3).map((id) => `${trendOf(id) === 'up' ? '▲' : '▼'} «${label(id)}»`).join(', ')}.`);
  const ask = missed[0] || wrong[0]?.id;
  out.push(ask ? `**Вопрос:** почему, по-твоему, меняется «${label(ask)}», хотя ты его не трогал?` : '**Вопрос:** какое звено цепочки здесь самое важное — и что будет, если его убрать?');
  return out.join('\n\n');
}
