// Режим учителя на стороне браузера.
// С коробкой PIN проверяет сервер (server/teacher.py) и он же запрещает готовые ответы на контрольной.
// На сайте без коробки PIN проверяется здесь, а режим контрольной действует только на этом устройстве.

// Хэш PIN «2026» (PBKDF2-SHA256, 120 000 итераций, соль «znanie-box») — совпадает с server/teacher.py.
export const PIN_HASH = '981f1832f924aabe45970ea6684e8330a97bf28728f0213da47ce17b6daf23c5';

export async function hashPin(pin) {
  if (!globalThis.crypto?.subtle) throw new Error('Браузер не поддерживает проверку PIN на этой странице');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin).trim()), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('znanie-box'), iterations: 120000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* приватный режим */ } },
};

/** Токен учителя: строка от сервера или 'local' для сайта без коробки. Хранится до закрытия вкладки. */
export const getToken = () => ss.get('teacher-token');
export const setToken = (t) => ss.set('teacher-token', t);

/** Вход по PIN. server — есть ли коробка. Возвращает токен или бросает ошибку с понятным текстом. */
export async function login(pin, server) {
  if (!/^\d{4,8}$/.test(String(pin).trim())) throw new Error('PIN — это 4–8 цифр');
  if (server) {
    const r = await fetch('api/teacher/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.token) throw new Error(data.error || 'Не удалось войти');
    return data.token;
  }
  if ((await hashPin(pin)) !== PIN_HASH) throw new Error('Неверный PIN');
  return 'local';
}

// ---------- обезличенная статистика тем на этом устройстве (когда нет коробки) ----------
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

export function recordLocal(docId, title, kind) {
  if (!docId) return;
  const stats = LS.get('topic-stats', {});
  const s = (stats[docId] ||= { title, question: 0, hint: 0, answer: 0, report: 0 });
  s[kind] = (s[kind] || 0) + 1;
  LS.set('topic-stats', stats);
}

export function localSummary(limit = 10) {
  return Object.entries(LS.get('topic-stats', {}))
    .map(([docId, s]) => ({ docId, ...s, score: s.question + s.hint + 2 * s.answer + 3 * s.report }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const resetLocalStats = () => LS.set('topic-stats', {});
export const localExam = () => LS.get('exam-local', false);
export const setLocalExam = (on) => LS.set('exam-local', !!on);
