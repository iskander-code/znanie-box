// Движок качественной симуляции причинно-следственного графа.
// Работает без нейросети: результат мгновенный, повторяемый и проверяемый.
//
// Изменение каждого узла — число от -1 до +1. По связи A -> B вклад равен
//   изменение(A) * знак * (сила / 3) * DECAY,
// вклады в один узел складываются. Обход идёт волнами; в следующую волну
// передаётся только прирост, поэтому петли обратной связи затухают сами.

export const DECAY = 0.85;
export const EPS = 0.05;
export const MAX_WAVES = 8;
export const DEFAULT_DELAY_LABELS = ['сразу', 'через годы', 'через десятилетия'];

const clamp = (v) => Math.max(-1, Math.min(1, v));

export function trend(value) {
  if (value > EPS) return 'up';
  if (value < -EPS) return 'down';
  return 'same';
}

export function simulate(graph, changes) {
  const outgoing = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) outgoing.get(e.from)?.push(e);

  const fixed = new Set(Object.keys(changes));
  const total = {};
  const when = {};
  const via = {};
  const events = [];
  let frontier = new Map();

  for (const [id, d] of Object.entries(changes)) {
    if (!d) continue;
    total[id] = clamp(d);
    when[id] = 0;
    frontier.set(id, total[id]);
    events.push({ wave: 0, node: id, delta: total[id], total: total[id], via: null });
  }

  for (let wave = 1; wave <= MAX_WAVES && frontier.size; wave++) {
    const incoming = new Map();
    const strongest = new Map();
    const earliest = new Map();
    for (const [src, d] of frontier) {
      for (const e of outgoing.get(src) || []) {
        if (fixed.has(e.to)) continue; // узел, который меняет ученик, удерживается
        const c = d * e.sign * (e.strength / 3) * DECAY;
        incoming.set(e.to, (incoming.get(e.to) || 0) + c);
        const best = strongest.get(e.to);
        if (!best || Math.abs(c) > Math.abs(best.c)) strongest.set(e.to, { c, edge: e });
        const t = Math.max(when[src] ?? 0, e.delay ?? 0);
        earliest.set(e.to, Math.min(earliest.get(e.to) ?? Infinity, t));
      }
    }
    const next = new Map();
    for (const [id, c] of incoming) {
      const before = total[id] || 0;
      const after = clamp(before + c);
      const inc = after - before;
      if (Math.abs(inc) < EPS / 2 || (before === 0 && Math.abs(after) < EPS)) continue;
      total[id] = after;
      const edge = strongest.get(id).edge;
      if (!(id in via)) {
        via[id] = edge;
        when[id] = earliest.get(id); // когда последствие проявится впервые — по самой быстрой цепочке
      }
      next.set(id, inc);
      events.push({ wave, node: id, delta: inc, total: after, via: edge });
    }
    frontier = next;
  }
  return { total, when, via, events, waves: Math.max(0, ...events.map((e) => e.wave)) };
}

// Цепочка связей от изменённого узла до nodeId (по самым сильным вкладам).
export function pathTo(result, nodeId) {
  const path = [];
  const seen = new Set();
  let cur = nodeId;
  while (result.via[cur] && !seen.has(cur)) {
    seen.add(cur);
    const e = result.via[cur];
    path.unshift(e);
    cur = e.from;
  }
  return path;
}

// Все простые циклы графа. Произведение знаков: + усиливающая петля, - стабилизирующая.
export function findLoops(graph) {
  const ids = graph.nodes.map((n) => n.id);
  const order = new Map(ids.map((id, i) => [id, i]));
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of graph.edges) out.get(e.from)?.push(e);
  const loops = [];
  for (const start of ids) {
    const s = order.get(start);
    const stack = [];
    const onPath = new Set([start]);
    const dfs = (node) => {
      for (const e of out.get(node)) {
        const t = order.get(e.to);
        if (e.to === start) {
          const edges = [...stack, e];
          const sign = edges.reduce((p, x) => p * x.sign, 1);
          loops.push({ nodes: [start, ...edges.slice(0, -1).map((x) => x.to)], edges, type: sign > 0 ? 'reinforcing' : 'balancing' });
        } else if (t > s && !onPath.has(e.to) && stack.length < 10) {
          onPath.add(e.to);
          stack.push(e);
          dfs(e.to);
          stack.pop();
          onPath.delete(e.to);
        }
      }
    };
    dfs(start);
  }
  return loops;
}

// Сравнение прогноза ученика с результатом симуляции.
export function checkPredictions(result, predictions) {
  return Object.entries(predictions).map(([node, guess]) => {
    const actual = trend(result.total[node] || 0);
    return { node, guess, actual, correct: guess === actual };
  });
}

// Сравнение схемы, собранной учеником, с эталоном.
export function compareGraphs(reference, draftEdges) {
  const key = (e) => `${e.from}->${e.to}`;
  const ref = new Map(reference.edges.map((e) => [key(e), e]));
  const correct = [];
  const wrongSign = [];
  const extra = [];
  for (const d of draftEdges) {
    const r = ref.get(key(d));
    if (!r) extra.push(d);
    else if (r.sign === d.sign) correct.push(r);
    else wrongSign.push(r);
  }
  const found = new Set([...correct, ...wrongSign].map(key));
  const missing = reference.edges.filter((e) => !found.has(key(e)));
  return { correct, wrongSign, extra, missing, score: correct.length / reference.edges.length };
}
