import { simulate, pathTo, findLoops, checkPredictions, trend, DEFAULT_DELAY_LABELS } from './engine.js';
import { renderGraph, esc } from './graph-view.js';
import { Library, localAnswer, makeQuiz, checkQuiz, RELEVANT } from './tutor-local.js';
import { detectBrowserLLM, warmUpBrowserLLM, chatBrowser, chatBrowserStream, readNDJSON, tutorMessages, generalMessages, DEBRIEF } from './llm-browser.js';
import { themeSwitcher, applyTheme, setTheme, currentTheme, reduceMotion, speak } from './a11y.js';
import { login, getToken, setToken, recordLocal, localSummary, resetLocalStats, localExam, setLocalExam } from './teacher.js';
import { qrSVG } from './qr.js';

const app = document.getElementById('app');
const S = {
  server: null, // ответ /api/health, если сайт открыт с коробки
  browserLLM: null, // модель Ollama на этом компьютере, если сайт открыт не с коробки
  texts: [],
  graphs: [],
  lib: null,
  chat: { messages: [], mode: 'socratic', level: 0, lastQuestion: '', quiz: null, grade: 8, busy: false },
  ex: null,
  bd: null,
  teacher: { text: '', graph: null, notes: [], busy: false, error: '', pinError: '', summary: null },
  exam: false, // режим контрольной: Сова не выдаёт готовых ответов
  auth: getToken(), // токен учителя (до закрытия вкладки)
};
const EXAM_GENERAL = 'Сейчас идёт контрольная: Сова помогает только подсказками по темам школьной библиотеки. Попробуй спросить про тему из учебника.';

const TREND_WORD = { up: 'вырастет', down: 'уменьшится', same: 'не изменится' };
const TREND_PAST = { up: 'вырос', down: 'уменьшился', same: 'не изменился' };
const ARROW = { up: '▲', down: '▼', same: '=' };

const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(url); return r.json(); });
const postJSON = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (r.status === 403 && headers['X-Teacher-Token']) { logoutTeacher(); throw new Error('Вход учителя истёк — введите PIN ещё раз'); }
    if (!r.ok) throw new Error(data.error || `Ошибка ${r.status}`);
    return data;
  });
const teacherPost = (url, body) => postJSON(url, body, { 'X-Teacher-Token': S.auth || '' });
const isTeacher = () => !!S.auth;
const graphById = (id) => S.graphs.find((g) => g.id === id);
const nodeLabel = (g, id) => g.nodes.find((n) => n.id === id)?.label || id;
const textOf = (g) => g.sourceText || S.texts.find((t) => t.id === g.text)?.text || '';
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

// ---------- запуск ----------
async function boot() {
  const [subjects, index, labs] = await Promise.all([getJSON('data/library/index.json'), getJSON('data/graphs/index.json'), getJSON('data/phet.json').catch(() => [])]);
  S.labs = labs;
  S.subjects = subjects;
  const parts = await Promise.all(subjects.map((s) => getJSON(`data/library/${s.id}.json`)));
  S.texts = parts.flatMap((docs, i) => docs.map((d) => ({ ...d, subject: subjects[i].name, subjectId: subjects[i].id })));
  S.lib = new Library(S.texts);
  S.graphs = await Promise.all(index.map((id) => getJSON(`data/graphs/${id}.json`)));
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (r.ok && r.headers.get('content-type')?.includes('json')) S.server = await r.json();
  } catch { /* статический сайт */ }
  if (S.server) {
    try { S.graphs.push(...(await getJSON('api/graphs'))); } catch { /* нет своих схем */ }
  }
  S.chat.grade = store.get('grade', 8);
  S.exam = S.server ? !!S.server.exam : localExam();
  if (S.server) setInterval(syncSettings, 15000); // режим контрольной включается на всех устройствах класса
  renderStatus();
  if (!S.server) {
    // Сайт открыт не с коробки: пробуем Ollama на этом компьютере, не задерживая загрузку.
    detectBrowserLLM().then(async (m) => {
      if (!m) return;
      S.browserLLM = m;
      renderStatus();
      route();
      // Загружаем модель заранее, чтобы первый вопрос не ждал загрузки; без видеокарты берём модель побыстрее.
      const best = await warmUpBrowserLLM(m);
      if (best !== S.browserLLM) { S.browserLLM = best; renderStatus(); }
    });
  }
  window.addEventListener('hashchange', route);
  route();
}

async function syncSettings() {
  try {
    const r = await getJSON('api/settings');
    if (r.exam !== S.exam) { S.exam = r.exam; renderStatus(); if (/^#\/(sova|teacher)/.test(location.hash) && !S.chat.busy) route(); }
  } catch { /* коробка недоступна — оставляем как было */ }
}

function logoutTeacher() {
  if (S.server && S.auth) postJSON('api/teacher/logout', {}, { 'X-Teacher-Token': S.auth }).catch(() => {});
  S.auth = null;
  setToken(null);
}

function renderStatus() {
  const el = document.getElementById('status');
  if (!S.server && S.browserLLM) { el.textContent = `Нейросеть ${S.browserLLM} на этом компьютере`; el.className = 'status on'; return; }
  if (!S.server) { el.innerHTML = 'Без нейросети · <a href="#/ai">как включить</a>'; el.className = 'status demo'; return; }
  el.textContent = S.server.llm ? `Коробка · нейросеть ${S.server.model}` : 'Коробка · нейросеть не запущена';
  el.className = `status ${S.server.llm ? 'on' : 'demo'}`;
}

function route() {
  const [view = '', id] = location.hash.replace(/^#\/?/, '').split('/');
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (view || 'home')));
  const views = { '': viewHome, sova: viewSova, explore: viewExplore, build: viewBuild, teacher: viewTeacher, library: viewLibrary, labs: viewLabs, ai: viewAI, connect: viewConnect };
  (views[view] || viewHome)(id ? decodeURIComponent(id) : undefined);
  window.scrollTo(0, 0);
}

// ---------- главная ----------
function graphCards(target) {
  return `<div class="cards">${S.graphs.map((g) => `
    <a class="card" href="#/${target}/${esc(g.id)}">
      <span class="tag">${esc(g.subject || 'Своя схема')}${g.grade ? ` · ${g.grade} класс` : ''}</span>
      <strong>${esc(g.title)}</strong>
      <span class="muted">${g.nodes.length} факторов · ${g.edges.length} связей${g.verified_by_teacher ? ' · проверено учителем' : ''}</span>
    </a>`).join('')}</div>`;
}

function viewHome() {
  app.innerHTML = `
  <section class="hero">
    <h1>Библиотека, наставник и тренажёр мышления для школ Казахстана — без интернета</h1>
    <p>Открой один раз — и всё работает без интернета: 400 тем, схемы и наставник сохраняются прямо на устройстве. Сова помогает дойти до ответа самому и показывает, откуда взята информация. Если в библиотеке ответа нет, Сова спросит нейросеть.</p>
  </section>
  <div class="cards subjects">${S.subjects.map((s) => `<a class="card" href="#/library/${s.id}"><span class="icon">${s.icon}</span><strong>${esc(s.name)}</strong><span class="muted">${S.texts.filter((t) => t.subjectId === s.id).length} тем</span></a>`).join('')}</div>
  <div class="cards big">
    <a class="card" href="#/sova"><span class="icon">🦉</span><strong>Спросить Сову</strong><span class="muted">Наставник ответит по книгам из библиотеки: сначала подсказкой, потом полным ответом</span></a>
    <a class="card" href="#/explore"><span class="icon">🔀</span><strong>Что будет, если…</strong><span class="muted">Измени одно условие в параграфе и проследи цепочку последствий</span></a>
    <a class="card" href="#/build"><span class="icon">🧩</span><strong>Собери сам</strong><span class="muted">Разбери параграф по фразам и собери схему причин и следствий</span></a>
    <a class="card" href="#/labs"><span class="icon">🧪</span><strong>Опыты</strong><span class="muted">${S.labs.length} интерактивных лабораторий PhET по физике и математике: меняй условия и смотри, что выйдет</span></a>
    <a class="card" href="#/library"><span class="icon">📚</span><strong>Библиотека</strong><span class="muted">${S.texts.length} тем по истории Казахстана, физике, алгебре и геометрии</span></a>
    <a class="card" href="#/connect"><span class="icon">📱</span><strong>Как подключить Коробку</strong><span class="muted">4 простых шага и QR-код для телефонов класса</span></a>
  </div>
  <h2>Схемы «Что будет, если…»</h2>
  ${graphCards('explore')}
  <p class="note">Сова может ошибаться — проверяй её по источнику. Твои вопросы не уходят в интернет: всё работает внутри школьной коробки.</p>`;
}

// ---------- как включить нейросеть ----------
function viewAI() {
  const on = S.server?.llm || S.browserLLM;
  app.innerHTML = `
  <h1>Как включить нейросеть</h1>
  ${on ? `<div class="info">✓ Нейросеть уже работает: ${esc(S.server?.model || S.browserLLM)}. <a href="#/sova">Спросить Сову</a></div>` : ''}
  <p class="muted">Нейросеть работает на вашем компьютере через бесплатную программу Ollama — без интернета и без отправки вопросов наружу. Установите Ollama с ollama.com и скачайте модель командой <code>ollama pull qwen2.5:3b</code>.</p>
  <div class="step"><h3><span class="n">1</span> Способ «коробка» — надёжный</h3>
    <p>Скачайте проект с GitHub (зелёная кнопка Code → Download ZIP), распакуйте и дважды нажмите <strong>Запустить.bat</strong>. Откроется браузер с прототипом, нейросеть подключится сама. Нужен Python 3.10+.</p>
    <p class="muted small">Чтобы открыть прототип с других устройств школы, запустите <code>python server/server.py --box</code> и откройте адрес этого компьютера с портом 8000.</p></div>
  <div class="step"><h3><span class="n">2</span> Способ «этот сайт»</h3>
    <p>Разрешите Ollama отвечать этому сайту: выполните в PowerShell команду ниже, затем закройте Ollama (значок у часов → Quit) и откройте снова. Обновите эту страницу; если браузер спросит про доступ к устройствам в локальной сети — разрешите.</p>
    <pre class="code">setx OLLAMA_ORIGINS "${esc(location.origin)}"</pre></div>`;
}

// ---------- библиотека ----------
function viewLibrary(id) {
  const doc = id && S.texts.find((t) => t.id === id);
  if (doc) {
    const list = S.texts.filter((t) => t.subjectId === doc.subjectId);
    const i = list.indexOf(doc);
    app.innerHTML = `<a class="back" href="#/library/${doc.subjectId}">← ${esc(doc.subject)}</a>
      <article class="doc" id="doc"><span class="tag">${esc(doc.subject)} · ${doc.grade} класс · ${esc(doc.section)}</span><h1>${esc(doc.title)}</h1><p>${esc(doc.text)}</p></article>
      <div class="row"><button class="btn" data-action="speak-doc" aria-pressed="false">🔊 Озвучить текст</button>${doc.graph ? `<a class="btn primary" href="#/explore/${doc.graph}">🔀 Схема «Что будет, если…»</a>` : ''}
      ${labsFor(doc.id).map((l) => `<a class="btn primary" href="#/labs/${esc(l.id)}">🧪 Опыт «${esc(l.title)}»</a>`).join('')}
      <button class="btn" data-action="ask-about" data-title="${esc(doc.title)}">🦉 Спросить Сову об этом</button></div>
      <div class="row pager">${i > 0 ? `<a class="btn ghost" href="#/library/${list[i - 1].id}">← ${esc(list[i - 1].title)}</a>` : ''}${i < list.length - 1 ? `<a class="btn ghost" href="#/library/${list[i + 1].id}">${esc(list[i + 1].title)} →</a>` : ''}</div>`;
    return;
  }
  const subject = id && S.subjects.find((s) => s.id === id);
  if (subject) {
    const L = (S.lf ||= { grade: 'all', q: '' });
    const docs = S.texts.filter((t) => t.subjectId === id);
    const grades = [...new Set(docs.map((d) => d.grade))].sort((a, b) => a - b);
    app.innerHTML = `<a class="back" href="#/library">← Библиотека</a>
      <h1>${subject.icon} ${esc(subject.name)}</h1>
      <div class="toolbar">
        <div class="seg">${['all', ...grades].map((g) => `<button class="${String(L.grade) === String(g) ? 'on' : ''}" data-action="lib-grade" data-g="${g}">${g === 'all' ? 'Все классы' : `${g} кл.`}</button>`).join('')}</div>
        <input type="search" placeholder="Поиск по темам…" value="${esc(L.q)}" data-action-input="lib-q" aria-label="Поиск по темам">
      </div>
      <div id="lib-list"></div>`;
    renderLibList(id);
    return;
  }
  app.innerHTML = `<h1>Библиотека</h1>
    <p class="muted">${S.texts.length} тем по школьной программе Казахстана. В настоящей коробке здесь же открываются Википедия, видеоуроки и симуляторы через Kiwix.</p>
    <div class="cards subjects">${S.subjects.map((s) => {
      const docs = S.texts.filter((t) => t.subjectId === s.id);
      const g = docs.map((d) => d.grade);
      return `<a class="card" href="#/library/${s.id}"><span class="icon">${s.icon}</span><strong>${esc(s.name)}</strong><span class="muted">${docs.length} тем · ${Math.min(...g)}–${Math.max(...g)} классы</span></a>`;
    }).join('')}</div>`;
}

function renderLibList(subjectId) {
  const L = S.lf;
  const q = L.q.trim().toLowerCase();
  const docs = S.texts.filter((t) => t.subjectId === subjectId && (L.grade === 'all' || String(t.grade) === String(L.grade))
    && (!q || t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q)));
  const sections = [...new Map(docs.map((d) => [`${d.grade}|${d.section}`, d])).keys()];
  document.getElementById('lib-list').innerHTML = docs.length ? sections.map((key) => {
    const [grade, section] = key.split('|');
    const items = docs.filter((d) => `${d.grade}|${d.section}` === key);
    return `<h2>${esc(section)} <span class="muted small">${grade} класс</span></h2><ul class="topics">${items.map((d) => `<li><a href="#/library/${d.id}">${esc(d.title)}</a>${d.graph ? ' <span class="chip graph small">🔀 схема</span>' : ''}</li>`).join('')}</ul>`;
  }).join('') : '<p class="muted">Ничего не найдено. Попробуй другое слово или спроси Сову.</p>';
}

// ---------- Сова ----------
function viewSova() {
  const c = S.chat;
  const modes = [['socratic', 'Наведи на мысль'], ['explain', 'Объясни'], ['quiz', 'Проверь меня']].filter(([m]) => !(S.exam && m === 'explain'));
  if (S.exam && c.mode === 'explain') c.mode = 'socratic';
  const last = [...c.messages].reverse().find((m) => m.role === 'assistant');
  app.innerHTML = `
  <div class="chat">
    <div class="chat-head">
      <h1>🦉 Сова</h1>
      <div class="seg" role="tablist">${modes.map(([m, l]) => `<button class="${c.mode === m ? 'on' : ''}" data-action="chat-mode" data-mode="${m}">${l}</button>`).join('')}</div>
      <label class="muted">Класс <select data-action-change="grade">${[5, 6, 7, 8, 9, 10, 11].map((g) => `<option ${g === c.grade ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
    </div>
    ${S.exam ? '<div class="info exam" role="status">📝 Идёт контрольная работа: Сова даёт только подсказки, готовых ответов нет.</div>' : ''}
    <p id="tts-note" class="muted small" hidden></p>
    <div class="messages" id="messages" aria-live="polite">
      ${c.messages.length ? '' : `<div class="msg assistant"><p>Привет! Я Сова. Спроси меня о том, что непонятно в параграфе. Например:</p>
        <div class="row">${['Почему высохло Аральское море?', 'Кто основал Казахское ханство?', 'Что такое закон Ома?', 'Как найти дискриминант?', 'Чему равна сумма углов треугольника?'].map((q) => `<button class="chip" data-action="ask-example" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`}
      ${c.messages.map(renderMsg).join('')}
      ${c.busy ? '<div class="msg assistant typing">Сова думает…</div>' : ''}
    </div>
    ${last && !c.busy && last.kind === 'answer' ? `<div class="row actions">
      ${last.level < 2 && !last.general && !(S.exam && last.level >= 1) ? '<button class="btn" data-action="hint-more">Ещё подсказка</button>' : ''}
      ${last.level < 2 && !last.general && !S.exam ? '<button class="btn" data-action="show-answer">Покажи ответ</button>' : ''}
      ${S.exam ? '' : '<button class="btn" data-action="simpler">Объясни проще</button>'}
      <button class="btn ghost" data-action="report">Тут ошибка</button></div>` : ''}
    <form class="composer" data-form="chat">
      <input name="q" autocomplete="off" placeholder="${c.mode === 'quiz' && c.quiz ? 'Впиши пропущенное слово' : c.mode === 'quiz' ? 'Тема для проверки, например «инфляция»' : 'Задай вопрос…'}" aria-label="Вопрос" />
      <button class="btn primary" ${c.busy ? 'disabled' : ''}>Отправить</button>
    </form>
  </div>`;
  const box = document.getElementById('messages');
  box.scrollTop = box.scrollHeight;
  if (!c.busy) app.querySelector('.composer input').focus({ preventScroll: true });
}

function renderMsg(m, i) {
  const sources = (m.sources || []).map((s) => `<a class="chip src" href="#/library/${esc(s.docId)}">📖 ${esc(s.title)}</a>`).join('');
  const graph = m.graph ? `<a class="chip graph" href="#/explore/${esc(m.graph)}">🔀 Открыть схему «${esc(graphById(m.graph)?.title || m.graph)}»</a>` : '';
  const by = m.role === 'assistant' && m.by ? `<span class="by">${esc(m.by)}</span>` : '';
  const say = m.role === 'assistant' ? `<button class="say" data-action="speak-msg" data-i="${i}" aria-pressed="false" aria-label="Озвучить ответ" title="Озвучить">🔊</button>` : '';
  return `<div class="msg ${m.role}">${say}${esc(m.text).replace(/\n/g, '<br>')}${sources || graph ? `<div class="row">${sources}${graph}</div>` : ''}${by}</div>`;
}

// Предел длины ответа (как на коробке): подсказка короткая, объяснение длиннее.
const MAX_TOKENS = { hint: 160, answer: 350, general: 350 };

/** Ответ печатается в пузыре «Сова думает…» по мере готовности — не чаще раза в 60 мс (бережём слабые устройства). */
function liveBubble() {
  let text = '';
  let raf = 0;
  const paint = () => {
    raf = 0;
    const el = document.querySelector('#messages .typing');
    if (!el) return;
    el.classList.add('live');
    el.textContent = text;
    const box = document.getElementById('messages');
    box.scrollTop = box.scrollHeight;
  };
  return (piece) => { text += piece; if (!raf) raf = setTimeout(paint, 60); };
}

/** Вопрос коробке с ответом по мере печати. Старый сервер или ответ без нейросети приходит обычным JSON. */
async function chatServer(body, onDelta) {
  const r = await fetch('api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Ошибка ${r.status}`);
  if (!r.headers.get('content-type')?.includes('ndjson') || !r.body) return r.json();
  let meta = {};
  let answer = null;
  await readNDJSON(r, (line) => {
    if (line.type === 'meta') meta = line;
    else if (line.type === 'delta') onDelta(line.text);
    else if (line.type === 'done') answer = line.answer;
    else if (line.type === 'error') throw new Error(line.error);
  });
  return { ...meta, answer };
}

const GENERAL_LABEL = (model) => `⚠ нейросеть ${model}: ответ не из библиотеки — проверь у учителя или в учебнике`;

async function askSova(question, level, mode = S.chat.mode) {
  const c = S.chat;
  if (S.exam) { mode = 'socratic'; level = Math.min(level, 1); } // на сервере то же правило проверяется ещё раз
  c.busy = true;
  viewSova();
  let reply;
  try {
    if (S.server) {
      const history = c.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.text }));
      const r = await chatServer({ message: question, mode, level, grade: c.grade, history }, liveBubble());
      if ('exam' in r && r.exam !== S.exam) { S.exam = !!r.exam; renderStatus(); }
      if (r.exam) { mode = 'socratic'; level = Math.min(level, Number(r.level ?? 1)); }
      if (r.answer && r.model === 'контрольная') {
        reply = { text: r.answer, sources: [], graph: null, by: 'режим контрольной', general: true };
      } else if (r.answer && r.general) {
        reply = { text: r.answer, sources: [], graph: null, by: GENERAL_LABEL(r.model), general: true };
      } else if (r.answer) {
        const f = r.fragments || [];
        reply = { text: r.answer, sources: [...new Map(f.slice(0, 2).map((x) => [x.title, x])).values()], graph: f.find((x) => x.graph)?.graph || null, by: `нейросеть ${r.model}` };
      } else {
        reply = { ...localAnswer({ message: question, mode, level, fragments: r.fragments || [] }), by: r.llm ? 'подсказка-шаблон' : 'без нейросети' };
      }
    } else if (S.exam && !RELEVANT(S.lib.search(question))) {
      reply = { text: EXAM_GENERAL, sources: [], graph: null, by: 'режим контрольной', general: true };
    } else if (S.browserLLM && RELEVANT(S.lib.search(question))) {
      const fragments = S.lib.search(question);
      const history = c.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.text }));
      const hint = mode === 'socratic' && level < 2;
      const text = await chatBrowserStream(S.browserLLM, tutorMessages({ message: question, mode, level, grade: c.grade, history, fragments: fragments.slice(0, 3) }), liveBubble(), MAX_TOKENS[hint ? 'hint' : 'answer']);
      if (mode === 'socratic' && level < 2 && !text.includes('?')) {
        // Модель выдала ответ вместо наводящего вопроса — показываем проверенную подсказку-шаблон.
        reply = { ...localAnswer({ message: question, mode, level, fragments }), by: 'подсказка-шаблон' };
      } else {
        reply = { text, sources: [...new Map(fragments.slice(0, 2).map((x) => [x.title, x])).values()], graph: fragments.find((x) => x.graph)?.graph || null, by: `нейросеть ${S.browserLLM}` };
      }
    } else if (S.browserLLM) {
      // В библиотеке ничего нет — отвечает нейросеть из своих знаний, с пометкой.
      const history = c.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.text }));
      const text = await chatBrowserStream(S.browserLLM, generalMessages({ message: question, grade: c.grade, history }), liveBubble(), MAX_TOKENS.general);
      reply = { text, sources: [], graph: null, by: GENERAL_LABEL(S.browserLLM), general: true };
    } else {
      reply = { ...localAnswer({ message: question, mode, level, fragments: S.lib.search(question) }), by: 'без нейросети' };
    }
  } catch (e) {
    reply = { text: `Не получилось ответить: ${e.message}`, sources: [] };
  }
  if (!S.server) {
    // Обезличенная статистика тем для учителя (с коробкой её ведёт сервер).
    const top = S.lib.search(question);
    if (RELEVANT(top)) recordLocal(top[0].docId, top[0].title, mode === 'explain' || mode === 'simpler' || level >= 2 ? 'answer' : level ? 'hint' : 'question');
  }
  c.messages.push({ role: 'assistant', kind: 'answer', level, ...reply });
  c.busy = false;
  viewSova();
}

function sendChat(text) {
  const c = S.chat;
  if (!text.trim() || c.busy) return;
  c.messages.push({ role: 'user', text });
  if (c.mode === 'quiz') {
    if (c.quiz) {
      c.messages.push({ role: 'assistant', text: checkQuiz(c.quiz, text), sources: [c.quiz.source] });
      c.quiz = null;
    } else {
      const fr = S.lib.search(text);
      c.quiz = makeQuiz(fr);
      c.messages.push(c.quiz
        ? { role: 'assistant', text: `Вставь пропущенное слово:\n«${c.quiz.question}»`, sources: [c.quiz.source] }
        : { role: 'assistant', text: 'Не нашла в библиотеке материала по этой теме. Попробуй другую: океан, крепостное право, инфляция.' });
    }
    return viewSova();
  }
  c.lastQuestion = text;
  askSova(text, c.mode === 'explain' ? 2 : 0);
}

// ---------- «Что будет, если…» ----------
function viewExplore(id) {
  const g = id && graphById(id);
  if (!g) {
    app.innerHTML = `<h1>Что будет, если…</h1><p class="muted">Выбери параграф. Ты изменишь одно условие, сделаешь прогноз и увидишь, как изменение пройдёт по цепочке причин и следствий.</p>${graphCards('explore')}`;
    return;
  }
  if (!S.ex || S.ex.graphId !== id) {
    S.ex = { graphId: id, changes: {}, selected: null, tool: 'change', predictions: {}, result: null, anim: null, phase: 'setup', info: null, highlight: null, showText: false, debrief: '', busy: false };
  }
  const x = S.ex;
  const loops = findLoops(g);
  app.innerHTML = `
  <a class="back" href="#/explore">← Все схемы</a>
  <div class="ex-head"><div><span class="tag">${esc(g.subject || 'Своя схема')}${g.grade ? ` · ${g.grade} класс` : ''}</span><h1>${esc(g.title)}</h1>
    <p class="muted">${g.verified_by_teacher ? '✓ Схема проверена учителем' : 'Черновик схемы'} · <button class="link" data-action="toggle-text">${x.showText ? 'Скрыть текст' : 'Показать текст параграфа'}</button></p></div>
    <a class="btn" href="#/build/${esc(g.id)}">🧩 Собрать самому</a></div>
  ${x.showText ? `<div class="paragraph">${highlightEvidence(textOf(g), g)}</div>` : ''}
  <div class="explore">
    <div class="graph-wrap" id="graph"></div>
    <aside class="panel" id="panel"></aside>
  </div>
  <div class="legend"><span class="lg pos">+ усиливает</span><span class="lg neg">− ослабляет</span><span>▲ растёт · ▼ падает · ▲? твой прогноз</span>${loops.length ? `<span>Петель обратной связи: ${loops.length}</span>` : ''}</div>`;
  drawExploreGraph();
  drawPanel();
}

function drawExploreGraph() {
  const g = graphById(S.ex.graphId);
  const x = S.ex;
  renderGraph(document.getElementById('graph'), g, {
    total: x.anim || (x.phase === 'setup' ? x.changes : x.result?.total) || {},
    selected: x.selected,
    predictions: x.predictions,
    highlightEdges: x.highlight,
    dimEdges: !!x.highlight,
    onNodeClick: (nid) => {
      if (x.phase === 'running') return;
      if (x.phase === 'done') { showWhy(nid); return; }
      x.selected = nid;
      x.info = null;
      drawExploreGraph();
      drawPanel();
    },
    onEdgeClick: (e) => {
      x.info = { edge: e };
      x.highlight = new Set([e]);
      drawExploreGraph();
      drawPanel();
    },
  });
}

const sliderWord = (v) => (v <= -70 ? 'сильно уменьшить' : v < 0 ? 'уменьшить' : v === 0 ? 'не менять' : v < 70 ? 'увеличить' : 'сильно увеличить');

function drawPanel() {
  const g = graphById(S.ex.graphId);
  const x = S.ex;
  const panel = document.getElementById('panel');
  const delays = g.delayLabels || DEFAULT_DELAY_LABELS;
  let h = '';
  if (x.info?.edge) {
    const e = x.info.edge;
    h += `<div class="info"><strong>${esc(nodeLabel(g, e.from))} → ${esc(nodeLabel(g, e.to))}</strong>
      <p>${e.sign > 0 ? 'Усиливает: чем больше первое, тем больше второе.' : 'Ослабляет: чем больше первое, тем меньше второе.'} Сила ${'●'.repeat(e.strength)}${'○'.repeat(3 - e.strength)}, проявляется ${esc(delays[e.delay] || '')}.</p>
      <blockquote>«${esc(e.evidence)}»</blockquote><button class="link" data-action="close-info">Закрыть</button></div>`;
  }
  if (x.phase === 'setup') {
    const changed = Object.entries(x.changes);
    h += `<div class="step"><h3><span class="n">1</span> Что меняем?</h3>
      ${(g.scenarios || []).length ? `<div class="row">${g.scenarios.map((s, i) => `<button class="chip" data-action="scenario" data-i="${i}">${esc(s.label)}</button>`).join('')}</div><p class="muted small">или нажми на любой узел схемы</p>` : '<p class="muted small">Нажми на узел схемы, который хочешь изменить</p>'}
      ${x.selected && x.tool === 'change' ? (() => {
        const v = Math.round((x.changes[x.selected] || 0) * 100);
        return `<div class="slider"><label><strong>${esc(nodeLabel(g, x.selected))}</strong>: <span id="sw">${sliderWord(v)}</span></label>
          <input type="range" min="-100" max="100" step="10" value="${v}" data-action-input="slider" aria-label="Насколько изменить">
          <div class="scale"><span>меньше</span><span>больше</span></div></div>`;
      })() : ''}
      ${changed.length ? `<ul class="changes">${changed.map(([id, v]) => `<li>${v > 0 ? '▲' : '▼'} ${esc(nodeLabel(g, id))} <button class="link" data-action="unchange" data-id="${esc(id)}">убрать</button></li>`).join('')}</ul>` : ''}
    </div>
    <div class="step ${changed.length ? '' : 'disabled'}"><h3><span class="n">2</span> Твой прогноз</h3>
      <p class="muted small">Как думаешь, что изменится? Выбери узел и отметь — до запуска. Это главное упражнение.</p>
      <div class="seg"><button class="${x.tool === 'change' ? 'on' : ''}" data-action="tool" data-tool="change">Меняю условие</button><button class="${x.tool === 'predict' ? 'on' : ''}" data-action="tool" data-tool="predict">Делаю прогноз</button></div>
      ${x.tool === 'predict' && x.selected && !(x.selected in x.changes) ? `<div class="predict"><strong>${esc(nodeLabel(g, x.selected))}</strong>
        <div class="row">${['up', 'down', 'same'].map((t) => `<button class="btn ${x.predictions[x.selected] === t ? 'primary' : ''}" data-action="predict" data-t="${t}">${ARROW[t]} ${TREND_WORD[t]}</button>`).join('')}</div></div>` : ''}
      ${Object.keys(x.predictions).length ? `<ul class="changes">${Object.entries(x.predictions).map(([id, t]) => `<li>${ARROW[t]}? ${esc(nodeLabel(g, id))}</li>`).join('')}</ul>` : ''}
    </div>
    <button class="btn primary wide" data-action="run" ${changed.length ? '' : 'disabled'}>▶ Запустить</button>`;
  } else if (x.phase === 'running') {
    h += '<div class="step"><h3>Изменение идёт по цепочке…</h3><p class="muted">Следи за схемой: сначала меняются ближайшие факторы, потом дальние.</p></div>';
  } else {
    const r = x.result;
    const checks = checkPredictions(r, x.predictions);
    const affected = Object.keys(r.total).filter((id) => !(id in x.changes) && trend(r.total[id]) !== 'same');
    h += checks.length ? `<div class="step"><h3>Твой прогноз: ${checks.filter((c) => c.correct).length} из ${checks.length}</h3><ul class="checks">${checks.map((c) => `<li class="${c.correct ? 'ok' : 'bad'}">${c.correct ? '✓' : '✗'} ${esc(nodeLabel(g, c.node))}: ты думал «${TREND_WORD[c.guess]}», на схеме — ${TREND_PAST[c.actual]}</li>`).join('')}</ul></div>` : '';
    h += `<div class="step"><h3>Последствия по времени</h3><div class="timeline">${delays.map((label, i) => {
      const items = affected.filter((id) => (r.when[id] ?? 0) === i).sort((a, b) => Math.abs(r.total[b]) - Math.abs(r.total[a]));
      return `<div class="tcol"><span class="tlabel">${esc(label)}</span>${items.map((id) => `<button class="titem ${trend(r.total[id])}" data-action="why" data-id="${esc(id)}">${ARROW[trend(r.total[id])]} ${esc(nodeLabel(g, id))}</button>`).join('') || '<span class="muted small">—</span>'}</div>`;
    }).join('')}</div><p class="muted small">Нажми на последствие или на узел схемы, чтобы увидеть цепочку «почему».</p></div>`;
    if (x.info?.why) h += `<div class="info">${x.info.why}</div>`;
    const loops = findLoops(g);
    if (loops.length) h += `<div class="step"><h3>Петли обратной связи</h3><ul class="list">${loops.map((l) => `<li><strong>${l.type === 'reinforcing' ? 'Усиливающая' : 'Стабилизирующая'}:</strong> ${l.nodes.map((n) => esc(nodeLabel(g, n))).join(' → ')} → ${esc(nodeLabel(g, l.nodes[0]))}</li>`).join('')}</ul></div>`;
    h += `<div class="step"><h3>🦉 Разбор с Совой</h3><p>${esc(localDebrief(g, r, checks)).replace(/\n/g, '<br>')}</p>
      ${x.debrief ? `<div class="msg assistant">${esc(x.debrief).replace(/\n/g, '<br>')}<span class="by">нейросеть</span></div>` : ''}
      ${(S.server?.llm || S.browserLLM) && !x.debrief ? `<button class="btn" data-action="debrief" ${x.busy ? 'disabled' : ''}>${x.busy ? 'Сова думает…' : 'Обсудить с Совой подробнее'}</button>` : ''}
      ${g.questions?.length ? `<p class="question"><strong>Подумай:</strong> ${esc(g.questions[0])}</p>` : ''}</div>
      <button class="btn wide" data-action="reset">↺ Попробовать другое условие</button>`;
  }
  panel.innerHTML = h;
}

function highlightEvidence(text, g) {
  let html = esc(text);
  for (const q of new Set(g.edges.map((e) => e.evidence))) {
    const eq = esc(q);
    if (html.includes(eq)) html = html.replace(eq, `<mark>${eq}</mark>`);
  }
  return html;
}

function chainText(g, r, path) {
  return path.map((e) => `«${nodeLabel(g, e.from)}» ${ARROW[trend(r.total[e.from])]} → «${nodeLabel(g, e.to)}» ${ARROW[trend(r.total[e.to])]}, потому что «${e.evidence}»`).join(';\n');
}

function showWhy(id) {
  const g = graphById(S.ex.graphId);
  const x = S.ex;
  const r = x.result;
  const path = pathTo(r, id);
  if (!path.length) {
    x.info = { why: `<strong>${esc(nodeLabel(g, id))}</strong><p>${id in x.changes ? 'Это условие ты изменил сам.' : 'Этот фактор не изменился: до него изменение не дошло или оказалось слишком слабым.'}</p>` };
    x.highlight = null;
  } else {
    x.info = { why: `<strong>Почему ${esc(nodeLabel(g, id))} ${TREND_PAST[trend(r.total[id])]}?</strong><ol class="chain">${path.map((e) => `<li>${esc(nodeLabel(g, e.from))} ${ARROW[trend(r.total[e.from])]} → ${esc(nodeLabel(g, e.to))} ${ARROW[trend(r.total[e.to])]}<blockquote>«${esc(e.evidence)}»</blockquote></li>`).join('')}</ol>` };
    x.highlight = new Set(path);
  }
  drawExploreGraph();
  drawPanel();
}

function localDebrief(g, r, checks) {
  const lines = [];
  const wrong = checks.filter((c) => !c.correct);
  if (checks.length) {
    lines.push(wrong.length ? `Ты угадал ${checks.length - wrong.length} из ${checks.length}. Разберём, где схема повела себя иначе.` : 'Все прогнозы верны — отличное рассуждение!');
    for (const c of wrong.slice(0, 2)) {
      const p = pathTo(r, c.node);
      lines.push(p.length ? `«${nodeLabel(g, c.node)}» ${TREND_PAST[c.actual]}: ${chainText(g, r, p)}.` : `«${nodeLabel(g, c.node)}» не изменился: изменение до него не дошло.`);
    }
  } else {
    const top = Object.keys(r.total).filter((id) => !(id in S.ex.changes)).sort((a, b) => Math.abs(r.total[b]) - Math.abs(r.total[a]))[0];
    if (top) lines.push(`Сильнее всего изменился фактор «${nodeLabel(g, top)}». Цепочка: ${chainText(g, r, pathTo(r, top))}.`);
    lines.push('В следующий раз сначала сделай прогноз — так ты лучше проверишь своё понимание.');
  }
  const loops = findLoops(g).filter((l) => l.nodes.some((n) => n in r.total));
  if (loops.length) lines.push(`Заметь петлю: ${loops[0].nodes.map((n) => nodeLabel(g, n)).join(' → ')} → ${nodeLabel(g, loops[0].nodes[0])}. Она ${loops[0].type === 'reinforcing' ? 'усиливает' : 'гасит'} начальное изменение.`);
  lines.push('Помни: схема — упрощённая модель. Если не согласен со связью, нажми на стрелку и проверь цитату.');
  return lines.join('\n');
}

function runSimulation() {
  const g = graphById(S.ex.graphId);
  const x = S.ex;
  x.result = simulate(g, x.changes);
  x.phase = 'running';
  x.info = null;
  x.highlight = null;
  x.debrief = '';
  drawPanel();
  if (reduceMotion()) { // без анимации: сразу итог
    x.phase = 'done';
    drawExploreGraph(); drawPanel();
    return;
  }
  let wave = 0;
  const step = () => {
    if (S.ex !== x || !document.getElementById('graph')) { // ученик ушёл со страницы
      Object.assign(x, { anim: null, highlight: null, phase: 'done' });
      return;
    }
    x.anim = {};
    for (const ev of x.result.events) if (ev.wave <= wave) x.anim[ev.node] = ev.total;
    x.highlight = new Set(x.result.events.filter((ev) => ev.wave === wave && ev.via).map((ev) => ev.via));
    drawExploreGraph();
    if (wave++ < x.result.waves) setTimeout(step, 650);
    else setTimeout(() => {
      Object.assign(x, { anim: null, highlight: null, phase: 'done' });
      if (S.ex === x && document.getElementById('graph')) { drawExploreGraph(); drawPanel(); }
    }, 650);
  };
  step();
}

async function debriefWithSova() {
  const g = graphById(S.ex.graphId);
  const x = S.ex;
  x.busy = true;
  drawPanel();
  const r = x.result;
  const effects = Object.keys(r.total).filter((id) => !(id in x.changes)).map((id) => ({ factor: nodeLabel(g, id), change: TREND_PAST[trend(r.total[id])], chain: chainText(g, r, pathTo(r, id)) }));
  const context = {
    schema: g.title,
    changed: Object.entries(x.changes).map(([id, v]) => `${nodeLabel(g, id)}: ${sliderWord(Math.round(v * 100))}`),
    predictions: checkPredictions(r, x.predictions).map((c) => ({ factor: nodeLabel(g, c.node), guess: TREND_WORD[c.guess], result: TREND_PAST[c.actual], correct: c.correct })),
    effects,
    loops: findLoops(g).map((l) => `${l.type === 'reinforcing' ? 'усиливающая' : 'стабилизирующая'}: ${l.nodes.map((n) => nodeLabel(g, n)).join(' → ')}`),
  };
  try {
    if (S.server) {
      const res = await postJSON('api/chat', { mode: 'debrief', context });
      x.debrief = res.answer || 'Нейросеть сейчас недоступна.';
    } else {
      x.debrief = await chatBrowser(S.browserLLM, [{ role: 'system', content: DEBRIEF }, { role: 'user', content: JSON.stringify(context) }], 400);
    }
  } catch (e) {
    x.debrief = `Не получилось: ${e.message}`;
  }
  x.busy = false;
  drawPanel();
}

// ---------- «Собери сам» ----------
// Пошагово: одна фраза из параграфа за раз и три простых вопроса — что причина, что следствие и как они связаны.
// Схема растёт из найденных связей, поэтому её расположение не подсказывает ответ заранее.

/** Перемешивание, одинаковое при каждом открытии одной и той же схемы. */
function seededShuffle(items, seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Параграф с подсвеченной фразой текущего шага (если фраза дословно есть в тексте). */
function markEvidence(text, evidence) {
  const i = evidence ? text.toLowerCase().indexOf(evidence.toLowerCase()) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark id="bd-mark">${esc(text.slice(i, i + evidence.length))}</mark>${esc(text.slice(i + evidence.length))}`;
}

/** Что именно не так в ответе ученика — чтобы подсказка была по делу, а не «неверно». */
function buildFeedback(g, edge, pick) {
  const L = (id) => `«${esc(nodeLabel(g, id))}»`;
  if (pick.from === edge.to && pick.to === edge.from) return `Наоборот: в тексте ${L(edge.from)} влияет на ${L(edge.to)}, а не ${L(edge.to)} на ${L(edge.from)}. Что случилось сначала?`;
  if (pick.from !== edge.from && pick.to !== edge.to) return 'Ни причина, ни следствие не совпали. Перечитай подсвеченную фразу: о каких двух вещах в ней говорится?';
  if (pick.from !== edge.from) return `Следствие выбрано верно — ${L(edge.to)}. А что в этой фразе его меняет?`;
  if (pick.to !== edge.to) return `Причина выбрана верно — ${L(edge.from)}. А что от неё меняется в этой фразе?`;
  return `Причина и следствие верные. Но подумай ещё: если ${L(edge.from)} станет больше, ${L(edge.to)} станет больше или меньше?`;
}

function buildState(g) {
  const saved = store.get(`build-${g.id}`, null);
  const n = g.edges.length;
  const valid = saved && Array.isArray(saved.done) && saved.done.every((d) => Number.isInteger(d.i) && d.i < n);
  return {
    graphId: g.id,
    step: valid ? Math.min(saved.step, n) : 0,
    done: valid ? saved.done : [], // [{ i: номер связи, first: с первой попытки }]
    pick: { from: null, to: null, sign: 0 },
    tries: 0,
    feedback: '',
    solved: false, // текущий шаг решён и ждёт «Дальше»
    revealed: false,
  };
}
const saveBuild = (b) => store.set(`build-${b.graphId}`, { step: b.step, done: b.done });

function viewBuild(id) {
  const g = id && graphById(id);
  if (!g) {
    app.innerHTML = `<h1>Собери сам</h1>
    <p class="muted">Читаешь параграф по одной фразе и отвечаешь на три вопроса: <strong>что причина</strong>, <strong>что следствие</strong> и <strong>как они связаны</strong>. Из твоих ответов шаг за шагом складывается схема причин и следствий. Потом её можно «запустить» во вкладке «Что будет, если…».</p>
    ${graphCards('build')}`;
    return;
  }
  if (!S.bd || S.bd.graphId !== id) S.bd = buildState(g);
  const b = S.bd;
  const total = g.edges.length;
  const text = textOf(g);
  const progress = `<div class="bd-progress" role="progressbar" aria-label="Найдено связей" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${b.done.length}"><span style="width:${(b.done.length / total) * 100}%"></span></div>`;

  // Готовая схема из найденных связей: только те факторы, которые уже участвуют.
  const foundEdges = b.done.map((d) => g.edges[d.i]);
  const used = new Set(foundEdges.flatMap((e) => [e.from, e.to]));
  const partial = { ...g, nodes: g.nodes.filter((n) => used.has(n.id)), edges: foundEdges };

  if (b.step >= total) {
    const first = b.done.filter((d) => d.first).length;
    app.innerHTML = `
    <a class="back" href="#/build">← Все схемы</a>
    <h1>Собери сам: ${esc(g.title)}</h1>
    ${progress}
    <div class="step bd-finish">
      <h2>🎉 Схема собрана!</h2>
      <p>Найдены все связи из параграфа: ${total}. С первой попытки — <strong>${first} из ${total}</strong>.</p>
      <p class="muted">Теперь проверь, как схема работает: поменяй один фактор и посмотри, что изменится по цепочке.</p>
      <div class="row"><a class="btn primary" href="#/explore/${esc(g.id)}">Что будет, если… →</a><button class="btn" data-action="bd-restart">Собрать заново</button></div>
    </div>
    <h2 class="bd-h">Твоя схема</h2>
    <div class="graph-wrap" id="graph"></div>`;
    renderGraph(document.getElementById('graph'), partial);
    return;
  }

  const edge = g.edges[b.step];
  const nodes = seededShuffle(g.nodes, g.id);
  const p = b.pick;
  const chips = (field, exclude) => nodes.map((n) => {
    const on = p[field] === n.id;
    const off = n.id === exclude || b.solved;
    return `<button type="button" class="chip bd-chip${on ? ' on' : ''}" data-action="bd-pick" data-f="${field}" data-id="${esc(n.id)}" aria-pressed="${on}" ${off ? 'disabled' : ''}>${esc(n.label)}</button>`;
  }).join('');
  const A = p.from ? `«${esc(nodeLabel(g, p.from))}»` : '<span class="bd-blank">причина</span>';
  const B = p.to ? `«${esc(nodeLabel(g, p.to))}»` : '<span class="bd-blank">следствие</span>';
  const signBtn = (s, word) => `<button type="button" class="bd-sign${p.sign === s ? ' on' : ''}" data-action="bd-pick" data-f="sign" data-id="${s}" aria-pressed="${p.sign === s}" ${b.solved ? 'disabled' : ''}>
      <span class="bd-sign-icon" aria-hidden="true">${s > 0 ? '▲ ▲' : '▲ ▼'}</span><span>Чем больше ${A}, тем <strong>${word}</strong> ${B}</span></button>`;
  const ready = p.from && p.to && p.sign;
  const inText = text.toLowerCase().includes((edge.evidence || '').toLowerCase()) && edge.evidence;

  app.innerHTML = `
  <a class="back" href="#/build">← Все схемы</a>
  <div class="ex-head"><h1>Собери сам: ${esc(g.title)}</h1><span class="badge">Связь ${b.step + 1} из ${total}</span></div>
  ${progress}
  <details class="bd-text" ${inText ? 'open' : ''}><summary>Параграф целиком</summary><div class="paragraph">${markEvidence(text, edge.evidence)}</div></details>

  <section class="step bd-card" aria-labelledby="bd-q">
    <p class="muted small" id="bd-q">Прочитай фразу из текста:</p>
    <blockquote class="bd-quote">${edge.evidence ? `«${esc(edge.evidence)}»` : `Найди в параграфе, как связаны «${esc(nodeLabel(g, edge.from))}» и «${esc(nodeLabel(g, edge.to))}».`}</blockquote>

    <h3><span class="n">1</span> Что здесь <u>причина</u> — что меняется сначала?</h3>
    <div class="bd-chips" role="group" aria-label="Причина">${chips('from', p.to)}</div>

    <h3><span class="n">2</span> А что от этого <u>меняется</u> — следствие?</h3>
    <div class="bd-chips" role="group" aria-label="Следствие">${chips('to', p.from)}</div>

    <h3><span class="n">3</span> Как они связаны?</h3>
    <div class="bd-signs" role="group" aria-label="Как связаны">${signBtn(1, 'больше')}${signBtn(-1, 'меньше')}</div>

    <div id="bd-feedback" role="status" aria-live="polite">${b.feedback}</div>
    <div class="row">
      ${b.solved
        ? `<button class="btn primary" data-action="bd-next">${b.step + 1 < total ? 'Дальше →' : 'Готово →'}</button>`
        : `<button class="btn primary" data-action="bd-check" ${ready ? '' : 'disabled'}>Проверить</button>
           ${b.tries >= 2 ? '<button class="btn" data-action="bd-reveal">Показать ответ</button>' : ''}`}
    </div>
  </section>

  <h2 class="bd-h">Твоя схема ${b.done.length ? `<span class="muted small">· ${b.done.length} из ${total}</span>` : ''}</h2>
  ${b.done.length ? '<div class="graph-wrap" id="graph"></div>' : '<p class="muted">Пока пусто. Каждая найденная связь появится здесь стрелкой.</p>'}
  ${b.done.length || b.step ? '<p><button class="btn ghost" data-action="bd-restart">Начать сначала</button></p>' : ''}`;
  if (b.done.length) renderGraph(document.getElementById('graph'), partial);
}

function buildCheck() {
  const b = S.bd;
  const g = graphById(b.graphId);
  const edge = g.edges[b.step];
  const p = b.pick;
  if (p.from === edge.from && p.to === edge.to && p.sign === edge.sign) {
    b.solved = true;
    b.done.push({ i: b.step, first: b.tries === 0 && !b.revealed });
    b.feedback = `<div class="info good">✓ Верно! ${b.tries === 0 ? 'С первой попытки. ' : ''}Связь «${esc(nodeLabel(g, edge.from))}» ${edge.sign > 0 ? '▲→▲' : '▲→▼'} «${esc(nodeLabel(g, edge.to))}» добавлена в схему.</div>`;
    saveBuild(b);
  } else {
    b.tries += 1;
    b.feedback = `<div class="info bad">${buildFeedback(g, edge, p)}${b.tries >= 2 ? ' <br><span class="small">Если не получается — можно посмотреть ответ.</span>' : ''}</div>`;
  }
  viewBuild(b.graphId);
  document.getElementById('bd-feedback')?.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

// ---------- опыты PhET ----------
// Симуляции PhET (Университет Колорадо, CC BY 4.0) лежат в web/phet/ и открываются без интернета.
const LAB_SUBJECTS = { physics: '⚡ Физика', algebra: '𝑥 Алгебра', geometry: '△ Геометрия' };
const PHET_CREDIT = 'Симуляции <a href="https://phet.colorado.edu/ru/" target="_blank" rel="noopener">PhET Interactive Simulations</a>, Университет Колорадо в Боулдере, лицензия <a href="https://creativecommons.org/licenses/by/4.0/deed.ru" target="_blank" rel="noopener">CC BY 4.0</a>.';
const PHET_CACHE = 'znanie-phet';
// yotta=false — симуляция не отправляет статистику разработчикам (Google Analytics и счётчик PhET);
// allowLinks=false — из симуляции нельзя уйти по ссылке в интернет.
const PHET_PARAMS = '?yotta=false&allowLinks=false';
const labsFor = (docId) => (S.labs || []).filter((l) => l.topics.includes(docId));
const labGrade = (l) => Math.min(...l.topics.map((t) => S.texts.find((d) => d.id === t)?.grade || 11));

function viewLabs(id) {
  const lab = id && S.labs.find((l) => l.id === id);
  if (lab) {
    const topics = lab.topics.map((t) => S.texts.find((d) => d.id === t)).filter(Boolean);
    app.innerHTML = `
    <a class="back" href="#/labs">← Все опыты</a>
    <div class="ex-head"><h1>🧪 ${esc(lab.title)}</h1><span class="tag">${LAB_SUBJECTS[lab.subject]} · с ${labGrade(lab)} класса</span></div>
    <div class="info lab-task"><strong>Попробуй:</strong> ${esc(lab.task)}</div>
    <div class="lab-frame"><iframe id="lab-frame" src="phet/${esc(lab.id)}.html${PHET_PARAMS}" title="Симуляция «${esc(lab.title)}»" allow="fullscreen" allowfullscreen loading="lazy"></iframe></div>
    <div class="row">
      <button class="btn" data-action="lab-full">⛶ Во весь экран</button>
      <a class="btn ghost" href="phet/${esc(lab.id)}.html${PHET_PARAMS}" target="_blank" rel="noopener">Открыть в отдельной вкладке</a>
      <button class="btn" data-action="ask-about" data-title="${esc(topics[0]?.title || lab.title)}">🦉 Обсудить с Совой</button>
    </div>
    <h2>Темы в библиотеке</h2>
    <div class="row">${topics.map((d) => `<a class="chip" href="#/library/${d.id}">${esc(d.title)} · ${d.grade} кл.</a>`).join('')}</div>
    <p class="note">${PHET_CREDIT}</p>`;
    return;
  }
  const f = (S.labFilter ||= 'all');
  const list = S.labs.filter((l) => f === 'all' || l.subject === f).sort((a, b) => labGrade(a) - labGrade(b));
  app.innerHTML = `
  <h1>Опыты</h1>
  <p class="muted">Интерактивные лаборатории: меняй условия и смотри, что получится. К каждому опыту есть задание и ссылки на темы библиотеки. Всё работает без интернета.</p>
  <div class="row" role="group" aria-label="Предмет">
    ${[['all', 'Все'], ...Object.entries(LAB_SUBJECTS)].map(([k, v]) => `<button class="chip${f === k ? ' graph' : ''}" data-action="lab-filter" data-f="${k}" aria-pressed="${f === k}">${v}</button>`).join('')}
  </div>
  <div class="cards">${list.map((l) => `
    <a class="card lab-card" href="#/labs/${esc(l.id)}">
      <span class="tag">${LAB_SUBJECTS[l.subject]} · с ${labGrade(l)} класса</span>
      <strong>${esc(l.title)}</strong>
      <span class="muted">${esc(l.task)}</span>
    </a>`).join('')}</div>
  ${S.server ? '' : `<section class="step lab-save">
    <h3>📥 Сохранить опыты на это устройство</h3>
    <p class="muted small">Обычно опыт сохраняется, когда его открывают в первый раз. Чтобы заранее сохранить все ${S.labs.length} (около 95 МБ), нажми кнопку, пока есть интернет.</p>
    <button class="btn" data-action="labs-save" id="labs-save">Сохранить все опыты</button> <span id="labs-save-status" class="muted small" role="status"></span>
  </section>`}
  <p class="note">${PHET_CREDIT}</p>`;
  if (!S.server) labsSavedCount().then((n) => {
    const el = document.getElementById('labs-save-status');
    if (el && n) el.textContent = n === S.labs.length ? '✓ Все опыты уже сохранены' : `Сохранено ${n} из ${S.labs.length}`;
  });
}

async function labsSavedCount() {
  if (!('caches' in window)) return 0;
  try {
    const c = await caches.open(PHET_CACHE);
    const keys = new Set((await c.keys()).map((r) => new URL(r.url).pathname.split('/').pop()));
    return S.labs.filter((l) => keys.has(`${l.id}.html`)).length;
  } catch { return 0; }
}

async function saveAllLabs(btn) {
  const status = document.getElementById('labs-save-status');
  if (!('caches' in window)) { status.textContent = 'Этот браузер не умеет сохранять файлы для работы без интернета.'; return; }
  btn.disabled = true;
  const c = await caches.open(PHET_CACHE);
  let ok = 0;
  let failed = 0;
  for (const l of S.labs) {
    const url = new URL(`phet/${l.id}.html`, location.href).href;
    try {
      if (!(await c.match(url))) {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        await c.put(url, r);
      }
      ok++;
    } catch { failed++; }
    status.textContent = `Сохранено ${ok} из ${S.labs.length}…`;
  }
  status.textContent = failed ? `Сохранено ${ok} из ${S.labs.length}. Остальные не скачались — проверь интернет и нажми ещё раз.` : '✓ Все опыты сохранены: теперь они откроются без интернета';
  btn.disabled = false;
}

// ---------- кабинет учителя ----------
function viewTeacher() {
  const t = S.teacher;
  if (!isTeacher()) {
    app.innerHTML = `
    <h1>Кабинет учителя</h1>
    <p><span class="badge">🔒 Режим ученика (только чтение)</span></p>
    <p class="muted">Здесь учитель проверяет схемы, включает режим контрольной и смотрит, какие темы даются классу труднее. Ученикам доступны готовые схемы во вкладке «Что будет, если…».</p>
    <form data-form="pin" class="pin-form" autocomplete="off">
      <label for="pin">PIN-код учителя</label>
      <div class="row"><input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" required aria-describedby="pin-help">
      <button class="btn primary">Войти</button></div>
      <p id="pin-help" class="muted small">${S.server ? 'PIN задаётся на коробке (server/teacher.py или запуск с ключом --pin).' : 'На сайте без коробки PIN проверяется в браузере, а режим контрольной действует только на этом устройстве.'}</p>
      ${t.pinError ? `<div class="info bad" role="alert">${esc(t.pinError)}</div>` : ''}
    </form>`;
    return;
  }
  const canExtract = S.server?.llm;
  const reports = store.get('reports', []);
  if (!t.summary) loadSummary();
  app.innerHTML = `
  <div class="ex-head"><h1>Кабинет учителя</h1><div class="row"><span class="badge on">✓ Режим учителя</span><button class="btn ghost" data-action="t-logout">Выйти</button></div></div>

  <section class="step">
    <h3>📝 Режим контрольной работы</h3>
    <label class="switch"><input type="checkbox" role="switch" data-action-change="exam" ${S.exam ? 'checked' : ''}><span>${S.exam ? 'Включён: Сова даёт только подсказки, кнопки «Покажи ответ», «Объясни» и «Объясни проще» скрыты' : 'Выключен'}</span></label>
    <p class="muted small">${S.server ? 'Действует на всех устройствах, подключённых к коробке (обновляется в течение 15 секунд). Запрет проверяет сервер, поэтому обойти его из браузера нельзя.' : 'Без коробки режим действует только на этом устройстве.'}</p>
  </section>

  <section class="step">
    <h3>📊 Сложные темы класса</h3>
    <p class="muted small">Обезличенно: без имён и текстов вопросов — только сколько раз по теме спрашивали Сову, просили подсказку, готовый ответ или жаловались на ошибку. ${S.server ? 'Данные со всех устройств класса.' : 'Данные с этого устройства.'}</p>
    ${t.summary === null ? '<p class="muted">Загрузка…</p>' : t.summary.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">Тема</th><th scope="col">Вопросов</th><th scope="col">Подсказок</th><th scope="col">Готовых ответов</th><th scope="col">«Тут ошибка»</th></tr></thead>
      <tbody>${t.summary.map((r) => `<tr><th scope="row"><a href="#/library/${esc(r.docId)}">${esc(r.title)}</a></th><td>${r.question}</td><td>${r.hint}</td><td>${r.answer}</td><td>${r.report}</td></tr>`).join('')}</tbody></table></div>
      <div class="row"><button class="btn" data-action="t-refresh">↻ Обновить</button><button class="btn ghost" data-action="t-reset-stats">Очистить статистику</button></div>` : '<p class="muted">Пока пусто: ученики ещё не задавали Сове вопросов по темам библиотеки.</p><button class="btn" data-action="t-refresh">↻ Обновить</button>'}
    ${reports.length ? `<details><summary>Жалобы «Тут ошибка» на этом устройстве: ${reports.length}</summary><ul class="list">${reports.slice(-20).reverse().map((r) => `<li><strong>${esc(r.q || '')}</strong><br><span class="muted small">${esc((r.a || '').slice(0, 200))}</span></li>`).join('')}</ul></details>` : ''}
  </section>

  <section class="step">
    <h3>🔀 Редактор схем</h3>
    <p class="muted">Вставьте параграф — нейросеть предложит схему причин и следствий. Каждая связь подтверждается цитатой; связи без цитаты убираются автоматически. Проверьте схему и одобрите — тогда она появится у учеников.</p>
    ${canExtract ? '' : `<div class="info">${S.server ? 'Нейросеть на коробке не запущена: запустите Ollama и скачайте модель (<code>ollama pull qwen2.5:3b</code>), затем перезапустите сервер.' : 'Это сайт без коробки. Построение схем работает на школьной коробке: запустите «Запустить.bat» или <code>python server/server.py</code> с Ollama.'}</div>`}
    <form data-form="extract" class="stack">
      <textarea name="text" rows="7" placeholder="Текст параграфа…" aria-label="Текст параграфа" ${canExtract ? '' : 'disabled'}>${esc(t.text)}</textarea>
      <div class="row"><button class="btn primary" ${canExtract && !t.busy ? '' : 'disabled'}>${t.busy ? 'Строю схему… это может занять минуту' : 'Построить схему'}</button>
      <button type="button" class="btn ghost" data-action="sample-text" ${canExtract ? '' : 'disabled'}>Вставить пример</button></div>
    </form>
    ${t.error ? `<div class="info bad" role="alert">${esc(t.error)}</div>` : ''}
    ${t.graph ? `
      <h3>Черновик: <input class="title-input" value="${esc(t.graph.title)}" data-action-input="t-title" aria-label="Название схемы"></h3>
      ${t.notes.length ? `<details class="notes"><summary>Проверка цитат: ${t.notes.length} замечаний</summary><ul>${t.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : '<p class="muted">Все связи подтверждены цитатами.</p>'}
      <div class="graph-wrap" id="graph"></div>
      <h3>Связи</h3>
      <ul class="edges-edit">${t.graph.edges.map((e, i) => `<li><button class="chip" data-action="t-sign" data-i="${i}" aria-label="Сменить знак связи">${e.sign > 0 ? '+' : '−'}</button> ${esc(nodeLabel(t.graph, e.from))} → ${esc(nodeLabel(t.graph, e.to))} <span class="muted small">«${esc(e.evidence)}»</span> <button class="link" data-action="t-del" data-i="${i}">удалить</button></li>`).join('')}</ul>
      <div class="row"><button class="btn primary" data-action="t-publish">Одобрить схему ✓</button><button class="btn" data-action="t-download">Скачать JSON</button></div>` : ''}
  </section>`;
  if (t.graph) renderGraph(document.getElementById('graph'), t.graph, {});
}

async function loadSummary() {
  const t = S.teacher;
  t.summary = [];
  try {
    t.summary = S.server ? (await fetch('api/teacher/summary', { headers: { 'X-Teacher-Token': S.auth } }).then(async (r) => {
      if (r.status === 403) { logoutTeacher(); throw new Error('expired'); }
      return r.json();
    })).topics : localSummary();
  } catch { /* вход истёк или коробка недоступна */ }
  if (location.hash.startsWith('#/teacher')) viewTeacher();
}

// ---------- как подключить коробку ----------
const ICONS = {
  box: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="8" y="14" width="48" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M4 50h56" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M27 29l5 5 9-10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 44v6" stroke="currentColor" stroke-width="3"/></svg>',
  share: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="40" r="4" fill="currentColor"/><path d="M22 30a14 14 0 0 1 20 0M15 23a24 24 0 0 1 34 0M8 16a34 34 0 0 1 48 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M32 44v12M24 56h16" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  qr: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="16" y="6" width="32" height="52" rx="5" fill="none" stroke="currentColor" stroke-width="3"/><rect x="23" y="16" width="8" height="8" fill="currentColor"/><rect x="33" y="16" width="8" height="8" fill="currentColor"/><rect x="23" y="26" width="8" height="8" fill="currentColor"/><rect x="35" y="28" width="4" height="4" fill="currentColor"/><path d="M28 48h8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  learn: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M6 14c9-3 18-3 26 3 8-6 17-6 26-3v36c-9-3-18-3-26 3-8-6-17-6-26-3z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M32 17v36" stroke="currentColor" stroke-width="3"/><circle cx="19" cy="28" r="3" fill="currentColor"/><circle cx="45" cy="28" r="3" fill="currentColor"/></svg>',
};

function connectAddresses() {
  if (S.server?.lan?.length) return S.server.lan;
  if (!S.server && /^https?:/.test(location.protocol) && !/^(localhost|127\.|\[::1\])/.test(location.hostname)) return [location.origin + location.pathname];
  return [];
}

function viewConnect() {
  const urls = connectAddresses();
  const pick = urls.includes(S.qrUrl) ? S.qrUrl : urls[0];
  const checks = store.get('checklist', {});
  const need = [
    ['laptop', 'Ноутбук или мини-компьютер (это и есть «Коробка»). Для нейросети нужно от 8 ГБ памяти, без неё подойдёт любой.'],
    ['folder', 'Папка «Знание в коробке» на этом компьютере (скопируй с флешки или скачай один раз).'],
    ['python', 'Программа Python — ставится один раз, бесплатно.'],
    ['ollama', 'Программа Ollama и модель для Совы — по желанию: без неё Сова отвечает подсказками из книг.'],
    ['phones', 'Телефоны, планшеты или компьютеры учеников — подойдёт любой браузер.'],
    ['power', 'Розетка или заряженный аккумулятор.'],
  ];
  let qrBlock;
  if (pick) {
    qrBlock = `<div class="qr-card"><div class="qr">${qrSVG(pick, { size: 220, label: `QR-код адреса ${pick}` })}</div>
      <div><p><strong>Адрес для телефонов:</strong></p><p class="addr">${esc(pick)}</p>
      ${urls.length > 1 ? `<label class="muted small">Другой адрес этой коробки <select data-action-change="qr-url">${urls.map((u) => `<option ${u === pick ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>` : ''}
      <p class="muted small">Если камера не открывает ссылку, введи адрес в браузере вручную. Телефон должен быть подключён к раздаче Коробки.</p>
      <button class="btn" data-action="print">🖨 Распечатать QR-код для класса</button></div></div>`;
  } else if (S.server) {
    qrBlock = `<div class="info">Сейчас Коробка открыта только для этого компьютера. Закрой окно сервера и запусти <strong>«Запустить для класса.bat»</strong> — тогда здесь появится QR-код для телефонов. Если раздача уже включена, а кода нет — обнови страницу.</div>`;
  } else {
    qrBlock = '<div class="info">QR-код появится, когда сайт открыт с Коробки в режиме «для класса» или по сетевому адресу.</div>';
  }
  app.innerHTML = `
  <h1>Как подключить Коробку</h1>
  <p class="lead">Четыре шага — и весь класс учится без интернета. Справится любой: и ученик, и учитель.</p>
  <ol class="steps4">
    <li><span class="ico">${ICONS.box}</span><span class="n">1</span><strong>Включи Коробку</strong><span>Подключи ноутбук к розетке и дважды нажми <b>«Запустить для класса»</b> в папке проекта.</span></li>
    <li><span class="ico">${ICONS.share}</span><span class="n">2</span><strong>Включи раздачу сети</strong><span>В Windows: Параметры → Сеть → <b>«Мобильный хот-спот»</b> → Вкл. Интернет для этого не нужен.</span></li>
    <li><span class="ico">${ICONS.qr}</span><span class="n">3</span><strong>Наведи камеру на QR-код</strong><span>Ученики подключаются к раздаче Коробки и сканируют код ниже — сайт откроется сам.</span></li>
    <li><span class="ico">${ICONS.learn}</span><span class="n">4</span><strong>Учись без интернета!</strong><span>Книги, Сова и схемы «Что будет, если…» уже внутри Коробки.</span></li>
  </ol>
  <h2>QR-код для телефонов</h2>
  ${qrBlock}
  <p class="muted small">Если Windows спросит, разрешить ли Python доступ к сети, — нажми «Разрешить» (для частных сетей).</p>

  <h2>Как это устроено внутри (простыми словами)</h2>
  <figure class="inside">
    <svg viewBox="0 0 640 300" role="img" aria-labelledby="inside-t">
      <title id="inside-t">Коробка содержит библиотеку, Сову и симулятор; телефоны учеников подключаются к ней напрямую, интернет не нужен</title>
      <rect x="150" y="20" width="340" height="260" rx="18" class="in-box"/>
      <text x="320" y="50" class="in-title">Коробка</text>
      <g transform="translate(175 70)"><rect width="290" height="56" rx="10" class="in-item"/><text x="16" y="35" class="in-text">📚 Библиотека — книжный шкаф</text></g>
      <g transform="translate(175 136)"><rect width="290" height="56" rx="10" class="in-item"/><text x="16" y="35" class="in-text">🦉 Сова — читает только их</text></g>
      <g transform="translate(175 202)"><rect width="290" height="56" rx="10" class="in-item"/><text x="16" y="35" class="in-text">🔀 Симулятор последствий</text></g>
      <g class="in-phone"><rect x="30" y="60" width="60" height="100" rx="10"/><rect x="30" y="180" width="60" height="100" rx="10"/><rect x="550" y="120" width="60" height="100" rx="10"/></g>
      <path d="M90 110H150M90 230H150M490 170H550" class="in-link"/>
      <g transform="translate(540 30)"><path d="M10 40a18 18 0 0 1 4-35 24 24 0 0 1 44 6 15 15 0 0 1 2 29z" class="in-cloud"/><path d="M8 6l56 40" class="in-cross"/></g>
      <text x="575" y="95" class="in-small">не нужен</text>
    </svg>
  </figure>
  <div class="cards analogies">
    <div class="card"><span class="icon">📚</span><strong>Библиотека = книжный шкаф</strong><span class="muted">400 тем по истории Казахстана, физике, алгебре и геометрии лежат внутри Коробки.</span></div>
    <div class="card"><span class="icon">🦉</span><strong>Сова = умный помощник</strong><span class="muted">Читает только книги из шкафа и не выдумывает. Если ответа там нет — так и говорит, а ответ нейросети помечает знаком ⚠.</span></div>
    <div class="card"><span class="icon">🔀</span><strong>Симулятор = конструктор последствий</strong><span class="muted">Меняешь одно условие — и видишь, что произойдёт дальше по цепочке.</span></div>
    <div class="card"><span class="icon">🚫</span><strong>Интернет = не нужен</strong><span class="muted">Всё уже внутри. Вопросы учеников никуда не уходят.</span></div>
  </div>

  <h2>Что нужно для запуска</h2>
  <ul class="checklist">${need.map(([id, text]) => `<li><label><input type="checkbox" data-action-change="check" data-id="${id}" ${checks[id] ? 'checked' : ''}><span>${esc(text)}</span></label></li>`).join('')}</ul>
  <p class="muted small">Подробная инструкция — в файле README.md в папке проекта. Нейросеть включается отдельно: <a href="#/ai">как включить нейросеть</a>.</p>`;
}

async function extractGraph(text) {
  const t = S.teacher;
  t.text = text;
  t.busy = true;
  t.error = '';
  viewTeacher();
  try {
    const r = await teacherPost('api/extract', { text });
    t.graph = r.graph;
    t.notes = r.notes || [];
    if (!t.graph.edges.length) t.error = 'Модель не нашла связей, подтверждённых текстом. Попробуйте более подробный параграф.';
  } catch (e) {
    t.error = e.message;
  }
  t.busy = false;
  viewTeacher();
}

// ---------- обработчики ----------
const actions = {
  'chat-mode': (d) => { S.chat.mode = d.mode; S.chat.quiz = null; viewSova(); },
  'ask-example': (d) => sendChat(d.q),
  'lib-grade': (d) => { S.lf.grade = d.g; viewLibrary(location.hash.split('/')[2]); },
  'ask-about': (d) => { location.hash = '#/sova'; setTimeout(() => sendChat(`Расскажи про тему «${d.title}»`), 0); },
  'speak-doc': async (d, el) => {
    const doc = document.getElementById('doc');
    showTTSNote(await speak(doc.innerText, el, { serverTTS: S.server?.tts }));
  },
  'speak-msg': async (d, el) => {
    const m = S.chat.messages[Number(d.i)];
    showTTSNote(await speak(m.text, el, { serverTTS: S.server?.tts }));
  },
  't-logout': () => { logoutTeacher(); S.teacher.summary = null; viewTeacher(); },
  't-reset-stats': async () => {
    if (!confirm('Очистить статистику тем? Это нельзя отменить.')) return;
    try { if (S.server) await teacherPost('api/teacher/reset-stats', {}); else resetLocalStats(); } catch (e) { S.teacher.error = e.message; }
    S.teacher.summary = null; viewTeacher();
  },
  print: () => window.print(),
  't-refresh': () => { S.teacher.summary = null; viewTeacher(); },
  'hint-more': () => askSova(S.chat.lastQuestion, Math.min(2, (S.chat.messages.at(-1).level || 0) + 1), 'socratic'),
  'show-answer': () => askSova(S.chat.lastQuestion, 2, 'socratic'),
  simpler: () => askSova(S.chat.lastQuestion, 0, 'simpler'),
  report: () => {
    if (S.server) postJSON('api/report', { question: S.chat.lastQuestion }).catch(() => {});
    else { const top = S.lib.search(S.chat.lastQuestion); if (RELEVANT(top)) recordLocal(top[0].docId, top[0].title, 'report'); }
    store.set('reports', [...store.get('reports', []), { q: S.chat.lastQuestion, a: S.chat.messages.at(-1)?.text, at: Date.now() }]);
    S.chat.messages.push({ role: 'assistant', text: 'Спасибо! Я записала этот случай — учитель проверит ответ. Ты молодец, что проверяешь ИИ.' });
    viewSova();
  },
  'toggle-text': () => { S.ex.showText = !S.ex.showText; viewExplore(S.ex.graphId); },
  scenario: (d) => {
    const g = graphById(S.ex.graphId);
    const s = g.scenarios[Number(d.i)];
    S.ex.changes = { ...s.changes };
    S.ex.tool = 'predict';
    S.ex.selected = null;
    drawExploreGraph(); drawPanel();
  },
  unchange: (d) => { delete S.ex.changes[d.id]; drawExploreGraph(); drawPanel(); },
  tool: (d) => { S.ex.tool = d.tool; S.ex.selected = null; drawExploreGraph(); drawPanel(); },
  predict: (d) => {
    const x = S.ex;
    if (x.predictions[x.selected] === d.t) delete x.predictions[x.selected]; else x.predictions[x.selected] = d.t;
    drawExploreGraph(); drawPanel();
  },
  run: runSimulation,
  why: (d) => showWhy(d.id),
  'close-info': () => { S.ex.info = null; S.ex.highlight = null; drawExploreGraph(); drawPanel(); },
  debrief: debriefWithSova,
  reset: () => { const id = S.ex.graphId; S.ex = null; viewExplore(id); },
  'lab-filter': (d) => { S.labFilter = d.f; viewLabs(); },
  'lab-full': () => { const f = document.getElementById('lab-frame'); (f.requestFullscreen || f.webkitRequestFullscreen)?.call(f); },
  'labs-save': (d, el) => saveAllLabs(el),
  'bd-pick': (d) => {
    const b = S.bd;
    const v = d.f === 'sign' ? Number(d.id) : d.id;
    b.pick[d.f] = b.pick[d.f] === v ? (d.f === 'sign' ? 0 : null) : v;
    b.feedback = '';
    viewBuild(b.graphId);
  },
  'bd-check': buildCheck,
  'bd-reveal': () => {
    const b = S.bd;
    const g = graphById(b.graphId);
    const e = g.edges[b.step];
    b.pick = { from: e.from, to: e.to, sign: e.sign };
    b.revealed = true;
    buildCheck();
    b.feedback = `<div class="info">Ответ: <strong>чем больше «${esc(nodeLabel(g, e.from))}», тем ${e.sign > 0 ? 'больше' : 'меньше'} «${esc(nodeLabel(g, e.to))}»</strong>. Найди эти слова в подсвеченной фразе — так проще запомнить.</div>`;
    viewBuild(b.graphId);
  },
  'bd-next': () => {
    const b = S.bd;
    Object.assign(b, { step: b.step + 1, pick: { from: null, to: null, sign: 0 }, tries: 0, feedback: '', solved: false, revealed: false });
    saveBuild(b);
    viewBuild(b.graphId);
    window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
  },
  'bd-restart': () => { const g = graphById(S.bd.graphId); store.set(`build-${g.id}`, null); S.bd = buildState(g); viewBuild(g.id); },
  'sample-text': () => { S.teacher.text = 'Вырубка лесов уменьшает количество деревьев, которые поглощают углекислый газ. Поэтому в атмосфере накапливается больше углекислого газа, и парниковый эффект усиливается. Без корней деревьев почва хуже удерживается, и дожди смывают плодородный слой. Из-за эрозии почвы снижаются урожаи. Кроме того, исчезают места обитания животных, и сокращается число видов.'; viewTeacher(); },
  't-sign': (d) => { const e = S.teacher.graph.edges[Number(d.i)]; e.sign = -e.sign; viewTeacher(); },
  't-del': (d) => { S.teacher.graph.edges.splice(Number(d.i), 1); viewTeacher(); },
  't-publish': async () => {
    try {
      const r = await teacherPost('api/graphs', { graph: S.teacher.graph });
      S.graphs = S.graphs.filter((g) => g.id !== r.id).concat({ ...S.teacher.graph, id: r.id, verified_by_teacher: true });
      location.hash = `#/explore/${r.id}`;
    } catch (e) { S.teacher.error = e.message; viewTeacher(); }
  },
  't-download': () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S.teacher.graph, null, 2)], { type: 'application/json' }));
    a.download = `${S.teacher.graph.id}.json`;
    a.click();
  },
};

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) { ev.preventDefault(); actions[el.dataset.action](el.dataset, el); }
});
app.addEventListener('input', (ev) => {
  const a = ev.target.dataset.actionInput;
  if (a === 'slider') {
    const v = Number(ev.target.value);
    if (v === 0) delete S.ex.changes[S.ex.selected]; else S.ex.changes[S.ex.selected] = v / 100;
    document.getElementById('sw').textContent = sliderWord(v);
    drawExploreGraph();
  } else if (a === 't-title') S.teacher.graph.title = ev.target.value;
  else if (a === 'lib-q') { S.lf.q = ev.target.value; renderLibList(location.hash.split('/')[2]); }
});
function showTTSNote(msg) {
  let el = document.getElementById('tts-note');
  if (!el) { el = document.createElement('p'); el.id = 'tts-note'; el.className = 'muted small'; document.querySelector('#doc')?.after(el); }
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

async function setExam(on) {
  try {
    if (S.server) S.exam = (await teacherPost('api/settings', { exam: on })).exam;
    else { setLocalExam(on); S.exam = on; }
  } catch (e) { S.teacher.error = e.message; }
  renderStatus();
  viewTeacher();
}

app.addEventListener('change', (ev) => {
  const ac = ev.target.dataset.actionChange;
  if (ac === 'grade') { S.chat.grade = Number(ev.target.value); store.set('grade', S.chat.grade); }
  if (ac === 'exam') setExam(ev.target.checked);
  if (ac === 'qr-url') { S.qrUrl = ev.target.value; viewConnect(); }
  if (ac === 'check') { const c = store.get('checklist', {}); c[ev.target.dataset.id] = ev.target.checked; store.set('checklist', c); }
  if (ev.target.dataset.actionInput === 'slider') drawPanel();
});
app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  if (form.dataset.form === 'chat') { const v = form.q.value; form.q.value = ''; sendChat(v); }
  if (form.dataset.form === 'extract') extractGraph(form.text.value);
  if (form.dataset.form === 'pin') {
    const pin = form.pin.value;
    form.pin.value = '';
    login(pin, !!S.server).then((token) => {
      S.auth = token; setToken(token); S.teacher.pinError = ''; S.teacher.summary = null; viewTeacher();
    }).catch((e) => { S.teacher.pinError = e.message; viewTeacher(); document.getElementById('pin')?.focus(); });
  }
});

// ---------- тема оформления ----------
document.getElementById('theme-slot').innerHTML = themeSwitcher();
applyTheme(currentTheme());
document.getElementById('theme-slot').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-theme-btn]');
  if (b) setTheme(b.dataset.themeBtn);
});

// ---------- офлайн-режим ----------
function renderOffline() {
  const el = document.getElementById('offline');
  if (!el) return;
  if (!navigator.onLine) { el.textContent = '● Нет интернета — работаем офлайн'; el.className = 'status on'; el.hidden = false; return; }
  if (S.offlineReady) { el.textContent = '✓ Работает без интернета'; el.title = 'Все темы, схемы и программа сохранены на этом устройстве'; el.className = 'status on'; el.hidden = false; return; }
  el.hidden = true;
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { S.offlineReady = true; renderOffline(); }).catch(() => { /* офлайн-режим недоступен */ });
}
window.addEventListener('online', renderOffline);
window.addEventListener('offline', renderOffline);

boot().catch((e) => { app.innerHTML = `<div class="info bad">Не удалось загрузить приложение: ${esc(e.message)}. Откройте его через сервер (<code>python server/server.py</code>), а не как файл.</div>`; });
