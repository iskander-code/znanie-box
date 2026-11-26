// Нейросеть прямо из браузера: сайт обращается к Ollama на компьютере ученика или учителя.
// Нужен, когда сайт открыт не с коробки (например, с GitHub Pages).
// Ollama должна разрешать запросы с адреса сайта: переменная OLLAMA_ORIGINS (см. README).

const OLLAMA = 'http://localhost:11434';
const PREFERRED = ['qwen2.5:3b', 'qwen3:4b', 'gemma3:4b', 'gemma3:1b'];

const SYSTEM = (grade) =>
  `Ты — Сова, доброжелательный наставник школьника ${grade} класса сельской школы. ` +
  'Отвечай по-русски, просто и коротко: не больше 5 предложений. ' +
  'Опирайся ТОЛЬКО на фрагменты из школьной библиотеки ниже. Если ответа в них нет, честно скажи: ' +
  '«В библиотеке этого нет, спроси учителя». Не выдумывай факты, даты и числа.';

const MODES = {
  'socratic-0': 'Не давай готовый ответ. Задай ОДИН наводящий вопрос и процитируй короткую фразу из фрагмента, в которой есть подсказка.',
  'socratic-1': 'Не давай полный ответ. Назови первый шаг рассуждения и задай вопрос, который подведёт ученика к следующему шагу.',
  'socratic-2': 'Теперь объясни ответ полностью по фрагментам и предложи ученику пересказать его своими словами.',
  'explain-0': 'Объясни ответ полностью по фрагментам и предложи ученику пересказать его своими словами.',
  'simpler-0': 'Объясни как ученику 5 класса, одним коротким примером из сельской жизни (огород, ферма, речка, сельский магазин).',
};

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

export async function chatBrowser(model, messages) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.3 } }),
  });
  if (!r.ok) throw new Error(`Ollama ответила ${r.status}`);
  return (await r.json()).message.content;
}

export function tutorMessages({ message, mode, level, grade, history, fragments }) {
  const lvl = mode === 'socratic' ? Math.min(2, level) : 0;
  const instruction = MODES[`${mode}-${lvl}`] || MODES['socratic-0'];
  const context = fragments.map((f) => `[${f.title}] ${f.text}`).join('\n');
  let question = message.slice(0, 1000);
  if (mode === 'socratic' && lvl < 2) question += `\n\n(Правило для Совы: НЕ отвечай на вопрос прямо. ${instruction} Начни со слов «Подумай».)`;
  return [
    { role: 'system', content: `${SYSTEM(grade)}\n${instruction}\n\nФРАГМЕНТЫ:\n${context}` },
    ...history.slice(-6),
    { role: 'user', content: question },
  ];
}
