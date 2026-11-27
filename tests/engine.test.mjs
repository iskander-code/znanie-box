// Запуск: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
  // Про Арал теперь есть темы в истории, биологии и географии: первым может оказаться любая,
  // но тема со схемой «Что будет, если…» должна быть среди первых трёх.
  assert.match(fr[0].title, /Арал/);
  assert.ok(fr.slice(0, 3).some((f) => f.title === 'Трагедия Аральского моря'));
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
  const { statSync } = await import('node:fs');
  const { join, relative, sep } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(web).map((f) => relative(web, f).split(sep).join('/')).filter((f) => !['sw.js', '.nojekyll'].includes(f) && !f.startsWith('phet/'));
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

test('«Собери сам»: у каждой связи есть цитата, и она дословно есть в параграфе', () => {
  const texts = {};
  for (const s of load('../web/data/library/index.json')) for (const d of load(`../web/data/library/${s.id}.json`)) texts[d.id] = d.text;
  for (const g of graphs) {
    const text = (g.sourceText || texts[g.text] || '').toLowerCase();
    assert.ok(text, `${g.id}: нет параграфа`);
    for (const e of g.edges) assert.ok(e.evidence && text.includes(e.evidence.toLowerCase()), `${g.id}: ${e.from}→${e.to} — цитаты нет в тексте`);
  }
});

test('опыты PhET: у каждого есть файл и задание, темы существуют в библиотеке', () => {
  const labs = load('../web/data/phet.json');
  const ids = new Set(texts.map((d) => d.id));
  const files = readdirSync(new URL('../web/phet/', import.meta.url)).filter((f) => f.endsWith('.html'));
  assert.deepEqual(files.sort(), labs.filter((l) => !l.src).map((l) => `${l.id}.html`).sort(), 'список web/phet/ и data/phet.json расходятся');
  for (const l of labs.filter((x) => x.src)) assert.ok(readFileSync(new URL(`../web/${l.src}`, import.meta.url), 'utf8').includes('<canvas'), `${l.src}: свой симулятор`);
  for (const l of labs) {
    assert.ok(l.title && l.task && ['physics', 'algebra', 'geometry', 'geography', 'biology', 'chemistry'].includes(l.subject), l.id);
    for (const t of l.topics) assert.ok(ids.has(t), `${l.id}: нет темы ${t}`);
  }
});

test('офлайн-кэш: опыты PhET сохраняются при первом открытии и переживают обновление сайта', async () => {
  const code = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  const stores = new Map();
  const cacheOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    const key = (r) => new URL(typeof r === 'string' ? r : r.url).pathname;
    return { match: async (r) => m.get(key(r))?.clone(), put: async (r, res) => { m.set(key(r), res); }, addAll: async () => {} };
  };
  const handlers = {};
  let online = true;
  let fetches = 0;
  const env = {
    self: { location: { origin: 'http://box' }, addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { open: async (n) => cacheOf(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) },
    fetch: async () => { fetches++; if (!online) throw new Error('offline'); return new Response('<html>sim</html>', { status: 200 }); },
  };
  new Function('self', 'caches', 'fetch', code)(env.self, env.caches, env.fetch);
  const open = async (url) => {
    let p;
    handlers.fetch({ request: { url, method: 'GET', mode: 'navigate' }, respondWith: (x) => { p = x; }, waitUntil() {} });
    return p;
  };
  const first = await open('http://box/phet/ohms-law.html?yotta=false');
  assert.equal(await first.text(), '<html>sim</html>');
  online = false;
  const again = await open('http://box/phet/ohms-law.html?yotta=false&allowLinks=false');
  assert.equal(again.status, 200, 'сохранённый опыт открывается без сети');
  assert.equal(fetches, 1, 'сохранённый опыт не перекачивается');
  const missing = await open('http://box/phet/density.html');
  assert.equal(missing.status, 503);
  assert.match(await missing.text(), /ещё не сохранён/);
  stores.set('znanie-old', new Map());
  let done;
  handlers.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(stores.has('znanie-phet') && !stores.has('znanie-old'), 'при обновлении сайта старый кэш удаляется, опыты остаются');
});

test('офлайн-кэш: при наличии сети — свежая версия сайта, без сети — сохранённая копия', async () => {
  const code = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  const stores = new Map();
  const cacheOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    const key = (r) => new URL(typeof r === 'string' ? r : r.url, 'http://box/').pathname;
    return { match: async (r) => m.get(key(r))?.clone(), put: async (r, res) => { m.set(key(r), res); }, addAll: async () => {} };
  };
  const handlers = {};
  let version = 'старая';
  let online = true;
  const env = {
    self: { location: { origin: 'http://box' }, addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { open: async (n) => cacheOf(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) },
    fetch: async () => { if (!online) throw new Error('offline'); return new Response(`app ${version}`, { status: 200 }); },
  };
  new Function('self', 'caches', 'fetch', code)(env.self, env.caches, env.fetch);
  const get = async (url) => {
    let p;
    handlers.fetch({ request: { url, method: 'GET', mode: 'cors' }, respondWith: (x) => { p = x; }, waitUntil() {} });
    return (await p).text();
  };
  assert.equal(await get('http://box/js/app.js'), 'app старая');
  version = 'новая';
  assert.equal(await get('http://box/js/app.js'), 'app новая', 'после обновления сразу новая версия');
  online = false;
  assert.equal(await get('http://box/js/app.js?v=2'), 'app новая', 'без сети — последняя сохранённая копия');
});

test('Markdown в ответах нейросети: заголовки, жирный, списки, код, таблицы — и без чужого HTML', async () => {
  const { renderMarkdown, markdownToText } = await import('../web/js/markdown.js');
  const html = renderMarkdown('### План урока\n**Цель:** понять *закон Ома*.\n\n1. Разминка\n2. Опыт\n   - амперметр\n- вывод\n\n`I = U / R`\n\n```\nU = I * R\n```\n| Шаг | Время |\n|---|---|\n| Опыт | 10 мин |\n\n<script>alert(1)</script>');
  assert.match(html, /<h4>План урока<\/h4>/);
  assert.match(html, /<strong>Цель:<\/strong> понять <em>закон Ома<\/em>\./);
  assert.match(html, /<ol><li>Разминка<\/li><li>Опыт<ul><li>амперметр<\/li><\/ul><\/li><\/ol><ul><li>вывод<\/li><\/ul>/);
  assert.match(html, /<code>I = U \/ R<\/code>/);
  assert.match(html, /<pre class="md-code"><code>U = I \* R<\/code><\/pre>/);
  assert.match(html, /<th>Шаг<\/th>/);
  assert.ok(!html.includes('<script>'), 'HTML из ответа модели не выполняется');
  assert.match(renderMarkdown('## Итог'), /<h3>Итог<\/h3>/);
  assert.equal(markdownToText('### Итог\n**Важно**: *да*'), 'Итог\nВажно: да');
});

test('тема библиотеки: главное, термины, формулы и вопросы «Проверь себя» из текста', async () => {
  const { docStructure } = await import('../web/js/doc-structure.js');
  const byDoc = (id) => texts.find((d) => d.id === id);
  const ohm = docStructure(byDoc('p051'));
  assert.deepEqual(ohm.formulas.slice(0, 2), ['I = U / R', 'P = UI']);
  assert.ok(ohm.questions.length >= 3 && ohm.questions.every((q) => q.q && q.a));
  assert.deepEqual(docStructure(byDoc('b015')).terms[0].term, 'Фотосинтез');
  assert.equal(docStructure(byDoc('c016')).terms[0].term, 'Кислород O₂');
  assert.deepEqual(docStructure(byDoc('a032')).formulas.slice(0, 2), ['D = b² − 4ac', 'x = (−b ± √D) / 2a']);
  for (const d of texts) assert.ok(docStructure(d).questions.length >= 2, `${d.id}: есть вопросы для самопроверки`);
});

test('«Своё условие»: текст ученика превращается в изменения узлов схемы', async () => {
  const { parseScenario } = await import('../web/js/ideas.js');
  const aral = byId('aral');
  assert.deepEqual(parseScenario(aral, 'А что, если построили плотину выше по течению?').changes, { dam: 0.6 });
  assert.deepEqual(parseScenario(aral, 'Что, если запретили забор воды на орошение?').changes, { irrigation: -0.6 }, 'одно слово — один фактор');
  assert.deepEqual(parseScenario(aral, 'Что, если резко уменьшить приток рек?').changes, { inflow: -0.9 });
  assert.deepEqual(parseScenario(byId('tselina'), 'Что, если ввели запрет на распашку степи?').changes, { plow: -0.6 });
  assert.deepEqual(parseScenario(aral, 'Что, если в школе сделают ремонт?').changes, {}, 'не про схему — ничего не меняем');
});

test('идея ученика: новый узел на схеме, последствия по цепочке и встроенный разбор Совы', async () => {
  const { withIdeas, ideaEffects, localIdeaFeedback } = await import('../web/js/ideas.js');
  const { relationVerb } = await import('../web/js/graph-view.js');
  const aral = byId('aral');
  const idea = { id: 'idea1', label: 'Капельное орошение', hypothesis: 'Если поливать по капле, воды на поля нужно меньше', links: [{ from: 'idea1', to: 'irrigation', sign: -1 }] };
  const g = withIdeas(aral, [idea]);
  assert.equal(g.nodes.length, aral.nodes.length + 1);
  assert.ok(g.nodes.at(-1).idea && g.edges.at(-1).idea);
  assert.equal(aral.nodes.length, 9, 'эталонная схема не меняется');
  const { effects } = ideaEffects(aral, idea);
  assert.deepEqual(effects.find((e) => e.id === 'level').trend, 'up', 'меньше забора воды → уровень моря растёт');
  const fb = localIdeaFeedback(aral, idea);
  assert.match(fb, /Интересная идея/);
  assert.match(fb, /побочн/);
  assert.match(fb, /\*\*Вопрос:\*\*.*\?$/);
  assert.equal(relationVerb(aral.edges[0]), 'забирает воду и сокращает', 'смысловая связь вместо «−»');
  assert.equal(relationVerb({ sign: 1, strength: 2 }), 'вызывает рост');
  assert.equal(relationVerb({ sign: -1, strength: 2 }), 'приводит к уменьшению');
  for (const gr of graphs) for (const e of gr.edges) assert.ok(e.verb, `${gr.id}: у связи ${e.from}→${e.to} есть понятное слово`);
});

test('прогноз словами: верные догадки, ошибки и упущенные звенья без нейросети', async () => {
  const { checkPredictionText } = await import('../web/js/tutor-local.js');
  const g = byId('aral');
  const r = simulate(g, { irrigation: 0.7 });
  const fb = checkPredictionText('Приток рек уменьшится, солёность упадёт, рыба погибнет', g, r.total, { irrigation: 0.7 }, () => 'цепочка');
  assert.match(fb, /\*\*Верно!\*\*.*«Приток рек в море».*«Рыба в море»/s);
  assert.match(fb, /«Солёность воды» на схеме растёт, а ты думал, что уменьшится/);
  assert.match(fb, /\*\*Ты не упомянул:\*\*.*«Уровень моря»/);
  assert.match(fb, /\*\*Вопрос:\*\*.*\?$/);
  assert.match(checkPredictionText('всё будет плохо', g, r.total, { irrigation: 0.7 }), /не нашла в твоём прогнозе названий факторов/);
});

test('песочница: разбор карты мыслей для ученика и для учителя без нейросети', async () => {
  const { localMapFeedback, mapAsGraph } = await import('../web/js/sandbox.js');
  const map = {
    title: 'Арал', notes: 'Я думаю, что хлопок требует много воды, поэтому реки мелеют. Это видно по карте Амударьи.',
    nodes: [{ id: 'a', label: 'Хлопок' }, { id: 'b', label: 'Забор воды' }, { id: 'c', label: 'Уровень моря' }, { id: 'd', label: 'Туризм' }],
    edges: [{ from: 'a', to: 'b', sign: 1, label: 'провоцирует' }, { from: 'b', to: 'c', sign: -1, label: '' }],
  };
  const student = localMapFeedback(map);
  assert.match(student, /цепочка из 3 звеньев/);
  assert.match(student, /«Туризм» пока ни с чем не связан/);
  assert.match(student, /\*\*Вопрос:\*\* Какой промежуточный фактор может связывать «Хлопок» и «Забор воды»\?/);
  const teacher = localMapFeedback(map, true);
  for (const part of ['**Сильные стороны**', '**Слабые места логики**', '**Что спросить у ученика**', '**Ориентировочная оценка:**']) assert.ok(teacher.includes(part), part);
  const g = mapAsGraph(map);
  assert.equal(g.edges[0].verb, 'провоцирует', 'подпись ученика становится словом связи');
  assert.equal(g.edges[1].verb, 'приводит к уменьшению');
});

test('офлайн-кэш: 95 МБ опытов PhET не скачиваются при установке', () => {
  const sw = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  const files = sw.slice(sw.indexOf('const FILES = ['), sw.indexOf('];', sw.indexOf('const FILES = [')));
  assert.ok(!files.includes('phet/'), 'в списке предзагрузки нет файлов phet/');
  assert.match(sw, /url\.pathname\.includes\('\/phet\/'\)/, 'для phet/ — отдельная обработка: сохраняется при первом открытии');
});
