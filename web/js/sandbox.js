// «Песочница»: свободная карта мыслей ученика + «Мои заметки и аргументы», совет Совы по карте,
// перенос мыслей из чата с Совой («+ В карту мыслей»), отправка работы учителю
// и вкладка учителя «Работы учеников».
import { askContext } from './simulation-ui.js';
import { SANDBOX_HELP_PROMPT, WORK_REVIEW_PROMPT } from './llm-browser.js';

let ctx = null;
/** Связь с приложением (состояние, отрисовка схем, запросы) — её даёт app.js. */
export function initSandbox(context) {
  ctx = context;
  ctx.app.addEventListener('click', onClick);
  ctx.app.addEventListener('submit', onSubmit);
  ctx.app.addEventListener('input', onInput);
}

const esc = (s) => ctx.esc(s);
const KEY = 'sandbox-map';
const RELATIONS = ['провоцирует', 'тормозит', 'является скрытой причиной', 'усиливает', 'ослабляет', 'приводит к', 'мешает', 'помогает'];
const emptyMap = () => ({ title: '', nodes: [], edges: [], notes: '' });
const sb = () => (ctx.S.sb ||= { selected: null, talk: [], busy: false, sent: null, sendOpen: false });

export const loadMap = () => ({ ...emptyMap(), ...ctx.store.get(KEY, {}) });
export const saveMap = (m) => ctx.store.set(KEY, m);
const label = (m, id) => m.nodes.find((n) => n.id === id)?.label || id;

/** Карта ученика в виде схемы для отрисовки: подпись стрелки — слово ученика. */
export function mapAsGraph(m, id = 'sandbox') {
  return {
    id, title: m.title || 'Моя карта мыслей',
    nodes: m.nodes.map((n) => ({ id: n.id, label: n.label })),
    edges: m.edges.map((e) => ({ from: e.from, to: e.to, sign: e.sign >= 0 ? 1 : -1, strength: 2, delay: 0, verb: e.label || (e.sign >= 0 ? 'вызывает рост' : 'приводит к уменьшению'), evidence: e.label || '' })),
  };
}

// ---------- встроенный разбор карты (когда нейросети нет) ----------
function longestChain(m) {
  const out = new Map(m.nodes.map((n) => [n.id, m.edges.filter((e) => e.from === n.id).map((e) => e.to)]));
  let best = [];
  const walk = (id, path) => {
    if (path.length > best.length) best = path;
    for (const to of out.get(id) || []) if (!path.includes(to)) walk(to, [...path, to]);
  };
  m.nodes.forEach((n) => walk(n.id, [n.id]));
  return best;
}
function hasCycle(m) {
  const out = new Map(m.nodes.map((n) => [n.id, m.edges.filter((e) => e.from === n.id).map((e) => e.to)]));
  const state = new Map();
  const dfs = (id) => {
    state.set(id, 1);
    for (const to of out.get(id) || []) { if (state.get(to) === 1 || (!state.get(to) && dfs(to))) return true; }
    state.set(id, 2);
    return false;
  };
  return m.nodes.some((n) => !state.get(n.id) && dfs(n.id));
}

/** Разбор карты мыслей без нейросети: для ученика — подсказки и вопрос, для учителя — сильные и слабые стороны. */
export function localMapFeedback(m, forTeacher = false) {
  const linked = new Set(m.edges.flatMap((e) => [e.from, e.to]));
  const lonely = m.nodes.filter((n) => !linked.has(n.id));
  const unlabeled = m.edges.filter((e) => !e.label?.trim());
  const chain = longestChain(m);
  const cycle = hasCycle(m);
  const notes = (m.notes || '').trim();
  const strong = [];
  const weak = [];
  if (chain.length >= 3) strong.push(`Есть цепочка из ${chain.length} звеньев: ${chain.map((id) => `«${label(m, id)}»`).join(' → ')}.`);
  if (cycle) strong.push('Есть петля обратной связи — это неочевидный и сильный ход.');
  if (m.edges.length && unlabeled.length < m.edges.length / 2) strong.push('Связи подписаны словами — видно, как именно одно влияет на другое.');
  if (notes.length > 200) strong.push('В заметках есть рассуждения и аргументы.');
  if (lonely.length) weak.push(`${lonely.length > 1 ? 'Факторы' : 'Фактор'} ${lonely.slice(0, 3).map((n) => `«${n.label}»`).join(', ')} пока ни с чем не ${lonely.length > 1 ? 'связаны' : 'связан'}.`);
  if (unlabeled.length) weak.push(`Не подписана связь «${label(m, unlabeled[0].from)} → ${label(m, unlabeled[0].to)}»: как именно одно влияет на другое?`);
  if (m.nodes.length < 4) weak.push('Карта пока маленькая — попробуй найти ещё причины или последствия.');
  if (notes.length < 60) weak.push('В заметках мало объяснений: почему ты считаешь, что связи именно такие?');
  const edge = m.edges.find((e) => e.label?.trim()) || m.edges[0];
  const question = edge ? `Какой промежуточный фактор может связывать «${label(m, edge.from)}» и «${label(m, edge.to)}»?` : 'С какой причины всё начинается и к какому последствию приводит?';
  if (forTeacher) {
    const score = Math.max(2, Math.min(5, 2 + (m.nodes.length >= 5) + (m.edges.length >= 4 && unlabeled.length < m.edges.length / 2) + (notes.length > 200) + (cycle || chain.length >= 4) - (lonely.length > 2)));
    return `**Сильные стороны**\n${(strong.length ? strong : ['Ученик начал строить свою карту — это уже самостоятельное исследование.']).map((x) => `- ${x}`).join('\n')}\n\n**Слабые места логики**\n${(weak.length ? weak : ['Явных пробелов не видно — можно спросить, как ученик проверил свои связи.']).map((x) => `- ${x}`).join('\n')}\n\n**Что спросить у ученика**\n- ${question}\n\n**Ориентировочная оценка:** ${score} из 5 (по полноте карты, подписям связей и заметкам). Решение — за учителем.`;
  }
  if (!m.nodes.length) return 'Карта пока пустая. Добавь первый фактор — например, событие из параграфа или вопрос, который тебя заинтересовал.';
  return [
    strong.length ? `**Хорошо:** ${strong.join(' ')}` : `**Начало положено:** ${m.nodes.length} ${m.nodes.length === 1 ? 'фактор' : 'факторов'} и ${m.edges.length} связей.`,
    weak.length ? `**Подумай:** ${weak.slice(0, 2).join(' ')}` : '',
    `**Вопрос:** ${question}`,
  ].filter(Boolean).join('\n\n');
}

// ---------- страница «Песочница» ----------
export function viewSandbox() {
  const m = loadMap();
  const st = sb();
  const opts = (sel) => m.nodes.map((n) => `<option value="${esc(n.id)}" ${sel === n.id ? 'selected' : ''}>${esc(n.label)}</option>`).join('');
  const node = m.nodes.find((n) => n.id === st.selected);
  ctx.app.innerHTML = `
  <div class="ex-head"><div><h1>🧠 Песочница — моя карта мыслей</h1>
    <p class="muted">Строй свою карту: любые факторы, свои стрелки и подписи («провоцирует», «тормозит», «является скрытой причиной»). Записывай рассуждения, советуйся с Совой и отправь работу учителю.</p></div></div>
  <label class="sb-title">Тема исследования <input data-sb-input="title" maxlength="120" value="${esc(m.title)}" placeholder="Например: Почему высохло Аральское море?"></label>
  <div class="sandbox">
    <div class="sb-main">
      ${m.nodes.length ? '<div class="graph-wrap" id="sb-graph"></div>' : '<div class="graph-wrap sb-empty"><p>Карта пока пустая. Добавь первый фактор справа — или перенеси мысль из чата с Совой кнопкой «+ В карту мыслей».</p></div>'}
      <section class="step">
        <h3>📝 Мои заметки и аргументы</h3>
        <textarea class="sb-notes" data-sb-input="notes" rows="6" maxlength="6000" placeholder="Почему я так думаю? Какие есть доказательства? Что ещё проверить?">${esc(m.notes)}</textarea>
        <p class="muted small" id="sb-saved">Сохраняется автоматически на этом устройстве.</p>
      </section>
    </div>
    <aside class="sb-side">
      ${node ? `<div class="inspector"><div class="ins-head"><span class="tag">Фактор</span><button class="link" data-sb="unselect" aria-label="Закрыть">✕</button></div>
        <h3 class="ins-title">${esc(node.label)}</h3>${node.desc ? `<p>${esc(node.desc)}</p>` : ''}
        <ul class="rel-list">${m.edges.filter((e) => e.from === node.id || e.to === node.id).map((e) => `<li>«${esc(label(m, e.from))}» <strong>${esc(e.label || (e.sign >= 0 ? 'вызывает рост' : 'приводит к уменьшению'))}</strong> «${esc(label(m, e.to))}»</li>`).join('') || '<li class="muted small">Связей пока нет.</li>'}</ul>
        <button class="btn ghost small" data-sb="del-node" data-id="${esc(node.id)}">Удалить фактор</button></div>` : ''}
      <form class="step sb-form" data-sb-form="node">
        <h3>➕ Новый фактор</h3>
        <input name="label" required maxlength="80" placeholder="Название, например «Засуха»">
        <textarea name="desc" rows="2" maxlength="400" placeholder="Описание (необязательно)"></textarea>
        <button class="btn">Добавить фактор</button>
      </form>
      <form class="step sb-form" data-sb-form="edge" ${m.nodes.length < 2 ? 'hidden' : ''}>
        <h3>➜ Новая связь</h3>
        <select name="from" aria-label="Откуда">${opts(st.selected)}</select>
        <input name="label" list="sb-relations" maxlength="60" placeholder="как влияет: провоцирует, тормозит…">
        <datalist id="sb-relations">${RELATIONS.map((r) => `<option value="${r}">`).join('')}</datalist>
        <select name="to" aria-label="Куда">${opts(m.nodes.find((n) => n.id !== st.selected)?.id)}</select>
        <select name="sign" aria-label="Направление"><option value="1">▲ вызывает рост</option><option value="-1">▼ вызывает уменьшение</option></select>
        <button class="btn">Соединить стрелкой</button>
      </form>
      ${m.edges.length ? `<details class="step"><summary><strong>Все связи (${m.edges.length})</strong></summary><ul class="rel-list">${m.edges.map((e, i) => `<li>«${esc(label(m, e.from))}» <strong>${esc(e.label || (e.sign >= 0 ? '▲' : '▼'))}</strong> «${esc(label(m, e.to))}» <button class="link" data-sb="del-edge" data-i="${i}">удалить</button></li>`).join('')}</ul></details>` : ''}
    </aside>
  </div>

  <section class="debrief-card">
    <h2>🦉 Посоветоваться с Совой по моей схеме</h2>
    <p class="muted small">Сова посмотрит карту и заметки, подскажет слабые места и задаст вопросы — но схему не перестроит: решения твои.</p>
    <div class="messages" id="sb-messages" aria-live="polite">
      ${st.talk.map((t) => `<div class="msg ${t.role}">${t.role === 'assistant' ? `<div class="md">${ctx.renderMarkdown(t.text)}</div>` : esc(t.text)}${t.by ? `<span class="by">${esc(t.by)}</span>` : ''}</div>`).join('')}
      ${st.busy ? '<div class="msg assistant typing">Сова думает…</div>' : ''}
    </div>
    <div class="row"><button class="btn primary" data-sb="ask" ${st.busy || !m.nodes.length ? 'disabled' : ''}>🦉 Посоветоваться с Совой по моей схеме</button></div>
    ${st.talk.length ? `<form class="composer" data-sb-form="ask"><input name="q" maxlength="400" autocomplete="off" placeholder="Уточни у Совы…" aria-label="Вопрос Сове"><button class="btn" ${st.busy ? 'disabled' : ''}>Спросить</button></form>` : ''}
  </section>

  <section class="step sb-send">
    <h3>📤 Отправить работу учителю</h3>
    ${st.sent ? `<div class="info" role="status">${esc(st.sent)}</div>` : ''}
    <form data-sb-form="send" class="sb-send-form">
      <label>Имя или ник <input name="name" required maxlength="40" value="${esc(ctx.store.get('sandbox-name', ''))}" autocomplete="off"></label>
      <label>Тема исследования <input name="topic" required maxlength="120" value="${esc(m.title)}"></label>
      <button class="btn primary" ${m.nodes.length || m.notes.trim() ? '' : 'disabled'}>Отправить учителю</button>
    </form>
    <p class="muted small">${ctx.S.server ? 'Работа уйдёт на Коробку — учитель увидит её в кабинете, во вкладке «Работы учеников».' : 'Без Коробки работа сохранится на этом устройстве — учитель откроет её в кабинете на этом же устройстве.'}</p>
    <p><button class="btn ghost small" data-sb="clear">Начать новую карту</button></p>
  </section>`;
  if (m.nodes.length) {
    ctx.renderGraph(document.getElementById('sb-graph'), mapAsGraph(m), {
      zoom: true, selected: st.selected,
      onNodeClick: (id) => { st.selected = id; viewSandbox(); },
    });
  }
  const box = document.getElementById('sb-messages');
  if (box) box.scrollTop = box.scrollHeight;
}

async function askSandbox(question = '') {
  const st = sb();
  const m = loadMap();
  if (st.busy) return;
  const history = st.talk.slice(-6).map((t) => ({ role: t.role, content: t.text }));
  st.talk.push({ role: 'user', text: question || 'Посмотри мою карту мыслей и заметки. Что можно додумать?' });
  st.busy = true;
  viewSandbox();
  const reply = await askContext({
    mode: 'sandbox_help', system: SANDBOX_HELP_PROMPT, boxId: 'sb-messages', message: question, history,
    context: { тема: m.title, карта: { факторы: m.nodes.map((n) => (n.desc ? `${n.label} — ${n.desc}` : n.label)), связи: m.edges.map((e) => `${label(m, e.from)} —[${e.label || (e.sign >= 0 ? 'рост' : 'уменьшение')}]→ ${label(m, e.to)}`) }, заметки: m.notes },
    local: () => localMapFeedback(m),
  });
  st.talk.push({ role: 'assistant', text: reply.text, by: reply.by });
  st.busy = false;
  if (location.hash.startsWith('#/sandbox')) viewSandbox();
}

// ---------- отправка работы учителю ----------
const LOCAL_WORKS = 'student-works';
async function sendWork(name, topic) {
  const st = sb();
  const m = loadMap();
  ctx.store.set('sandbox-name', name);
  const work = { name, topic, map: { nodes: m.nodes, edges: m.edges }, notes: m.notes };
  try {
    if (ctx.S.server) {
      await ctx.postJSON('api/student-works', work);
      st.sent = `✓ Работа «${topic}» отправлена учителю.`;
    } else {
      const all = ctx.store.get(LOCAL_WORKS, []);
      all.unshift({ ...work, id: Date.now(), created: Date.now() / 1000, comment: '', grade: '', reviewed: false });
      ctx.store.set(LOCAL_WORKS, all.slice(0, 100));
      st.sent = `✓ Работа «${topic}» сохранена на этом устройстве для учителя.`;
    }
  } catch (e) {
    st.sent = `Не получилось отправить: ${e.message}. Карта сохранена — попробуй ещё раз.`;
  }
  viewSandbox();
}

// ---------- «+ В карту мыслей» из чата с Совой ----------
/** Выдвижная панель: мысль из ответа Совы → новый фактор карты или заметка. */
export function openToMap(text) {
  document.getElementById('to-map')?.remove();
  const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
  const first = (clean.match(/^[^.!?]{3,80}/) || [clean.slice(0, 60)])[0].replace(/^[«"*#\s]+|[»"*\s]+$/g, '');
  const el = document.createElement('div');
  el.id = 'to-map';
  el.className = 'drawer';
  el.innerHTML = `<form class="drawer-panel to-map" role="dialog" aria-modal="true" aria-label="Добавить в карту мыслей">
    <div class="drawer-head"><strong>🧠 В карту мыслей</strong><button type="button" class="burger" data-close aria-label="Закрыть">✕</button></div>
    <fieldset class="seg-radio"><legend class="muted small">Что сделать</legend>
      <label><input type="radio" name="kind" value="node" checked> Новый фактор</label>
      <label><input type="radio" name="kind" value="note"> Заметка</label></fieldset>
    <label>Название фактора <input name="label" maxlength="80" value="${esc(first)}"></label>
    <label>Текст <textarea name="text" rows="6" maxlength="600">${esc(clean)}</textarea></label>
    <button class="btn primary">Добавить</button>
    <p class="muted small" id="to-map-status" role="status"></p>
  </form>`;
  document.body.appendChild(el);
  const form = el.querySelector('form');
  el.addEventListener('click', (ev) => { if (ev.target === el || ev.target.closest('[data-close]')) el.remove(); });
  form.addEventListener('change', () => { form.label.closest('label').hidden = form.kind.value !== 'node'; });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const m = loadMap();
    if (form.kind.value === 'node') {
      const lbl = form.label.value.trim() || first;
      m.nodes.push({ id: `n${Date.now().toString(36)}`, label: lbl.slice(0, 80), desc: form.text.value.trim().slice(0, 400) });
    } else {
      m.notes = `${m.notes ? `${m.notes.trim()}\n\n` : ''}• ${form.text.value.trim()}`.slice(0, 6000);
    }
    saveMap(m);
    form.innerHTML = `<div class="drawer-head"><strong>✓ Добавлено в карту мыслей</strong><button type="button" class="burger" data-close aria-label="Закрыть">✕</button></div>
      <p>${form.kind?.value === 'note' ? 'Заметка' : 'Новый фактор'} уже в твоей карте.</p>
      <div class="row"><a class="btn primary" href="#/sandbox" data-close>Открыть песочницу</a><button type="button" class="btn" data-close>Продолжить разговор</button></div>`;
  });
  form.label.focus();
}

// ---------- обработчики песочницы ----------
function onClick(ev) {
  const b = ev.target.closest('[data-sb]');
  if (!b) return;
  ev.preventDefault();
  const m = loadMap();
  const st = sb();
  const a = b.dataset.sb;
  if (a === 'ask') return askSandbox();
  if (a === 'unselect') st.selected = null;
  if (a === 'del-node') { m.nodes = m.nodes.filter((n) => n.id !== b.dataset.id); m.edges = m.edges.filter((e) => e.from !== b.dataset.id && e.to !== b.dataset.id); st.selected = null; saveMap(m); }
  if (a === 'del-edge') { m.edges.splice(Number(b.dataset.i), 1); saveMap(m); }
  if (a === 'clear') {
    if (!confirm('Начать новую карту? Текущая карта и заметки будут удалены с этого устройства.')) return;
    saveMap(emptyMap()); st.selected = null; st.talk = []; st.sent = null;
  }
  if (a.startsWith('w-')) return onWorksClick(a, b);
  viewSandbox();
}

function onSubmit(ev) {
  const form = ev.target;
  const kind = form.dataset.sbForm;
  if (!kind) return;
  ev.preventDefault();
  const m = loadMap();
  const st = sb();
  if (kind === 'node') {
    const id = `n${Date.now().toString(36)}`;
    m.nodes.push({ id, label: form.label.value.trim().slice(0, 80), desc: form.desc.value.trim().slice(0, 400) });
    saveMap(m);
    st.selected = st.selected || id;
    return viewSandbox();
  }
  if (kind === 'edge') {
    if (form.from.value === form.to.value) { alert('Выбери два разных фактора'); return; }
    m.edges.push({ from: form.from.value, to: form.to.value, label: form.label.value.trim().slice(0, 60), sign: Number(form.sign.value) });
    saveMap(m);
    return viewSandbox();
  }
  if (kind === 'ask') { const q = form.q.value.trim(); if (q) askSandbox(q); return; }
  if (kind === 'send') return sendWork(form.name.value.trim(), form.topic.value.trim());
  if (kind === 'review') return saveReview(form);
}

function onInput(ev) {
  const k = ev.target.dataset.sbInput;
  if (!k) return;
  const m = loadMap();
  m[k] = ev.target.value;
  saveMap(m);
  const s = document.getElementById('sb-saved');
  if (s) s.textContent = '✓ Сохранено';
}

// ---------- кабинет учителя: «Работы учеников» ----------
const W = () => (ctx.S.works ||= { list: null, open: null, ai: null, busy: false, msg: '' });

async function loadWorks() {
  const w = W();
  try {
    if (ctx.S.server) {
      const r = await fetch('api/teacher/works', { headers: { 'X-Teacher-Token': ctx.S.auth || '' } });
      if (r.status === 403) { ctx.logoutTeacher(); throw new Error('Вход учителя истёк'); }
      w.list = (await r.json()).works || [];
    } else {
      w.list = ctx.store.get(LOCAL_WORKS, []).map((x) => ({ ...x, nodes: x.map.nodes.length, edges: x.map.edges.length }));
    }
  } catch { w.list = []; }
  ctx.viewTeacher();
}

async function openWork(id) {
  const w = W();
  w.ai = null;
  w.msg = '';
  if (ctx.S.server) {
    const r = await fetch(`api/teacher/works/${encodeURIComponent(id)}`, { headers: { 'X-Teacher-Token': ctx.S.auth || '' } });
    w.open = r.ok ? await r.json() : null;
  } else {
    w.open = ctx.store.get(LOCAL_WORKS, []).find((x) => String(x.id) === String(id)) || null;
  }
  ctx.viewTeacher();
}

export function teacherWorksTab() {
  const w = W();
  if (w.list === null) { loadWorks(); return '<p class="muted">Загрузка…</p>'; }
  if (w.open) {
    const o = w.open;
    const m = { ...o.map, notes: o.notes, title: o.topic };
    setTimeout(() => {
      const el = document.getElementById('work-graph');
      if (el && m.nodes.length) ctx.renderGraph(el, mapAsGraph(m, `work-${o.id}`), { zoom: true });
    }, 0);
    return `<section class="step">
      <button class="link" data-sb="w-back">← Все работы</button>
      <h3>${esc(o.topic)}</h3>
      <p class="muted small">${esc(o.name)} · ${new Date(o.created * 1000).toLocaleString('ru-RU')} · ${m.nodes.length} факторов, ${m.edges.length} связей</p>
      ${m.nodes.length ? '<div class="graph-wrap" id="work-graph"></div>' : '<p class="muted">Карта пустая — только заметки.</p>'}
      <h4>Заметки и аргументы ученика</h4>
      <div class="paragraph">${o.notes ? esc(o.notes).replace(/\n/g, '<br>') : '<span class="muted">Заметок нет.</span>'}</div>
      <div class="row"><button class="btn primary" data-sb="w-ai" ${w.busy ? 'disabled' : ''}>🤖 Спросить мнение ИИ о работе</button></div>
      <div class="messages" id="work-ai" aria-live="polite">${w.ai ? `<div class="msg assistant"><div class="md">${ctx.renderMarkdown(w.ai.text)}</div><span class="by">${esc(w.ai.by)}</span></div>` : ''}${w.busy ? '<div class="msg assistant typing">ИИ разбирает работу…</div>' : ''}</div>
      <form data-sb-form="review" class="review-form">
        <label>Комментарий учителя <textarea name="comment" rows="3" maxlength="2000">${esc(o.comment || '')}</textarea></label>
        <label>Оценка <input name="grade" maxlength="20" value="${esc(o.grade || '')}" placeholder="например, 5 или «зачёт»"></label>
        <div class="row"><button class="btn primary">Сохранить отзыв</button><button type="button" class="btn ghost" data-sb="w-del">Удалить работу</button></div>
        ${w.msg ? `<p class="small" role="status">${esc(w.msg)}</p>` : ''}
      </form>
    </section>`;
  }
  return `<section class="step">
    <h3>📥 Работы учеников</h3>
    <p class="muted small">Карты мыслей и заметки из «Песочницы». ${ctx.S.server ? 'Со всех устройств, подключённых к Коробке.' : 'Без Коробки — работы, сохранённые на этом устройстве.'}</p>
    ${w.list.length ? `<div class="cards">${w.list.map((x) => `<button class="card work-card" data-sb="w-open" data-id="${esc(x.id)}">
      <span class="tag">${x.reviewed ? `✓ проверено${x.grade ? ` · ${esc(x.grade)}` : ''}` : '● новая'}</span>
      <strong>${esc(x.topic)}</strong>
      <span class="muted">${esc(x.name)} · ${x.nodes} факторов, ${x.edges} связей · ${new Date(x.created * 1000).toLocaleDateString('ru-RU')}</span></button>`).join('')}</div>`
      : '<p class="muted">Пока никто не прислал работу. Ученики отправляют их из «Песочницы» кнопкой «Отправить учителю».</p>'}
    <button class="btn" data-sb="w-refresh">↻ Обновить</button>
  </section>`;
}

async function workAI() {
  const w = W();
  const o = w.open;
  if (!o || w.busy) return;
  w.busy = true;
  ctx.viewTeacher();
  const m = { ...o.map, notes: o.notes, title: o.topic };
  const reply = await askContext({
    mode: 'work_review', system: WORK_REVIEW_PROMPT, boxId: 'work-ai', maxTokens: 700,
    url: `api/teacher/works/${encodeURIComponent(o.id)}/ai`, headers: { 'X-Teacher-Token': ctx.S.auth || '' },
    context: { тема: o.topic, карта: { факторы: m.nodes.map((n) => n.label), связи: m.edges.map((e) => `${label(m, e.from)} —[${e.label || (e.sign >= 0 ? 'рост' : 'уменьшение')}]→ ${label(m, e.to)}`) }, заметки: o.notes },
    local: () => localMapFeedback(m, true),
  });
  w.ai = reply;
  w.busy = false;
  ctx.viewTeacher();
}

async function saveReview(form) {
  const w = W();
  const o = w.open;
  const comment = form.comment.value.trim();
  const grade = form.grade.value.trim();
  try {
    if (ctx.S.server) await ctx.teacherPost(`api/teacher/works/${encodeURIComponent(o.id)}/review`, { comment, grade });
    else {
      const all = ctx.store.get(LOCAL_WORKS, []);
      const x = all.find((y) => String(y.id) === String(o.id));
      if (x) Object.assign(x, { comment, grade, reviewed: true });
      ctx.store.set(LOCAL_WORKS, all);
    }
    Object.assign(o, { comment, grade, reviewed: true });
    w.msg = '✓ Отзыв сохранён';
    w.list = null;
  } catch (e) { w.msg = e.message; }
  ctx.viewTeacher();
}

async function onWorksClick(a, b) {
  const w = W();
  if (a === 'w-open') return openWork(b.dataset.id);
  if (a === 'w-back') { w.open = null; w.list = null; }
  if (a === 'w-refresh') w.list = null;
  if (a === 'w-ai') return workAI();
  if (a === 'w-del') {
    if (!confirm('Удалить эту работу ученика? Это нельзя отменить.')) return;
    if (ctx.S.server) await ctx.teacherPost(`api/teacher/works/${encodeURIComponent(w.open.id)}/delete`, {});
    else ctx.store.set(LOCAL_WORKS, ctx.store.get(LOCAL_WORKS, []).filter((x) => String(x.id) !== String(w.open.id)));
    w.open = null; w.list = null;
  }
  ctx.viewTeacher();
}
