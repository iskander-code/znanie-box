// Отрисовка причинно-следственного графа в SVG без внешних библиотек.
// Раскладка слоями слева направо: причины слева, следствия справа.
import { trend } from './engine.js';

const NODE_W = 160;
const NODE_H = 62;
const GAP_X = 74;
const GAP_Y = 26;
const PAD = 24;

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function layout(graph) {
  const ids = graph.nodes.map((n) => n.id);
  const out = new Map(ids.map((id) => [id, []]));
  graph.edges.forEach((e) => out.get(e.from)?.push(e));

  // 1. Обратные рёбра (замыкающие петли) находим обходом в глубину.
  const back = new Set();
  const state = new Map();
  const starts = [...graph.nodes].sort((a, b) => (b.adjustable ? 1 : 0) - (a.adjustable ? 1 : 0)).map((n) => n.id);
  const dfs = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) {
      const s = state.get(e.to);
      if (s === 1) back.add(e);
      else if (!s) dfs(e.to);
    }
    state.set(id, 2);
  };
  starts.forEach((id) => { if (!state.get(id)) dfs(id); });

  // 2. Слой узла = длина самого длинного пути до него без обратных рёбер.
  const layer = new Map(ids.map((id) => [id, 0]));
  for (let i = 0; i < ids.length; i++) {
    for (const e of graph.edges) {
      if (back.has(e)) continue;
      if (layer.get(e.to) < layer.get(e.from) + 1) layer.set(e.to, layer.get(e.from) + 1);
    }
  }
  const layers = [];
  ids.forEach((id) => { (layers[layer.get(id)] ||= []).push(id); });

  // 3. Порядок внутри слоя — по среднему положению соседей (два прохода).
  const pos = new Map();
  layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0;
    layers.forEach((l) => {
      const score = new Map(l.map((id) => {
        const nb = graph.edges.filter((e) => !back.has(e) && (forward ? e.to === id : e.from === id)).map((e) => pos.get(forward ? e.from : e.to));
        return [id, nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : pos.get(id)];
      }));
      l.sort((a, b) => score.get(a) - score.get(b));
      l.forEach((id, i) => pos.set(id, i));
    });
  }

  const maxRows = Math.max(...layers.map((l) => l.length));
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;
  const coords = new Map();
  layers.forEach((l, li) => {
    const colH = l.length * NODE_H + (l.length - 1) * GAP_Y;
    const y0 = (height - colH) / 2;
    l.forEach((id, i) => coords.set(id, { x: PAD + li * (NODE_W + GAP_X), y: y0 + i * (NODE_H + GAP_Y) }));
  });
  const width = PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X;
  const hasBack = graph.edges.some((e) => back.has(e) || layer.get(e.to) <= layer.get(e.from));
  return { coords, back, width, height: height + (hasBack ? 56 : 0), baseHeight: height };
}

function wrap(label, max = 19) {
  const words = label.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function edgePath(a, b, isBack, bottom) {
  if (!isBack && b.x > a.x) {
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x - 4, y2 = b.y + NODE_H / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    const d = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    return { d, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  }
  // Обратная связь: дуга под графом.
  const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2 + 10, y2 = b.y + NODE_H + 4;
  const d = `M${x1} ${y1} C${x1} ${bottom}, ${x2} ${bottom}, ${x2} ${y2}`;
  return { d, mx: (x1 + x2) / 2, my: bottom - 12 };
}

/** Смысловая связь вместо «+ / −»: «вызывает рост», «приводит к уменьшению»… В схемах можно задать своё слово (edge.verb). */
export function relationVerb(e) {
  if (e.verb) return e.verb;
  if (e.sign > 0) return e.strength >= 3 ? 'сильно увеличивает' : e.strength <= 1 ? 'немного увеличивает' : 'вызывает рост';
  return e.strength >= 3 ? 'резко сокращает' : e.strength <= 1 ? 'немного уменьшает' : 'приводит к уменьшению';
}
/** «Забор воды на орошение» забирает воду и сокращает → «Приток рек в море» */
export const relationPhrase = (graph, e) => {
  const label = (id) => graph.nodes.find((n) => n.id === id)?.label || id;
  return `«${label(e.from)}» ${relationVerb(e)} → «${label(e.to)}»`;
};

// Масштаб и сдвиг холста запоминаем для каждого контейнера, чтобы схема не «прыгала» при перерисовке.
const views = new WeakMap();

/**
 * opts: total {id: delta}, selected id, predictions {id: up|down|same},
 *       edges (переопределить набор рёбер — для режима «Собери сам»),
 *       highlightEdges Set of edges, hideSigns bool,
 *       zoom — холст с масштабом и перетаскиванием (мышь, палец, два пальца), кнопками + − ⟲ и ⛶;
 *       onFullscreen — что делать по кнопке «⛶ На весь экран».
 */
export function renderGraph(container, graph, opts = {}) {
  const L = layout(graph);
  const edges = opts.edges || graph.edges;
  const total = opts.total || {};
  const bottom = L.baseHeight + 30;
  const parts = [];
  const sizeAttr = opts.zoom ? 'preserveAspectRatio="xMidYMid meet"' : `width="${L.width}"`;
  parts.push(`<svg class="graph${opts.zoom ? ' zoomable' : ''}" viewBox="0 0 ${L.width} ${L.height}" ${sizeAttr} role="img" aria-label="${esc(graph.title)}">`);
  parts.push('<defs>' + ['pos', 'neg', 'hl', 'idea'].map((k) => `<marker id="arr-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrow-${k}"/></marker>`).join('') + '</defs>');

  edges.forEach((e, i) => {
    const a = L.coords.get(e.from), b = L.coords.get(e.to);
    if (!a || !b) return;
    const { d, mx, my } = edgePath(a, b, L.back.has(e), bottom);
    const hl = opts.highlightEdges?.has(e);
    const cls = `edge ${e.sign > 0 ? 'pos' : 'neg'}${hl ? ' hl' : ''}${opts.dimEdges && !hl ? ' dim' : ''}${e.verified === false ? ' unverified' : ''}${e.idea ? ' idea' : ''}`;
    const marker = hl ? 'hl' : e.idea ? 'idea' : e.sign > 0 ? 'pos' : 'neg';
    parts.push(`<g class="${cls}" data-edge="${i}"><title>${esc(relationPhrase(graph, e))}</title><path class="edge-hit" d="${d}"/><path class="edge-line" d="${d}" marker-end="url(#arr-${marker})"/>`);
    // ▲ — рост, ▼ — уменьшение: смысл дублируется значком, а не только цветом
    if (!opts.hideSigns) parts.push(`<circle cx="${mx}" cy="${my}" r="11" class="edge-badge"/><text x="${mx}" y="${my + 4.5}" class="edge-sign">${e.sign > 0 ? '▲' : '▼'}</text>`);
    parts.push('</g>');
  });

  for (const n of graph.nodes) {
    const { x, y } = L.coords.get(n.id);
    const v = total[n.id] || 0;
    const t = trend(v);
    const cls = ['node', `t-${t}`, n.adjustable ? 'adjustable' : '', n.idea ? 'idea' : '', opts.selected === n.id ? 'selected' : '', opts.pending === n.id ? 'pending' : ''].join(' ');
    const lines = wrap(n.label);
    const ty = y + NODE_H / 2 - ((lines.length - 1) * 15) / 2 + 4.5;
    parts.push(`<g class="${cls}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.label)}">`);
    parts.push(`<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" style="--intensity:${Math.min(1, Math.abs(v)).toFixed(2)}"/>`);
    lines.forEach((ln, i) => parts.push(`<text x="${x + NODE_W / 2}" y="${ty + i * 15}" class="node-label">${esc(ln)}</text>`));
    if (t !== 'same') parts.push(`<text x="${x + NODE_W - 8}" y="${y + 16}" class="node-trend">${t === 'up' ? '▲' : '▼'}${Math.round(Math.abs(v) * 100)}</text>`);
    const p = opts.predictions?.[n.id];
    if (p) parts.push(`<text x="${x + 8}" y="${y + 16}" class="node-guess">${{ up: '▲?', down: '▼?', same: '=?' }[p]}</text>`);
    if (n.idea) parts.push(`<text x="${x + 8}" y="${y + NODE_H - 7}" class="node-adj">💡 моя идея</text>`);
    else if (n.adjustable) parts.push(`<text x="${x + 8}" y="${y + NODE_H - 7}" class="node-adj">можно менять</text>`);
    parts.push('</g>');
  }
  parts.push('</svg>');
  if (opts.zoom) {
    parts.push(`<div class="zoom-ctrl" role="group" aria-label="Масштаб схемы">
      <button type="button" data-zoom="in" aria-label="Приблизить">+</button>
      <button type="button" data-zoom="out" aria-label="Отдалить">−</button>
      <button type="button" data-zoom="fit" aria-label="Показать всю схему">⟲</button>
      ${opts.onFullscreen ? `<button type="button" data-zoom="fs" aria-label="${opts.fullscreen ? 'Выйти из полноэкранного режима' : 'Схема на весь экран'}">${opts.fullscreen ? '✕' : '⛶'}</button>` : ''}
    </div>`);
  }
  container.innerHTML = parts.join('');
  container.classList.toggle('has-zoom', !!opts.zoom);

  const svg = container.querySelector('svg');
  let dragged = false;
  svg.addEventListener('click', (ev) => {
    if (dragged) { dragged = false; return; } // это было перетаскивание холста, а не нажатие
    const nodeEl = ev.target.closest('[data-node]');
    if (nodeEl && opts.onNodeClick) return opts.onNodeClick(nodeEl.dataset.node);
    const edgeEl = ev.target.closest('[data-edge]');
    if (edgeEl && opts.onEdgeClick) opts.onEdgeClick(edges[Number(edgeEl.dataset.edge)]);
  });
  svg.addEventListener('keydown', (ev) => {
    const nodeEl = ev.target.closest('[data-node]');
    if (nodeEl && (ev.key === 'Enter' || ev.key === ' ') && opts.onNodeClick) { ev.preventDefault(); opts.onNodeClick(nodeEl.dataset.node); }
  });
  if (!opts.zoom) return;

  // ---------- масштаб и перетаскивание ----------
  const full = { x: -20, y: -20, w: L.width + 40, h: L.height + 40 };
  const key = `${graph.id}:${graph.nodes.length}:${L.width}x${L.height}`;
  // Начальный вид: если вся схема в ширину получается мельче ~70% натуральной величины, показываем её
  // читаемо с начала (слева), а остальное можно досмотреть, сдвинув холст. «⟲» — вся схема целиком.
  const readable = () => {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return { ...full };
    const fitScale = Math.min(r.width / full.w, r.height / full.h);
    if (fitScale >= 0.7) return { ...full };
    const k = Math.min(1, Math.max(0.7, fitScale));
    const w = r.width / k, h = r.height / k;
    return { x: full.x, y: full.y + (full.h - h) / 2, w, h };
  };
  const saved = views.get(container)?.key === key ? views.get(container) : null;
  let vb = saved ? saved.vb : readable();
  let touched = saved?.touched || false; // ученик сам двигал или приближал схему
  const apply = () => { svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); views.set(container, { key, vb, touched }); };
  const move = () => { touched = true; apply(); };
  const zoomAt = (factor, cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2) => {
    const w = Math.min(full.w * 2.5, Math.max(full.w / 6, vb.w / factor));
    const k = w / vb.w;
    vb = { x: cx - (cx - vb.x) * k, y: cy - (cy - vb.y) * k, w, h: vb.h * k };
    move();
  };
  const toSvg = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    const scale = Math.max(vb.w / r.width, vb.h / r.height); // как у preserveAspectRatio="meet"
    const offX = (r.width * scale - vb.w) / 2, offY = (r.height * scale - vb.h) / 2;
    return { x: vb.x + (clientX - r.left) * scale - offX, y: vb.y + (clientY - r.top) * scale - offY, scale };
  };
  apply();
  container.querySelector('.zoom-ctrl').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-zoom]');
    if (!b) return;
    if (b.dataset.zoom === 'in') zoomAt(1.3);
    if (b.dataset.zoom === 'out') zoomAt(1 / 1.3);
    if (b.dataset.zoom === 'fit') { vb = { ...full }; move(); }
    if (b.dataset.zoom === 'fs') opts.onFullscreen();
  });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const pt = toSvg(ev.clientX, ev.clientY);
    zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, pt.x, pt.y);
  }, { passive: false });
  const pointers = new Map();
  let start = null;
  svg.addEventListener('pointerdown', (ev) => {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 1) start = { x: ev.clientX, y: ev.clientY, vb: { ...vb }, moved: false };
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      start = { pinch: Math.hypot(p1.x - p2.x, p1.y - p2.y), vb: { ...vb }, mid: toSvg((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), moved: true };
    }
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId) || !start) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2 && start.pinch) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      vb = { ...start.vb };
      zoomAt(d / start.pinch, start.mid.x, start.mid.y);
      return;
    }
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 6) return;
    if (!start.moved) svg.setPointerCapture?.(ev.pointerId);
    start.moved = true;
    const { scale } = toSvg(ev.clientX, ev.clientY);
    vb = { ...start.vb, x: start.vb.x - dx * scale, y: start.vb.y - dy * scale };
    move();
  });
  const end = (ev) => {
    if (start?.moved) dragged = true;
    pointers.delete(ev.pointerId);
    if (!pointers.size) start = null;
    setTimeout(() => { dragged = false; }, 0);
  };
  // Поменялся размер окна (повернули телефон, открыли на весь экран) — пересчитываем читаемый вид,
  // если ученик сам схему не двигал.
  if ('ResizeObserver' in window) {
    let lastW = svg.getBoundingClientRect().width;
    new ResizeObserver(() => {
      const w = svg.getBoundingClientRect().width;
      if (!w || Math.abs(w - lastW) < 40 || touched) return;
      lastW = w;
      vb = readable();
      apply();
    }).observe(svg);
  }
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}
