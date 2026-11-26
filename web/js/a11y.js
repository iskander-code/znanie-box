// Темы оформления, режим для особых потребностей и озвучка текста.

export const THEMES = [
  { id: 'light', icon: '☀', label: 'Светлая тема' },
  { id: 'dark', icon: '☾', label: 'Тёмная тема' },
  { id: 'a11y', icon: '👁', label: 'Режим для особых потребностей: крупный шрифт, высокий контраст, цвета для дальтоников, без анимаций' },
];

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };

export function currentTheme() {
  const saved = read('theme');
  if (THEMES.some((t) => t.id === saved)) return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = id === 'dark' ? '#0F172A' : id === 'a11y' ? '#000000' : '#F8FAFC';
  document.querySelectorAll('[data-theme-btn]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeBtn === id)));
}

export function setTheme(id) {
  write('theme', id);
  applyTheme(id);
}

/** Без анимаций: системная настройка «уменьшить движение» или режим для особых потребностей. */
export const reduceMotion = () => document.documentElement.dataset.theme === 'a11y' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function themeSwitcher() {
  const cur = currentTheme();
  return `<div class="seg theme" role="group" aria-label="Оформление">${THEMES.map((t) => `<button type="button" data-theme-btn="${t.id}" aria-pressed="${t.id === cur}" title="${t.label}" aria-label="${t.label}">${t.icon}</button>`).join('')}</div>`;
}

// ---------- озвучка ----------
let audio = null;
let speakingBtn = null;

function stop() {
  if (audio) { audio.pause(); audio = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (speakingBtn) { speakingBtn.setAttribute('aria-pressed', 'false'); speakingBtn.textContent = speakingBtn.dataset.label; }
  speakingBtn = null;
}

function russianVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('ru'));
  // Сначала голоса, встроенные в систему: они работают без интернета.
  return voices.find((v) => v.localService) || voices[0] || null;
}

function speakBrowser(text, done) {
  if (!('speechSynthesis' in window)) throw new Error('Этот браузер не умеет озвучивать текст');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ru-RU';
  const v = russianVoice();
  if (v) u.voice = v;
  u.rate = 0.95;
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
  return v ? '' : 'Русский голос не найден в системе — текст читается голосом по умолчанию. В Windows: Параметры → Время и язык → Речь → Добавить голоса → Русский.';
}

/**
 * Озвучить текст. Если на коробке установлен Piper — голос с сервера, иначе встроенный голос браузера.
 * Повторное нажатие на ту же кнопку останавливает чтение. Возвращает текст предупреждения или ''.
 */
export async function speak(text, btn, { serverTTS = false } = {}) {
  const same = btn && speakingBtn === btn;
  stop();
  if (same || !text.trim()) return '';
  if (btn) { speakingBtn = btn; btn.dataset.label ||= btn.textContent; btn.textContent = '⏹ Стоп'; btn.setAttribute('aria-pressed', 'true'); }
  const done = () => { if (speakingBtn === btn) stop(); };
  if (serverTTS) {
    try {
      const r = await fetch('api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!r.ok) throw new Error('tts');
      audio = new Audio(URL.createObjectURL(await r.blob()));
      audio.onended = done;
      await audio.play();
      return '';
    } catch { audio = null; /* переходим на голос браузера */ }
  }
  try {
    return speakBrowser(text, done);
  } catch (e) {
    stop();
    return e.message;
  }
}

if ('speechSynthesis' in window) speechSynthesis.getVoices(); // браузер подгружает список голосов заранее
window.addEventListener('hashchange', stop);
