// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate, pathTo, findLoops, checkPredictions, compareGraphs, trend } from '../web/js/engine.js';
import { Library, localAnswer, makeQuiz, checkQuiz } from '../web/js/tutor-local.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const graphs = ['ocean', 'serfdom', 'keyrate'].map((id) => load(`../web/data/graphs/${id}.json`));
const texts = load('../web/data/texts.json');
const chain = { id: 'c', nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ from: 'a', to: 'b', sign: -1, strength: 3, delay: 0 }, { from: 'b', to: 'c', sign: -1, strength: 3, delay: 1 }] };

test('два ослабления подряд дают рост', () => {
  const r = simulate(chain, { a: 1 });
  assert.equal(trend(r.total.b), 'down');
  assert.equal(trend(r.total.c), 'up');
  assert.deepEqual(pathTo(r, 'c').map((e) => e.to), ['b', 'c']);
  assert.equal(r.when.c, 1);
});

test('изменение затухает по цепочке', () => {
  const r = simulate(chain, { a: 1 });
  assert.ok(Math.abs(r.total.c) < Math.abs(r.total.b));
});

test('петля обратной связи не зацикливается и находится', () => {
  const ocean = graphs[0];
  const r = simulate(ocean, { ice: -0.9 });
  assert.ok(r.waves <= 8);
  assert.equal(trend(r.total.t), 'up', 'меньше льда — теплее океан');
  const loops = findLoops(ocean);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].type, 'reinforcing');
});

test('повышение ставки снижает инфляцию и рост экономики', () => {
  const r = simulate(graphs[2], { rate: 0.7 });
  assert.equal(trend(r.total.inflation), 'down');
  assert.equal(trend(r.total.growth), 'down');
  assert.equal(trend(r.total.ruble), 'up');
});

test('прогноз и сборка схемы сравниваются с эталоном', () => {
  const r = simulate(graphs[0], { t: 0.6 });
  const checks = checkPredictions(r, { fish: 'down', sea: 'down' });
  assert.deepEqual(checks.map((c) => c.correct), [true, false]);
  const cmp = compareGraphs(graphs[0], [{ from: 't', to: 'o2', sign: -1 }, { from: 't', to: 'sea', sign: -1 }, { from: 'fish', to: 't', sign: 1 }]);
  assert.equal(cmp.correct.length, 1);
  assert.equal(cmp.wrongSign.length, 1);
  assert.equal(cmp.extra.length, 1);
  assert.equal(cmp.missing.length, graphs[0].edges.length - 2);
});

test('каждая цитата в эталонных схемах есть в тексте параграфа', () => {
  for (const g of graphs) {
    const text = texts.find((t) => t.id === g.text).text;
    for (const e of g.edges) assert.ok(text.includes(e.evidence), `${g.id}: «${e.evidence}»`);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${g.id}: ${e.from}->${e.to}`);
  }
});

test('Сова находит источник, наводит на мысль и честно отказывает', () => {
  const lib = new Library(texts);
  const fr = lib.search('Почему кораллы обесцвечиваются?');
  assert.ok(['Коралловые рифы', 'Потепление океана'].includes(fr[0].title));
  const hint = localAnswer({ message: 'Почему кораллы обесцвечиваются?', mode: 'socratic', level: 0, fragments: fr });
  assert.match(hint.text, /причин/);
  const none = localAnswer({ message: 'Кто выиграл чемпионат мира по футболу?', mode: 'socratic', level: 0, fragments: lib.search('Кто выиграл чемпионат мира по футболу?') });
  assert.match(none.text, /нет ответа/);
  const quiz = makeQuiz(lib.search('инфляция цены'));
  assert.ok(quiz.question.includes('_____'));
  assert.match(checkQuiz(quiz, quiz.answer), /Верно/);
});
