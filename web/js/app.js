import { simulate, pathTo, findLoops, checkPredictions, compareGraphs, trend, DEFAULT_DELAY_LABELS } from './engine.js';
import { renderGraph, esc } from './graph-view.js';
import { Library, localAnswer, makeQuiz, checkQuiz, RELEVANT } from './tutor-local.js';
import { detectBrowserLLM, chatBrowser, tutorMessages, DEBRIEF } from './llm-browser.js';

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
  teacher: { text: '', graph: null, notes: [], busy: false, error: '' },
};

const TREND_WORD = { up: 'вырастет', down: 'уменьшится', same: 'не изменится' };
const TREND_PAST = { up: 'вырос', down: 'уменьшился', same: 'не изменился' };
const ARROW = { up: '▲', down: '▼', same: '=' };

const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(url); return r.json(); });
const postJSON = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || `Ошибка ${r.status}`); return data; });
const graphById = (id) => S.graphs.find((g) => g.id === id);
const nodeLabel = (g, id) => g.nodes.find((n) => n.id === id)?.label || id;
const textOf = (g) => g.sourceText || S.texts.find((t) => t.id === g.text)?.text || '';
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

// ---------- запуск ----------
async function boot() {
  const [texts, index] = await Promise.all([getJSON('data/texts.json'), getJSON('data/graphs/index.json')]);
  S.texts = texts;
  S.lib = new Library(texts);
  S.graphs = await Promise.all(index.map((id) => getJSON(`data/graphs/${id}.json`)));
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (r.ok && r.headers.get('content-type')?.includes('json')) S.server = await r.json();
  } catch { /* статический сайт */ }
  if (S.server) {
    try { S.graphs.push(...(await getJSON('api/graphs'))); } catch { /* нет своих схем */ }
  }
  S.chat.grade = store.get('grade', 8);
  renderStatus();
  if (!S.server) {
    // Сайт открыт не с коробки: пробуем Ollama на этом компьютере, не задерживая загрузку.
    detectBrowserLLM().then((m) => { if (m) { S.browserLLM = m; renderStatus(); route(); } });
  }
  window.addEventListener('hashchange', route);
  route();
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
  const views = { '': viewHome, sova: viewSova, explore: viewExplore, build: viewBuild, teacher: viewTeacher, library: viewLibrary, ai: viewAI };
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
    <h1>Библиотека, наставник и тренажёр мышления — без интернета</h1>
    <p>Подключись к Wi-Fi «Школа-Знание» и учись с любого телефона. Наставник Сова не даёт готовых ответов: он помогает дойти до них самому и всегда показывает, откуда взята информация.</p>
  </section>
  <div class="cards big">
    <a class="card" href="#/sova"><span class="icon">🦉</span><strong>Спросить Сову</strong><span class="muted">Наставник ответит по книгам из библиотеки: сначала подсказкой, потом полным ответом</span></a>
    <a class="card" href="#/explore"><span class="icon">🔀</span><strong>Что будет, если…</strong><span class="muted">Измени одно условие в параграфе и проследи цепочку последствий</span></a>
    <a class="card" href="#/build"><span class="icon">🧩</span><strong>Собери сам</strong><span class="muted">Построй схему причин и следствий сам и сравни с эталоном</span></a>
    <a class="card" href="#/library"><span class="icon">📚</span><strong>Библиотека</strong><span class="muted">Параграфы и статьи, на которые опирается Сова</span></a>
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
    <p class="muted small">Чтобы раздать прототип всему классу по Wi-Fi, запустите <code>python server/server.py --box</code> и откройте на телефонах адрес компьютера с портом 8000.</p></div>
  <div class="step"><h3><span class="n">2</span> Способ «этот сайт»</h3>
    <p>Разрешите Ollama отвечать этому сайту: выполните в PowerShell команду ниже, затем закройте Ollama (значок у часов → Quit) и откройте снова. Обновите эту страницу; если браузер спросит про доступ к устройствам в локальной сети — разрешите.</p>
    <pre class="code">setx OLLAMA_ORIGINS "${esc(location.origin)}"</pre></div>`;
}

// ---------- библиотека ----------
function viewLibrary(id) {
  const doc = id && S.texts.find((t) => t.id === id);
  if (doc) {
    app.innerHTML = `<a class="back" href="#/library">← Библиотека</a>
      <article class="doc"><span class="tag">${esc(doc.subject)} · ${doc.grade} класс</span><h1>${esc(doc.title)}</h1><p>${esc(doc.text)}</p></article>
      <div class="row">${doc.graph ? `<a class="btn primary" href="#/explore/${doc.graph}">Открыть схему «Что будет, если…»</a>` : ''}
      <button class="btn" data-action="ask-about" data-title="${esc(doc.title)}">Спросить Сову об этом</button></div>`;
    return;
  }
  const group = (kind, title) => `<h2>${title}</h2><ul class="list">${S.texts.filter((t) => t.kind === kind).map((t) => `<li><a href="#/library/${t.id}">${esc(t.title)}</a> <span class="muted">${esc(t.subject)}</span></li>`).join('')}</ul>`;
  app.innerHTML = `<h1>Библиотека</h1><p class="muted">В настоящей коробке здесь же открываются Википедия, видеоуроки и симуляторы через Kiwix. В прототипе — учебные тексты, по которым отвечает Сова.</p>${group('paragraph', 'Параграфы учебника')}${group('article', 'Статьи')}`;
}

// ---------- Сова ----------
function viewSova() {
  const c = S.chat;
  const modes = [['socratic', 'Наведи на мысль'], ['explain', 'Объясни'], ['quiz', 'Проверь меня']];
  const last = [...c.messages].reverse().find((m) => m.role === 'assistant');
  app.innerHTML = `
  <div class="chat">
    <div class="chat-head">
      <h1>🦉 Сова</h1>
      <div class="seg" role="tablist">${modes.map(([m, l]) => `<button class="${c.mode === m ? 'on' : ''}" data-action="chat-mode" data-mode="${m}">${l}</button>`).join('')}</div>
      <label class="muted">Класс <select data-action-change="grade">${[5, 6, 7, 8, 9, 10, 11].map((g) => `<option ${g === c.grade ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
    </div>
    <div class="messages" id="messages">
      ${c.messages.length ? '' : `<div class="msg assistant"><p>Привет! Я Сова. Спроси меня о том, что непонятно в параграфе. Например:</p>
        <div class="row">${['Почему кораллы обесцвечиваются?', 'Почему крестьяне были недовольны реформой?', 'Что будет, если повысить ключевую ставку?'].map((q) => `<button class="chip" data-action="ask-example" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`}
      ${c.messages.map(renderMsg).join('')}
      ${c.busy ? '<div class="msg assistant typing">Сова думает…</div>' : ''}
    </div>
    ${last && !c.busy && last.kind === 'answer' ? `<div class="row actions">
      ${last.level < 2 ? '<button class="btn" data-action="hint-more">Ещё подсказка</button><button class="btn" data-action="show-answer">Покажи ответ</button>' : ''}
      <button class="btn" data-action="simpler">Объясни проще</button>
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

function renderMsg(m) {
  const sources = (m.sources || []).map((s) => `<a class="chip src" href="#/library/${esc(s.docId)}">📖 ${esc(s.title)}</a>`).join('');
  const graph = m.graph ? `<a class="chip graph" href="#/explore/${esc(m.graph)}">🔀 Открыть схему «${esc(graphById(m.graph)?.title || m.graph)}»</a>` : '';
  const by = m.role === 'assistant' && m.by ? `<span class="by">${esc(m.by)}</span>` : '';
  return `<div class="msg ${m.role}">${esc(m.text).replace(/\n/g, '<br>')}${sources || graph ? `<div class="row">${sources}${graph}</div>` : ''}${by}</div>`;
}

async function askSova(question, level, mode = S.chat.mode) {
  const c = S.chat;
  c.busy = true;
  viewSova();
  let reply;
  try {
    if (S.server) {
      const history = c.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.text }));
      const r = await postJSON('api/chat', { message: question, mode, level, grade: c.grade, history });
      if (r.answer) {
        const f = r.fragments || [];
        reply = { text: r.answer, sources: [...new Map(f.slice(0, 2).map((x) => [x.title, x])).values()], graph: f.find((x) => x.graph)?.graph || null, by: `нейросеть ${r.model}` };
      } else {
        reply = { ...localAnswer({ message: question, mode, level, fragments: r.fragments || [] }), by: 'без нейросети' };
      }
    } else if (S.browserLLM && RELEVANT(S.lib.search(question))) {
      const fragments = S.lib.search(question);
      const history = c.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.text }));
      const text = await chatBrowser(S.browserLLM, tutorMessages({ message: question, mode, level, grade: c.grade, history, fragments: fragments.slice(0, 3) }));
      reply = { text, sources: [...new Map(fragments.slice(0, 2).map((x) => [x.title, x])).values()], graph: fragments.find((x) => x.graph)?.graph || null, by: `нейросеть ${S.browserLLM}` };
    } else {
      reply = { ...localAnswer({ message: question, mode, level, fragments: S.lib.search(question) }), by: 'без нейросети' };
    }
  } catch (e) {
    reply = { text: `Не получилось ответить: ${e.message}`, sources: [] };
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
      x.debrief = await chatBrowser(S.browserLLM, [{ role: 'system', content: DEBRIEF }, { role: 'user', content: JSON.stringify(context) }]);
    }
  } catch (e) {
    x.debrief = `Не получилось: ${e.message}`;
  }
  x.busy = false;
  drawPanel();
}

// ---------- «Собери сам» ----------
function viewBuild(id) {
  const g = id && graphById(id);
  if (!g) {
    app.innerHTML = `<h1>Собери сам</h1><p class="muted">Прочитай параграф и соедини факторы стрелками: что на что влияет и как. Потом сравни свою схему с эталоном.</p>${graphCards('build')}`;
    return;
  }
  if (!S.bd || S.bd.graphId !== id) S.bd = { graphId: id, edges: store.get(`draft-${id}`, []), sign: 1, from: null, result: null, hint: '', showRef: false };
  const b = S.bd;
  app.innerHTML = `
  <a class="back" href="#/build">← Все схемы</a>
  <h1>Собери сам: ${esc(g.title)}</h1>
  <div class="paragraph">${esc(textOf(g))}</div>
  <div class="toolbar">
    <span>Связь:</span>
    <div class="seg"><button class="${b.sign > 0 ? 'on' : ''}" data-action="bd-sign" data-s="1">+ усиливает</button><button class="${b.sign < 0 ? 'on' : ''}" data-action="bd-sign" data-s="-1">− ослабляет</button></div>
    <span class="muted small">${b.from ? `Теперь нажми, на что влияет «${esc(nodeLabel(g, b.from))}»` : 'Нажми на причину, затем на следствие. Нажми на стрелку, чтобы удалить её.'}</span>
  </div>
  <div class="graph-wrap" id="graph"></div>
  <div class="row">
    <button class="btn primary" data-action="bd-check" ${b.edges.length ? '' : 'disabled'}>Проверить</button>
    <button class="btn" data-action="bd-hint">Подсказка</button>
    <button class="btn" data-action="bd-ref">${b.showRef ? 'Скрыть эталон' : 'Показать эталон'}</button>
    <button class="btn ghost" data-action="bd-clear">Очистить</button>
  </div>
  ${b.hint ? `<div class="info">${b.hint}</div>` : ''}
  ${b.result ? (() => {
    const r = b.result;
    return `<div class="step"><h3>Совпало ${r.correct.length} из ${g.edges.length} связей (${Math.round(r.score * 100)}%)</h3>
      ${r.wrongSign.length ? `<p>Связь есть, но знак другой: ${r.wrongSign.map((e) => `${esc(nodeLabel(g, e.from))} → ${esc(nodeLabel(g, e.to))}`).join('; ')}. Перечитай: усиливает или ослабляет?</p>` : ''}
      ${r.extra.length ? `<p>Этих связей нет в эталоне: ${r.extra.map((e) => `${esc(nodeLabel(g, e.from))} → ${esc(nodeLabel(g, e.to))}`).join('; ')}. Найди в тексте подтверждение — или убери. Иногда ученик прав, а схема неполная: скажи учителю!</p>` : ''}
      ${r.missing.length ? `<p>Не хватает ещё ${r.missing.length} связей. Нажми «Подсказка».</p>` : '<p>Все связи из параграфа найдены! 🎉</p>'}</div>`;
  })() : ''}`;
  renderGraph(document.getElementById('graph'), g, {
    edges: b.showRef ? g.edges : b.edges,
    pending: b.from,
    onNodeClick: (nid) => {
      if (b.showRef) return;
      if (!b.from) b.from = nid;
      else if (b.from === nid) b.from = null;
      else {
        b.edges = b.edges.filter((e) => !(e.from === b.from && e.to === nid));
        b.edges.push({ from: b.from, to: nid, sign: b.sign, strength: 2, delay: 0 });
        b.from = null;
        b.result = null;
        store.set(`draft-${id}`, b.edges);
      }
      viewBuild(id);
    },
    onEdgeClick: (e) => {
      if (b.showRef) return;
      b.edges = b.edges.filter((x) => x !== e);
      b.result = null;
      store.set(`draft-${id}`, b.edges);
      viewBuild(id);
    },
  });
}

// ---------- кабинет учителя ----------
function viewTeacher() {
  const t = S.teacher;
  const canExtract = S.server?.llm;
  app.innerHTML = `
  <h1>Кабинет учителя</h1>
  <p class="muted">Вставьте параграф — нейросеть предложит схему причин и следствий. Каждая связь подтверждается цитатой; связи без цитаты убираются автоматически. Проверьте схему и опубликуйте для класса.</p>
  ${canExtract ? '' : `<div class="info">${S.server ? 'Нейросеть на коробке не запущена: запустите Ollama и скачайте модель (<code>ollama pull qwen2.5:3b</code>), затем перезапустите сервер.' : 'Это демо-сайт без нейросети. Построение схем работает на школьной коробке: запустите <code>python server/server.py</code> с Ollama.'} Пока можно открыть готовые схемы во вкладке «Что будет, если…».</div>`}
  <form data-form="extract" class="stack">
    <textarea name="text" rows="7" placeholder="Текст параграфа…" ${canExtract ? '' : 'disabled'}>${esc(t.text)}</textarea>
    <div class="row"><button class="btn primary" ${canExtract && !t.busy ? '' : 'disabled'}>${t.busy ? 'Строю схему… это может занять минуту' : 'Построить схему'}</button>
    <button type="button" class="btn ghost" data-action="sample-text" ${canExtract ? '' : 'disabled'}>Вставить пример</button></div>
  </form>
  ${t.error ? `<div class="info bad">${esc(t.error)}</div>` : ''}
  ${t.graph ? `
    <h2>Черновик: <input class="title-input" value="${esc(t.graph.title)}" data-action-input="t-title" aria-label="Название схемы"></h2>
    ${t.notes.length ? `<details class="notes"><summary>Проверка цитат: ${t.notes.length} замечаний</summary><ul>${t.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : '<p class="muted">Все связи подтверждены цитатами.</p>'}
    <div class="graph-wrap" id="graph"></div>
    <h3>Связи</h3>
    <ul class="edges-edit">${t.graph.edges.map((e, i) => `<li><button class="chip" data-action="t-sign" data-i="${i}">${e.sign > 0 ? '+' : '−'}</button> ${esc(nodeLabel(t.graph, e.from))} → ${esc(nodeLabel(t.graph, e.to))} <span class="muted small">«${esc(e.evidence)}»</span> <button class="link" data-action="t-del" data-i="${i}">удалить</button></li>`).join('')}</ul>
    <div class="row"><button class="btn primary" data-action="t-publish">Опубликовать для класса</button><button class="btn" data-action="t-download">Скачать JSON</button></div>` : ''}`;
  if (t.graph) renderGraph(document.getElementById('graph'), t.graph, {});
}

async function extractGraph(text) {
  const t = S.teacher;
  t.text = text;
  t.busy = true;
  t.error = '';
  viewTeacher();
  try {
    const r = await postJSON('api/extract', { text });
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
  'ask-about': (d) => { location.hash = '#/sova'; setTimeout(() => sendChat(`Расскажи про тему «${d.title}»`), 0); },
  'hint-more': () => askSova(S.chat.lastQuestion, Math.min(2, (S.chat.messages.at(-1).level || 0) + 1), 'socratic'),
  'show-answer': () => askSova(S.chat.lastQuestion, 2, 'socratic'),
  simpler: () => askSova(S.chat.lastQuestion, 0, 'simpler'),
  report: () => {
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
  'bd-sign': (d) => { S.bd.sign = Number(d.s); viewBuild(S.bd.graphId); },
  'bd-check': () => { const g = graphById(S.bd.graphId); S.bd.result = compareGraphs(g, S.bd.edges); S.bd.hint = ''; viewBuild(S.bd.graphId); },
  'bd-hint': () => {
    const g = graphById(S.bd.graphId);
    const miss = compareGraphs(g, S.bd.edges).missing;
    S.bd.hint = miss.length ? `В тексте сказано: <blockquote>«${esc(miss[0].evidence)}»</blockquote> Какие два фактора связывает эта фраза? Усиливает связь или ослабляет?` : 'Все связи уже найдены!';
    viewBuild(S.bd.graphId);
  },
  'bd-ref': () => { S.bd.showRef = !S.bd.showRef; viewBuild(S.bd.graphId); },
  'bd-clear': () => { S.bd.edges = []; S.bd.result = null; S.bd.hint = ''; store.set(`draft-${S.bd.graphId}`, []); viewBuild(S.bd.graphId); },
  'sample-text': () => { S.teacher.text = 'Вырубка лесов уменьшает количество деревьев, которые поглощают углекислый газ. Поэтому в атмосфере накапливается больше углекислого газа, и парниковый эффект усиливается. Без корней деревьев почва хуже удерживается, и дожди смывают плодородный слой. Из-за эрозии почвы снижаются урожаи. Кроме того, исчезают места обитания животных, и сокращается число видов.'; viewTeacher(); },
  't-sign': (d) => { const e = S.teacher.graph.edges[Number(d.i)]; e.sign = -e.sign; viewTeacher(); },
  't-del': (d) => { S.teacher.graph.edges.splice(Number(d.i), 1); viewTeacher(); },
  't-publish': async () => {
    try {
      const r = await postJSON('api/graphs', { graph: S.teacher.graph });
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
});
app.addEventListener('change', (ev) => {
  if (ev.target.dataset.actionChange === 'grade') { S.chat.grade = Number(ev.target.value); store.set('grade', S.chat.grade); }
  if (ev.target.dataset.actionInput === 'slider') drawPanel();
});
app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target;
  if (form.dataset.form === 'chat') { const v = form.q.value; form.q.value = ''; sendChat(v); }
  if (form.dataset.form === 'extract') extractGraph(form.text.value);
});

boot().catch((e) => { app.innerHTML = `<div class="info bad">Не удалось загрузить приложение: ${esc(e.message)}. Откройте его через сервер (<code>python server/server.py</code>), а не как файл.</div>`; });
