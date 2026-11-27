// Нейросеть прямо из браузера: сайт обращается к Ollama на компьютере ученика или учителя.
// Нужен, когда сайт открыт не с коробки (например, с GitHub Pages).
// Ollama должна разрешать запросы с адреса сайта: переменная OLLAMA_ORIGINS (см. README).

const OLLAMA = 'http://localhost:11434';
const PREFERRED = ['qwen3.5:4b', 'qwen3:4b', 'qwen2.5:3b', 'gemma3:4b', 'gemma3:1b'];
// У «думающих» моделей отключаем размышления: иначе ответ идёт минутами.
const THINKING = /^(qwen3|deepseek-r1|magistral)/;

const SYSTEM = (grade) =>
  `Ты — Сова, доброжелательный наставник школьника ${grade} класса сельской школы. ` +
  'Обращайся к ученику на «ты». Отвечай по-русски, просто и коротко: не больше 5 предложений. ' +
  'Опирайся ТОЛЬКО на фрагменты из школьной библиотеки ниже. Если ответа в них нет, честно скажи: ' +
  '«В библиотеке этого нет, спроси учителя». Не выдумывай факты, даты и числа.';

const MODES = {
  'socratic-0': 'Не давай готовый ответ. Задай ОДИН наводящий вопрос и процитируй короткую фразу из фрагмента, в которой есть подсказка.',
  'socratic-1': 'Не давай полный ответ. Назови первый шаг рассуждения и задай вопрос, который подведёт ученика к следующему шагу.',
  'socratic-2': 'Теперь объясни ответ полностью по фрагментам и предложи ученику пересказать его своими словами.',
  'explain-0': 'Объясни ответ полностью по фрагментам и предложи ученику пересказать его своими словами.',
  'simpler-0': 'Объясни как ученику 5 класса, одним коротким примером из сельской жизни (огород, ферма, речка, сельский магазин).',
};

// Когда в библиотеке ничего не нашлось: нейросеть отвечает из своих знаний.
export const GENERAL = (grade) =>
  `Ты — Сова, доброжелательный наставник школьника ${grade} класса в Казахстане. ` +
  'В школьной библиотеке нет материала по этому вопросу, поэтому ответь из своих знаний. ' +
  'Обращайся к ученику на «ты». Отвечай по-русски, понятно для его возраста, не больше 6 предложений. ' +
  'Если не уверен в фактах, датах или числах — честно скажи об этом и посоветуй проверить в учебнике. ' +
  'Не помогай с опасным, незаконным или взрослым содержанием: мягко откажи и посоветуй обратиться к учителю или родителям.';

export function generalMessages({ message, grade, history }) {
  return [{ role: 'system', content: GENERAL(grade) }, ...history.slice(-6), { role: 'user', content: message.slice(0, 1000) }];
}

// ИИ-помощник учителя (сайт без коробки): любые вопросы, ответ из знаний нейросети.
export const TEACHER_AI =
  'Ты — ИИ-помощник учителя сельской школы в Казахстане. Отвечай по-русски, по делу и структурно: ' +
  'списки, шаги, примеры. Отвечай на любые вопросы учителя из своих знаний: план урока, задачи и ответы к ним, ' +
  'объяснение темы для нужного класса, идеи опытов и игр, проверочные вопросы, письма родителям, работа с классом. ' +
  'Если не уверен в фактах, датах или числах — так и скажи и посоветуй сверить с учебником или официальной программой. ' +
  'Не помогай с опасным, незаконным или вредным для детей содержанием.';

export const DEBRIEF =
  'Ты — Сова, наставник школьника. Ученик сделал прогноз и запустил симуляцию причинно-следственной схемы. ' +
  'Разбери результат по-русски, не больше 7 предложений. Похвали верные догадки. Для каждой ошибки объясни ' +
  'цепочку связей, опираясь на цитаты из схемы. Напомни, что схема — упрощённая модель. ' +
  'В конце задай ОДИН вопрос на перенос: где ещё встречается такой механизм.';

async function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

/** Имя доступной модели или null. */
export async function detectBrowserLLM() {
  try {
    const r = await withTimeout(fetch(`${OLLAMA}/api/tags`), 2000);
    if (!r.ok) return null;
    const names = ((await r.json()).models || []).map((m) => m.name);
    return PREFERRED.find((p) => names.includes(p)) || names[0] || null;
  } catch {
    return null; // Ollama не запущена или не разрешает запросы с этого сайта
  }
}

const body = (model, messages, stream, maxTokens) => JSON.stringify({
  model, messages, stream, keep_alive: '60m',
  options: { temperature: 0.3, num_ctx: 4096, ...(maxTokens ? { num_predict: maxTokens } : {}) },
  ...(THINKING.test(model) ? { think: false } : {}),
});

export async function chatBrowser(model, messages, maxTokens) {
  const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(model, messages, false, maxTokens) });
  if (!r.ok) throw new Error(`Ollama ответила ${r.status}`);
  return cleanAnswer((await r.json()).message.content);
}

/** Читает поток строк JSON (NDJSON) и вызывает onLine для каждой. */
export async function readNDJSON(response, onLine) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += dec.decode(value || new Uint8Array(), { stream: !done });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(JSON.parse(line));
    }
    if (done) break;
  }
  if (buf.trim()) onLine(JSON.parse(buf));
}

/** Ответ по мере печати: onDelta получает каждый новый кусочек текста. Возвращает весь ответ. */
export async function chatBrowserStream(model, messages, onDelta, maxTokens) {
  const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(model, messages, true, maxTokens) });
  if (!r.ok || !r.body) throw new Error(`Ollama ответила ${r.status}`);
  let text = '';
  await readNDJSON(r, (chunk) => {
    if (chunk.error) throw new Error(chunk.error);
    const piece = chunk.message?.content || '';
    if (piece) { text += piece; onDelta(piece); }
  });
  return cleanAnswer(text);
}

// Без видеокарты модель поменьше отвечает в 2–2,5 раза быстрее.
const FAST_CPU = 'qwen2.5:3b';

/**
 * Загружает модель в память заранее (первый вопрос не ждёт загрузки) и выбирает модель под железо:
 * если видеокарты нет, а быстрая модель установлена — возвращает её. Возвращает имя модели.
 */
export async function warmUpBrowserLLM(model) {
  try {
    await chatBrowser(model, [{ role: 'user', content: 'Привет' }], 1);
    const ps = await (await fetch(`${OLLAMA}/api/ps`)).json();
    const onGpu = (ps.models || []).find((m) => m.name === model)?.size_vram > 0;
    if (onGpu || model === FAST_CPU) return model;
    const names = ((await (await fetch(`${OLLAMA}/api/tags`)).json()).models || []).map((m) => m.name);
    if (!names.includes(FAST_CPU)) return model;
    await chatBrowser(FAST_CPU, [{ role: 'user', content: 'Привет' }], 1);
    return FAST_CPU;
  } catch {
    return model;
  }
}

// Не больше 1500 символов из библиотеки: чем короче подсказка, тем быстрее ответ (как на коробке).
export function contextBlock(fragments, limit = 1500) {
  const lines = fragments.map((f) => `[${f.title}] ${f.text}`);
  if (lines.reduce((s, x) => s + x.length, 0) <= limit) return lines.join('\n');
  const share = Math.max(120, Math.floor(limit / Math.max(1, lines.length)));
  return lines.map((x) => (x.length <= share ? x : `${x.slice(0, share - 1).replace(/\s+\S*$/, '')}…`)).join('\n');
}

export function tutorMessages({ message, mode, level, grade, history, fragments }) {
  const lvl = mode === 'socratic' ? Math.min(2, level) : 0;
  const instruction = MODES[`${mode}-${lvl}`] || MODES['socratic-0'];
  const context = contextBlock(fragments.slice(0, 3));
  const msgs = [
    { role: 'system', content: `${SYSTEM(grade)}\n${instruction}\n\nФРАГМЕНТЫ:\n${context}` },
    ...history.slice(-6),
    { role: 'user', content: message.slice(0, 1000) },
  ];
  // Маленькие модели лучше слушаются правила, стоящего последним.
  if (mode === 'socratic' && lvl < 2) msgs.push({ role: 'system', content: `НЕ отвечай на вопрос прямо. ${instruction} Начни со слова «Подумай», закончи свой ответ вопросом со знаком «?».` });
  return msgs;
}

// Убирает служебный текст, если модель повторила инструкцию в ответе.
export function cleanAnswer(text) {
  const clean = text
    .replace(/\(?\s*Правило для Совы:[^)]*\)?/gi, '')
    .replace(/^\s*(НЕ отвечай на вопрос прямо\.|Не давай готовый ответ\.)[^\n]*\n?/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Отказ в конце содержательного ответа сбивает ученика — убираем его.
  return clean.length > 150 ? clean.replace(/\s*В библиотеке этого нет,? спроси учителя\.?\s*$/i, '') : clean;
}
