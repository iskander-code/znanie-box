// Онлайн-нейросети по ключу на сайте без коробки (например, GitHub Pages).
// Ключ хранится только в этом браузере (localStorage) и уходит напрямую в сервис компании-разработчика.
// С коробкой ключ хранится на сервере (server/online.py), а этот модуль не используется.

export const PROVIDERS = {
  claude: { name: 'Claude', model: 'claude-opus-5-5' },
  openai: { name: 'GPT', model: 'gpt-5-mini' },
  gemini: { name: 'Gemini', model: 'gemini-4-hydrogen' },
};
const MAX_TOKENS = 4096;

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

const keys = () => LS.get('online-keys', {});
export const keyOf = (pid) => keys()[pid] || '';

export function setKey(pid, key) {
  if (!PROVIDERS[pid]) throw new Error('Неизвестная нейросеть');
  const k = String(key || '').trim();
  if (k && (k.length < 10 || /\s/.test(k))) throw new Error('Похоже, ключ вставлен не полностью или с пробелами');
  const all = keys();
  if (k) all[pid] = k; else delete all[pid];
  LS.set('online-keys', all);
  if (!k && onlineProvider() === pid) setOnlineProvider('local');
}

/** Выбранная онлайн-нейросеть или null (тогда отвечает Ollama на этом компьютере). */
export function onlineProvider() {
  const pid = LS.get('online-provider', 'local');
  return PROVIDERS[pid] && keyOf(pid) ? pid : null;
}
export const setOnlineProvider = (pid) => LS.set('online-provider', pid);
export const onlineLabel = (pid = onlineProvider()) => (pid ? `${PROVIDERS[pid].name} ${PROVIDERS[pid].model} (онлайн)` : null);

/** Для кабинета учителя: какие ключи есть (сам ключ не показываем — только последние 4 символа). */
export const onlineStatus = () => Object.entries(PROVIDERS).map(([id, p]) => {
  const k = keyOf(id);
  return { id, name: p.name, model: p.model, hasKey: !!k, masked: k ? `…${k.slice(-4)}` : '', source: k ? 'browser' : '' };
});

export class Refused extends Error {}

/** Ошибку сети или сервиса — понятными словами. */
export function describe(e) {
  const s = e?.status;
  if (s === 401) return 'ключ не подошёл';
  if (s === 403) return 'доступ по ключу запрещён';
  if (s === 429) return 'превышен лимит запросов';
  if (s) return `сервис ответил ошибкой ${s}`;
  return 'нет связи с интернетом';
}

function split(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content }));
  return { system, dialog };
}

async function sse(url, headers, body, onEvent) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) { const err = new Error(`HTTP ${r.status}`); err.status = r.status; throw err; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += dec.decode(value || new Uint8Array(), { stream: !done });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      onEvent(JSON.parse(data));
    }
    if (done) return;
  }
}

const STREAMERS = {
  claude(messages, onDelta) {
    const { system, dialog } = split(messages);
    return sse('https://api.anthropic.com/v1/messages', {
      'x-api-key': keyOf('claude'), 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true', // Anthropic разрешает запрос из браузера только с этим заголовком
    }, {
      model: PROVIDERS.claude.model, max_tokens: MAX_TOKENS, stream: true, system, messages: dialog,
      output_config: { effort: 'low' }, fallbacks: 'default',
    }, (ev) => {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onDelta(ev.delta.text);
      else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal') throw new Refused('Claude отказался отвечать');
      else if (ev.type === 'error') throw new Error(ev.error?.message || 'ошибка Claude');
    });
  },
  openai(messages, onDelta) {
    const m = PROVIDERS.openai.model;
    return sse('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${keyOf('openai')}` }, {
      model: m, messages: messages.map((x) => ({ role: x.role, content: x.content })), stream: true, max_completion_tokens: MAX_TOKENS,
      ...(/^(gpt-5|o)/.test(m) ? { reasoning_effort: 'low' } : {}),
    }, (ev) => {
      if (ev.error) throw new Error(ev.error.message || 'ошибка OpenAI');
      for (const c of ev.choices || []) if (c.delta?.content) onDelta(c.delta.content);
    });
  },
  gemini(messages, onDelta) {
    const m = PROVIDERS.gemini.model;
    const { system, dialog } = split(messages);
    const generationConfig = { maxOutputTokens: MAX_TOKENS, ...(/^gemini-[34]/.test(m) ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) };
    return sse(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`, { 'x-goog-api-key': keyOf('gemini') }, {
      contents: dialog.map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })),
      generationConfig, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    }, (ev) => {
      if (ev.error) throw new Error(ev.error.message || 'ошибка Gemini');
      for (const c of ev.candidates || []) {
        if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(c.finishReason)) throw new Refused('Gemini отказался отвечать');
        for (const p of c.content?.parts || []) if (p.text && !p.thought) onDelta(p.text);
      }
    });
  },
};

/** Ответ онлайн-нейросети по кусочкам. Возвращает весь текст. */
export async function streamOnline(pid, messages, onDelta = () => {}) {
  if (!STREAMERS[pid] || !keyOf(pid)) throw new Error('Нет ключа');
  let text = '';
  await STREAMERS[pid](messages, (piece) => { text += piece; onDelta(piece); });
  return text;
}

/** Пробный запрос для кнопки «Проверить». */
export const testKey = (pid) => streamOnline(pid, [{ role: 'user', content: 'Ответь одним словом по-русски: готово' }]);
