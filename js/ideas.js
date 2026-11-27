// Творческая часть «Что будет, если…» и «Собери сам»: своё условие текстом, своя идея-узел
// и разбор идеи. Работает без нейросети (встроенный разбор), а с нейросетью — точнее.
import { simulate, pathTo, findLoops, trend } from './engine.js';
import { relationVerb } from './graph-view.js';

const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
// Основа слова: «плотину»/«плотина» → «плот», «вырубку»/«вырубка» → «выру».
const stems = (s) => new Set((norm(s).match(/[а-яa-z0-9]+/g) || []).filter((w) => w.length > 3).map((w) => w.slice(0, Math.max(4, Math.min(5, w.length - 2)))));

const UP = /(постро|увелич|больше|рост|вырос|усил|добав|повыс|расшир|подня|ускор|удво|сажа|посад|откры|нача|разреш|вложи|улучш|прибав)/;
const DOWN = /(уменьш|меньше|сократ|запрет|останов|прекрат|сниз|убра|закры|разруш|перест|ограни|отмени|замедл|прекращ|вдвое меньше|без )/;
const STRONG = /(сильно|резко|вдвое|в два раза|намного|полностью|совсем)/;

/**
 * Своё условие ученика → изменения узлов схемы. «Что, если построили плотину выше по течению?» →
 * { changes: { dam: 0.6 }, matched: [{ id, label, dir, word }] }. Узлы ищутся по основам слов,
 * направление — по словам «построили», «запретили», «уменьшили» и т. п. рядом с найденным словом.
 */
export function parseScenario(graph, text) {
  const t = norm(text);
  const words = t.match(/[а-яa-z0-9]+/g) || [];
  const stemOf = (w) => w.slice(0, Math.max(4, Math.min(5, w.length - 2)));
  // Каждое слово ученика относится только к одному фактору: побеждает фактор, у которого совпало больше слов.
  const cands = graph.nodes.map((n) => {
    const ns = stems(n.label);
    const hits = words.map((w, i) => (w.length > 3 && ns.has(stemOf(w)) ? i : -1)).filter((i) => i >= 0);
    return { n, hits };
  }).filter((c) => c.hits.length).sort((a, b) => b.hits.length - a.hits.length);
  const used = new Set();
  const matched = [];
  for (const { n, hits } of cands) {
    const free = hits.filter((i) => !used.has(i));
    if (!free.length) continue;
    hits.forEach((i) => used.add(i));
    const hitIndex = free[0];
    // направление ищем в словах до найденного (глагол обычно стоит перед: «запретили вырубку»)
    const before = words.slice(Math.max(0, hitIndex - 4), hitIndex + 1).join(' ');
    const around = words.slice(Math.max(0, hitIndex - 4), hitIndex + 3).join(' ');
    const dir = DOWN.test(before) ? -1 : UP.test(before) ? 1 : DOWN.test(around) ? -1 : 1;
    matched.push({ id: n.id, label: n.label, dir, word: words[hitIndex] });
  }
  const k = STRONG.test(t) ? 0.9 : 0.6;
  const changes = Object.fromEntries(matched.map((m) => [m.id, m.dir * k]));
  return { changes, matched };
}

/** Схема вместе с идеями ученика: идея — новый узел, связи — пунктирные стрелки. */
export function withIdeas(graph, ideas = []) {
  if (!ideas.length) return graph;
  return {
    ...graph,
    nodes: [...graph.nodes, ...ideas.map((i) => ({ id: i.id, label: i.label, idea: true, adjustable: !i.links.some((l) => l.to === i.id) }))],
    edges: [...graph.edges, ...ideas.flatMap((i) => i.links
      .filter((l) => graph.nodes.some((n) => n.id === l.from || n.id === l.to))
      .map((l) => ({ from: l.from, to: l.to, sign: l.sign, strength: 2, delay: 1, idea: true, evidence: i.hypothesis ? `Гипотеза ученика: ${i.hypothesis}` : 'Идея ученика' })))],
  };
}

/** Что изменит идея по схеме: запускаем её «на рост» и смотрим, куда дойдёт изменение. */
export function ideaEffects(graph, idea) {
  const g = withIdeas(graph, [idea]);
  const r = simulate(g, { [idea.id]: 0.7 });
  const label = (id) => g.nodes.find((n) => n.id === id)?.label || id;
  const effects = Object.keys(r.total)
    .filter((id) => id !== idea.id && trend(r.total[id]) !== 'same')
    .sort((a, b) => Math.abs(r.total[b]) - Math.abs(r.total[a]))
    .map((id) => ({ id, label: label(id), trend: trend(r.total[id]), delay: r.when[id] ?? 0, path: pathTo(r, id).map((e) => `«${label(e.from)}» ${relationVerb(e)} «${label(e.to)}»`) }));
  const loops = findLoops(g).filter((l) => l.nodes.includes(idea.id));
  return { effects, loops, graph: g };
}

/** Встроенный разбор идеи, когда нейросети нет: хвалим, показываем последствия и побочные эффекты, задаём вопрос. */
export function localIdeaFeedback(graph, idea) {
  const { effects, loops, graph: g } = ideaEffects(graph, idea);
  const label = (id) => g.nodes.find((n) => n.id === id)?.label || id;
  const out = [];
  const targets = idea.links.filter((l) => l.from === idea.id).map((l) => `«${label(l.to)}»`);
  out.push(`**Интересная идея — «${idea.label}»!** ${targets.length ? `Ты связал её с ${targets.join(' и ')} — значит, видишь, на что она может повлиять.` : 'Попробуй соединить её стрелкой с фактором, на который она влияет.'}`);
  if (effects.length) {
    const ups = effects.filter((e) => e.trend === 'up').slice(0, 3).map((e) => `▲ «${e.label}»`);
    const downs = effects.filter((e) => e.trend === 'down').slice(0, 3).map((e) => `▼ «${e.label}»`);
    out.push(`По схеме твоя идея вызовет: ${[...ups, ...downs].join(', ')}.`);
    const far = effects.find((e) => e.path.length >= 2);
    if (far) out.push(`Цепочка домино: ${far.path.join(' → ')}.`);
    const direct = new Set(idea.links.filter((l) => l.from === idea.id).map((l) => l.to));
    const side = effects.filter((e) => !direct.has(e.id)).at(-1);
    if (side && effects.length > 1) out.push(`Подумай о побочных эффектах: кроме того, что ты хотел, ${side.trend === 'up' ? 'вырастет' : 'уменьшится'} и «${side.label}». Это хорошо или плохо — и для кого?`);
  } else {
    out.push('Пока идея ни на что не влияет по схеме — добавь стрелку от неё к одному из факторов.');
  }
  if (loops.length) out.push(`**Сильный ход:** ты создал петлю обратной связи (${loops[0].type === 'reinforcing' ? 'усиливающую' : 'стабилизирующую'}) — изменения будут ${loops[0].type === 'reinforcing' ? 'нарастать' : 'гаситься'} сами.`);
  if (idea.hypothesis && idea.hypothesis.length > 20) out.push('Хорошо, что ты объяснил гипотезу словами — так её легче проверить.');
  const hasCause = idea.links.some((l) => l.to === idea.id);
  out.push(hasCause
    ? `**Вопрос:** что может помешать идее «${idea.label}» сработать в первые годы?`
    : `**Вопрос:** что нужно, чтобы идея «${idea.label}» заработала — откуда возьмутся вода, деньги или люди в первые 3 года?`);
  return out.join('\n\n');
}
