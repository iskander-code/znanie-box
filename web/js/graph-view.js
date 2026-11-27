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

/**
 * opts: total {id: delta}, selected id, predictions {id: up|down|same},
 *       edges (переопределить набор рёбер — для режима «Собери сам»),
 *       highlightEdges Set of edges, hideSigns bool
 */
export function renderGraph(container, graph, opts = {}) {
  const L = layout(graph);
  const edges = opts.edges || graph.edges;
  const total = opts.total || {};
  const bottom = L.baseHeight + 30;
  const parts = [];
  parts.push(`<svg class="graph" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" role="img" aria-label="${esc(graph.title)}">`);
  parts.push('<defs>' + ['pos', 'neg', 'hl'].map((k) => `<marker id="arr-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrow-${k}"/></marker>`).join('') + '</defs>');

  edges.forEach((e, i) => {
    const a = L.coords.get(e.from), b = L.coords.get(e.to);
    if (!a || !b) return;
    const { d, mx, my } = edgePath(a, b, L.back.has(e), bottom);
    const hl = opts.highlightEdges?.has(e);
    const cls = `edge ${e.sign > 0 ? 'pos' : 'neg'}${hl ? ' hl' : ''}${opts.dimEdges && !hl ? ' dim' : ''}${e.verified === false ? ' unverified' : ''}`;
    const marker = hl ? 'hl' : e.sign > 0 ? 'pos' : 'neg';
    parts.push(`<g class="${cls}" data-edge="${i}"><path class="edge-hit" d="${d}"/><path class="edge-line" d="${d}" marker-end="url(#arr-${marker})"/>`);
    if (!opts.hideSigns) parts.push(`<circle cx="${mx}" cy="${my}" r="10" class="edge-badge"/><text x="${mx}" y="${my + 4.5}" class="edge-sign">${e.sign > 0 ? '+' : '−'}</text>`);
    parts.push('</g>');
  });

  for (const n of graph.nodes) {
    const { x, y } = L.coords.get(n.id);
    const v = total[n.id] || 0;
    const t = trend(v);
    const cls = ['node', `t-${t}`, n.adjustable ? 'adjustable' : '', opts.selected === n.id ? 'selected' : '', opts.pending === n.id ? 'pending' : ''].join(' ');
    const lines = wrap(n.label);
    const ty = y + NODE_H / 2 - ((lines.length - 1) * 15) / 2 + 4.5;
    parts.push(`<g class="${cls}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.label)}">`);
    parts.push(`<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" style="--intensity:${Math.min(1, Math.abs(v)).toFixed(2)}"/>`);
    lines.forEach((ln, i) => parts.push(`<text x="${x + NODE_W / 2}" y="${ty + i * 15}" class="node-label">${esc(ln)}</text>`));
    if (t !== 'same') parts.push(`<text x="${x + NODE_W - 8}" y="${y + 16}" class="node-trend">${t === 'up' ? '▲' : '▼'}${Math.round(Math.abs(v) * 100)}</text>`);
    const p = opts.predictions?.[n.id];
    if (p) parts.push(`<text x="${x + 8}" y="${y + 16}" class="node-guess">${{ up: '▲?', down: '▼?', same: '=?' }[p]}</text>`);
    if (n.adjustable) parts.push(`<text x="${x + 8}" y="${y + NODE_H - 7}" class="node-adj">можно менять</text>`);
    parts.push('</g>');
  }
  parts.push('</svg>');
  container.innerHTML = parts.join('');

  const svg = container.querySelector('svg');
  svg.addEventListener('click', (ev) => {
    const nodeEl = ev.target.closest('[data-node]');
    if (nodeEl && opts.onNodeClick) return opts.onNodeClick(nodeEl.dataset.node);
    const edgeEl = ev.target.closest('[data-edge]');
    if (edgeEl && opts.onEdgeClick) opts.onEdgeClick(edges[Number(edgeEl.dataset.edge)]);
  });
  svg.addEventListener('keydown', (ev) => {
    const nodeEl = ev.target.closest('[data-node]');
    if (nodeEl && (ev.key === 'Enter' || ev.key === ' ') && opts.onNodeClick) { ev.preventDefault(); opts.onNodeClick(nodeEl.dataset.node); }
  });
}
