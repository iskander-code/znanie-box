// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate, pathTo, findLoops, checkPredictions, compareGraphs, trend } from '../web/js/engine.js';
import { Library, localAnswer, makeQuiz, checkQuiz, RELEVANT } from '../web/js/tutor-local.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const graphs = load('../web/data/graphs/index.json').map((id) => load(`../web/data/graphs/${id}.json`));
const byId = (id) => graphs.find((g) => g.id === id);
const texts = load('../web/data/library/index.json').flatMap((s) => load(`../web/data/library/${s.id}.json`).map((d) => ({ ...d, subject: s.name })));
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
  const loop = { nodes: [{ id: 'ice' }, { id: 'albedo' }, { id: 't' }], edges: [
    { from: 't', to: 'ice', sign: -1, strength: 2, delay: 1 }, { from: 'ice', to: 'albedo', sign: 1, strength: 3, delay: 0 }, { from: 'albedo', to: 't', sign: -1, strength: 2, delay: 1 }] };
  const r = simulate(loop, { ice: -0.9 });
  assert.ok(r.waves <= 8);
  assert.equal(trend(r.total.t), 'up', 'меньше льда — теплее');
  const loops = findLoops(loop);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].type, 'reinforcing');
});

test('Арал: больше забора воды — меньше рыболовства и здоровья, плотина поднимает уровень', () => {
  const r = simulate(byId('aral'), { irrigation: 0.8 });
  for (const n of ['inflow', 'level', 'fish', 'fishing', 'health']) assert.equal(trend(r.total[n]), 'down', n);
  assert.equal(trend(r.total.salinity), 'up');
  assert.equal(trend(simulate(byId('aral'), { dam: 0.7 }).total.level), 'up');
});

test('закон Ома: рост сопротивления уменьшает ток и нагрев', () => {
  const r = simulate(byId('ohm'), { R: 0.6 });
  assert.equal(trend(r.total.I), 'down');
  assert.equal(trend(r.total.heat), 'down');
});

test('прогноз и сборка схемы сравниваются с эталоном', () => {
  const g = byId('tselina');
  const r = simulate(g, { plow: 0.8 });
  const checks = checkPredictions(r, { grain: 'up', share: 'down' });
  assert.deepEqual(checks.map((c) => c.correct), [true, false]);
  const cmp = compareGraphs(g, [{ from: 'plow', to: 'sown', sign: 1 }, { from: 'erosion', to: 'soil', sign: 1 }, { from: 'grain', to: 'plow', sign: 1 }]);
  assert.equal(cmp.correct.length, 1);
  assert.equal(cmp.wrongSign.length, 1);
  assert.equal(cmp.extra.length, 1);
  assert.equal(cmp.missing.length, g.edges.length - 2);
});

test('каждая цитата в эталонных схемах есть в тексте параграфа', () => {
  for (const g of graphs) {
    const text = texts.find((t) => t.id === g.text).text;
    for (const e of g.edges) assert.ok(text.includes(e.evidence), `${g.id}: «${e.evidence}»`);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${g.id}: ${e.from}->${e.to}`);
  }
});

test('библиотека: ~100 тем на предмет, уникальные id', () => {
  const counts = {};
  for (const t of texts) counts[t.subject] = (counts[t.subject] || 0) + 1;
  for (const n of Object.values(counts)) assert.ok(n >= 95, JSON.stringify(counts));
  assert.equal(new Set(texts.map((t) => t.id)).size, texts.length);
});

test('Сова находит источник, наводит на мысль и честно отказывает', () => {
  const lib = new Library(texts);
  const q = 'Почему высохло Аральское море?';
  const fr = lib.search(q);
  assert.equal(fr[0].title, 'Трагедия Аральского моря');
  const hint = localAnswer({ message: q, mode: 'socratic', level: 0, fragments: fr });
  assert.match(hint.text, /причин/);
  assert.equal(lib.search('Что такое закон Ома?')[0].title, 'Закон Ома для участка цепи');
  const none = localAnswer({ message: 'Кто выиграл чемпионат мира по футболу?', mode: 'socratic', level: 0, fragments: lib.search('Кто выиграл чемпионат мира по футболу?') });
  assert.match(none.text, /нет ответа/);
  const quiz = makeQuiz(lib.search('дискриминант квадратного уравнения'));
  assert.ok(quiz.question.includes('_____'));
  assert.match(checkQuiz(quiz, quiz.answer), /Верно/);
});

test('вопросы вне библиотеки уходят нейросети, по темам — остаются в библиотеке', () => {
  const lib = new Library(texts);
  for (const q of ['Почему небо голубое?', 'Сколько будет 2+2?', 'Как готовить бешбармак?']) assert.equal(RELEVANT(lib.search(q)), false, q);
  for (const q of ['Почему высохло Аральское море?', 'Кто такие саки?', 'Как найти дискриминант?', 'Как работает трансформатор?']) assert.equal(RELEVANT(lib.search(q)), true, q);
});

test('офлайн-режим: в кэш service worker входят все файлы сайта', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join, relative, sep } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(web).map((f) => relative(web, f).split(sep).join('/')).filter((f) => !['sw.js', '.nojekyll'].includes(f));
  const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  for (const f of files) assert.ok(sw.includes(`'${f}'`), `файл ${f} не попадает в офлайн-кэш — добавь его в FILES в web/sw.js`);
});

test('QR-код: верная матрица (сверена с эталонной библиотекой qrcode) и все версии строятся', async () => {
  const { qrMatrix, qrSVG } = await import('../web/js/qr.js');
  const m = qrMatrix('http://192.168.137.1:8000/', 2).map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('');
  let h = 0;
  for (const c of m) h = (h * 31 + Number(c)) >>> 0;
  assert.equal(m.length, 625); // версия 2, 25×25
  assert.equal(h, 1713036324);
  for (const len of [1, 30, 80, 150, 213]) {
    const q = qrMatrix('x'.repeat(len));
    assert.equal(q.length, q[0].length);
    assert.deepEqual(q[0].slice(0, 7), Array(7).fill(true), 'поисковый узор в углу');
  }
  assert.throws(() => qrMatrix('x'.repeat(300)));
  assert.match(qrSVG('http://a/'), /^<svg/);
});

test('PIN учителя: хэш в браузере совпадает с сервером', async () => {
  const { hashPin, PIN_HASH } = await import('../web/js/teacher.js');
  assert.equal(await hashPin('2026'), PIN_HASH);
  assert.notEqual(await hashPin('2025'), PIN_HASH);
});
