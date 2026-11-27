// Презентация для конкурса: 10 слайдов → PDF (до 20 МБ), имя «НазваниеКоманды_НазваниеПроекта.pdf».
//
//   node scripts/make_pitch.mjs
//   node scripts/make_pitch.mjs --team "Команда Сова" --members "Искандер — разработка и ИИ; Айгерим — педагогический сценарий"
//
// Слайды собираются в docs/pitch/slides.html (скриншоты — docs/pitch/*.jpg, QR-код — генератор web/js/qr.js),
// затем печатаются в PDF через установленный Microsoft Edge или Google Chrome. Интернет не нужен.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { qrSVG } from '../web/js/qr.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const team = arg('team', '');
const members = arg('members', '').split(';').map((x) => x.trim()).filter(Boolean);
const DEMO = 'https://iskander-code.github.io/znanie-box/';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Цифры — из данных проекта, а не вручную.
const libIndex = JSON.parse(readFileSync(join(root, 'web/data/library/index.json'), 'utf8'));
const topics = libIndex.reduce((s, x) => s + JSON.parse(readFileSync(join(root, `web/data/library/${x.id}.json`), 'utf8')).length, 0);
const labs = JSON.parse(readFileSync(join(root, 'web/data/phet.json'), 'utf8'));
const graphs = JSON.parse(readFileSync(join(root, 'web/data/graphs/index.json'), 'utf8')).length;
const jsTests = (readFileSync(join(root, 'tests/engine.test.mjs'), 'utf8').match(/^test\(/gm) || []).length;
const pyTests = (readFileSync(join(root, 'tests/test_server.py'), 'utf8').match(/^ {4}def test_/gm) || []).length;
const N = { subjects: libIndex.length, topics, labs: labs.length, phet: labs.filter((l) => !l.src).length, own: labs.filter((l) => l.own).length, graphs, tests: jsTests + pyTests };

const qr = qrSVG(DEMO, { size: 190, margin: 2, label: 'QR-код демо-сайта' });
const teamName = team || '[Название команды]';
const memberList = members.length ? members : ['[Имя — роль: что сделал в проекте]', '[Имя — роль: что сделал в проекте]'];

const slide = (n, title, body, extra = '') => `<section class="slide ${extra}">
  <header><span class="logo">▣</span><span class="proj">Знание в коробке</span><span class="num">${n} / 10</span></header>
  ${title ? `<h2>${title}</h2>` : ''}${body}</section>`;

const slides = [
  `<section class="slide title">
    <div class="t-left">
      <div class="big-logo">▣</div>
      <h1>Знание в коробке</h1>
      <p class="sub">ИИ-наставник и тренажёр мышления для сельской школы — <b>без интернета</b></p>
      <p class="team">Команда: <b>${esc(teamName)}</b></p>
    </div>
    <div class="t-right">${qr}<p>Демо: iskander-code.github.io/znanie-box</p></div>
  </section>`,

  slide(2, 'Проблема и её актуальность', `<div class="cols3">
    <div class="card"><div class="ic">📶</div><h3>Нет связи — нет ИИ</h3><p>Почти все ИИ-сервисы для учёбы работают через облако. В сельских школах интернет слабый или его нет — эти инструменты там недоступны.</p></div>
    <div class="card"><div class="ic">📋</div><h3>Готовый ответ вместо мышления</h3><p>Там, где ИИ доступен, ученик часто получает готовый ответ и просто переписывает его.</p></div>
    <div class="card"><div class="ic">🔗</div><h3>Факты без связей</h3><p>Учебник даёт факты, но почти не тренирует главное умение — понимать причины и последствия.</p></div>
  </div><p class="banner">Цифровое неравенство: городской ученик получает ИИ-наставника, сельский — нет.</p>`),

  slide(3, 'Целевая аудитория', `<div class="cols3">
    <div class="card"><div class="ic">🎒</div><h3>Ученики 5–11 классов сельских школ</h3><p>Учатся с телефона или школьного ноутбука; интернета мало или нет. Нужна помощь, которая учит думать, а не решает за них.</p></div>
    <div class="card"><div class="ic">👩‍🏫</div><h3>Учителя-предметники</h3><p>Хотят видеть, какие темы трудные, проверять работы учеников и быть уверенными, что ИИ не выдаст готовые ответы на контрольной.</p></div>
    <div class="card"><div class="ic">🏫</div><h3>Директора школ и муниципалитеты</h3><p>Заказчики оснащения: нужна недорогая система без подписок, которая работает на уже имеющемся ноутбуке.</p></div>
  </div>`),

  slide(4, 'Суть решения', `<div class="flow">
      <div class="step">💻<b>Ноутбук учителя</b><span>«Коробка»: нажать «Запустить для класса»</span></div><div class="arr">➜</div>
      <div class="step">📡<b>Раздача сети</b><span>«Мобильный хот-спот», интернет не нужен</span></div><div class="arr">➜</div>
      <div class="step">📱<b>Телефоны учеников</b><span>Сканируют QR-код — сайт открывается</span></div>
    </div>
    <div class="cols3 inside">
      <div class="pill">📚 <b>${N.topics}</b> тем по <b>${N.subjects}</b> предметам</div>
      <div class="pill">🦉 ИИ-наставник «Сова»</div>
      <div class="pill">🔀 Тренажёр «Что будет, если…»</div>
      <div class="pill">🧠 «Песочница» для своих карт мыслей</div>
      <div class="pill">🧪 <b>${N.labs}</b> интерактивных лабораторий</div>
      <div class="pill">👩‍🏫 Кабинет учителя по PIN</div>
    </div>
    <p class="banner">Всё работает внутри коробки — вопросы учеников не уходят в интернет.</p>`),

  slide(5, 'Как это работает для ученика', `<div class="shots">
    <figure><img src="sova.jpg" alt=""><figcaption><b>Сова</b> — метод Сократа: наводящий вопрос и источник; готовый ответ только по кнопке</figcaption></figure>
    <figure><img src="explore.jpg" alt=""><figcaption><b>«Что будет, если…»</b> — меняю условие, пишу прогноз словами, запускаю схему</figcaption></figure>
    <figure><img src="sandbox.jpg" alt=""><figcaption><b>«Песочница»</b> — своя карта мыслей и заметки, работа уходит учителю</figcaption></figure>
  </div>`),

  slide(6, 'Роль ИИ в решении', `<div class="two">
    <div>
      <div class="card stage"><span class="badge">1</span><h3>Подготовка знаний: учитель + ИИ</h3><p>Нейросеть строит схему причин и следствий из параграфа. Код проверяет каждую связь по цитате из текста. Учитель одобряет — только тогда схема у учеников.</p></div>
      <div class="card stage"><span class="badge">2</span><h3>Работа в классе — без интернета</h3><p>Локальная нейросеть на ноутбуке: подсказки по методу Сократа, проверка прогноза словами, советы по карте мыслей, разбор работ для учителя.</p></div>
      <p class="note"><b>Где не ИИ:</b> последствия в симуляции считает прозрачный алгоритм — мгновенно, одинаково, проверяемо. <b>Защита от ошибок:</b> ответы с цитатами из библиотеки, проверка цитат, последнее слово за учителем, режим контрольной без готовых ответов.</p>
    </div>
    <figure><img src="domino.jpg" alt=""><figcaption>«Цепочка домино»: что изменится сразу, через годы, через десятилетия</figcaption></figure>
  </div>`),

  slide(7, 'Технологии и инструменты', `<div class="two">
    <div class="card"><h3>В продукте</h3><ul>
      <li><b>Qwen</b> (qwen3.5:4b, qwen2.5:3b) через <b>Ollama</b> — нейросеть на ноутбуке, без интернета</li>
      <li><b>Claude, GPT, Gemini</b> — по желанию учителя, когда есть интернет</li>
      <li><b>Python</b> (только стандартная библиотека) и <b>SQLite</b>: поиск BM25, кэш ответов, работы учеников</li>
      <li><b>JavaScript</b> без сборки, офлайн-PWA (Service Worker), своя отрисовка схем в SVG</li>
      <li><b>PhET</b> (University of Colorado Boulder, CC BY 4.0) — ${N.phet} симуляций + ${N.own} собственных</li>
      <li><b>GitHub Pages</b> и <b>GitHub Actions</b> — демо-сайт и автотесты</li></ul></div>
    <div class="card accent"><h3>Генеративный ИИ при разработке</h3><ul>
      <li><b>Claude Code</b> (модель Claude Opus 5.5, Anthropic) — код сервера и сайта, ${N.tests} автотестов, тексты ${N.topics} тем библиотеки, задания к лабораториям, документация</li>
      <li>Команда ставила задачи и принимала решения; каждое изменение проверено автотестами и вручную в браузере</li>
      <li>Тексты библиотеки, подготовленные с помощью ИИ, перед уроками проверяет учитель-предметник</li></ul></div>
  </div>`),

  slide(8, 'Текущая стадия готовности', `<p class="stage-badge">Стадия: <b>MVP</b> — работает, публичное демо, открытый код</p>
    <div class="stats">
      <div><b>${N.topics}</b><span>тем по ${N.subjects} предметам</span></div>
      <div><b>${N.labs}</b><span>лабораторий</span></div>
      <div><b>${N.graphs}</b><span>проверенных схем</span></div>
      <div><b>${N.tests}</b><span>автотестов перед каждой публикацией</span></div>
    </div>
    <div class="stats small">
      <div><b>0,2–0,9 с</b><span>до первого слова ИИ (ноутбук с видеокартой)</span></div>
      <div><b>≈3 с</b><span>до первого слова на обычном процессоре</span></div>
      <div><b>169 КБ</b><span>загрузка сайта на телефон</span></div>
    </div>
    <p class="banner">Следующий шаг — пилот в 2–3 сельских школах.</p>`),

  slide(9, 'Для всех детей и безопасно', `<div class="cols3">
    <div class="card"><div class="ic">♿</div><h3>Доступность</h3><p>Режим для особых потребностей: крупный шрифт, высокий контраст, цвета для дальтоников (Okabe-Ito), озвучка, без анимаций. Экраны от 320 px.</p></div>
    <div class="card"><div class="ic">🔒</div><h3>Приватность</h3><p>Вопросы не покидают коробку, аккаунтов нет, статистика для учителя обезличена.</p></div>
    <div class="card"><div class="ic">🛡</div><h3>Честная учёба</h3><p>Вход учителя по PIN; режим контрольной без готовых ответов проверяет сервер, а не браузер.</p></div>
  </div><p class="banner">Дальше: пилот → казахский язык → готовая коробка на мини-компьютере → учебники программы Казахстана.</p>`),

  slide(10, 'Состав команды и роли', `<div class="team-grid">
    <div class="card"><h3>Команда «${esc(teamName)}»</h3><ul class="members">${memberList.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      <p class="note">Мы ищем школы для пилота и учителей, которые помогут сделать Сову полезнее.</p></div>
    <div class="qr-box">${qr}<p><b>Попробуйте сейчас</b><br>iskander-code.github.io/znanie-box</p></div>
  </div><p class="thanks">Спасибо!</p>`),
];

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Знание в коробке — презентация</title><style>
  @page { size: 13.333in 7.5in; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; color: #0F172A; }
  .slide { width: 13.333in; height: 7.5in; padding: 0.45in 0.6in; page-break-after: always; break-after: page; position: relative; overflow: hidden; background: #F8FAFC; display: flex; flex-direction: column; gap: 0.18in; }
  .slide:last-child { page-break-after: auto; }
  header { display: flex; align-items: center; gap: 10px; color: #64748B; font-size: 15px; }
  header .logo { color: #1f6f5c; font-size: 20px; } header .num { margin-left: auto; }
  h2 { margin: 0; font-size: 40px; color: #1f6f5c; }
  h3 { margin: 0 0 8px; font-size: 22px; }
  p, li { font-size: 18px; line-height: 1.45; }
  .cols3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25in; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3in; align-items: start; }
  .card { background: #fff; border: 2px solid #E2E8F0; border-radius: 18px; padding: 20px 22px; }
  .card.accent { border-color: #1f6f5c; background: #F0FDF8; }
  .card ul { margin: 0; padding-left: 1.1em; } .card li { margin-bottom: 8px; font-size: 17px; }
  .ic { font-size: 40px; margin-bottom: 6px; }
  .banner { margin: auto 0 0; background: #1f6f5c; color: #fff; border-radius: 14px; padding: 14px 22px; font-size: 21px; font-weight: 600; }
  .note { font-size: 16px; color: #334155; background: #FFF7ED; border-left: 5px solid #E69F00; padding: 10px 14px; border-radius: 8px; }
  .title { flex-direction: row; align-items: center; background: linear-gradient(135deg, #0F172A 0%, #1f6f5c 100%); color: #fff; }
  .t-left { flex: 1; } .big-logo { font-size: 80px; color: #6EE7B7; line-height: 1; }
  .title h1 { font-size: 72px; margin: 10px 0; } .title .sub { font-size: 28px; max-width: 8in; } .title .team { font-size: 24px; margin-top: 40px; }
  .t-right { background: #fff; color: #0F172A; border-radius: 20px; padding: 18px; text-align: center; } .t-right p { margin: 6px 0 0; font-size: 15px; }
  .flow { display: flex; align-items: stretch; gap: 14px; }
  .flow .step { flex: 1; background: #fff; border: 2px solid #E2E8F0; border-radius: 18px; padding: 16px; display: flex; flex-direction: column; gap: 6px; font-size: 34px; text-align: center; }
  .flow .step b { font-size: 22px; } .flow .step span { font-size: 16px; color: #475569; }
  .flow .arr { align-self: center; font-size: 34px; color: #1f6f5c; }
  .inside { grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .pill { background: #E6F4EF; border-radius: 999px; padding: 10px 18px; font-size: 19px; }
  .shots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.2in; }
  figure { margin: 0; } figure img { width: 100%; border-radius: 12px; border: 2px solid #E2E8F0; display: block; }
  figcaption { font-size: 16px; margin-top: 8px; color: #334155; line-height: 1.4; }
  .stage { position: relative; padding-left: 64px; margin-bottom: 12px; } .stage p { font-size: 16px; margin: 0; }
  .badge { position: absolute; left: 18px; top: 18px; width: 34px; height: 34px; border-radius: 50%; background: #1f6f5c; color: #fff; display: grid; place-items: center; font-weight: 700; }
  .stage-badge { font-size: 26px; margin: 0; } .stage-badge b { color: #fff; background: #009E73; padding: 2px 14px; border-radius: 10px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.2in; }
  .stats.small { grid-template-columns: repeat(3, 1fr); }
  .stats div { background: #fff; border: 2px solid #E2E8F0; border-radius: 18px; padding: 16px; text-align: center; }
  .stats b { display: block; font-size: 52px; color: #1f6f5c; } .stats.small b { font-size: 36px; color: #0072B2; }
  .stats span { font-size: 16px; color: #475569; }
  .team-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 0.3in; align-items: center; }
  .members li { font-size: 22px; margin-bottom: 12px; }
  .qr-box { text-align: center; background: #fff; border: 2px solid #E2E8F0; border-radius: 18px; padding: 16px; } .qr-box p { font-size: 16px; margin: 8px 0 0; }
  .thanks { margin: auto 0 0; font-size: 34px; font-weight: 700; color: #1f6f5c; }
</style></head><body>${slides.join('\n')}</body></html>`;

const outDir = join(root, 'docs/pitch');
const htmlPath = join(outDir, 'slides.html');
writeFileSync(htmlPath, html, 'utf8');
for (const img of ['sova.jpg', 'explore.jpg', 'sandbox.jpg', 'domino.jpg']) if (!existsSync(join(outDir, img))) console.warn(`Нет скриншота docs/pitch/${img}`);

const safe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '');
const pdfName = `${team ? safe(team) : 'Komanda'}_ZnanieVKorobke.pdf`;
const pdfPath = join(root, pdfName);
const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p) => existsSync(p));
if (!browsers.length) { console.log(`Слайды: ${htmlPath}. Браузер для печати не найден — откройте файл и сохраните как PDF.`); process.exit(0); }
execFileSync(browsers[0], ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], { stdio: 'ignore' });
const mb = statSync(pdfPath).size / 1048576;
console.log(`Готово: ${pdfName} — ${mb.toFixed(2)} МБ (лимит конкурса 20 МБ)${mb > 20 ? ' — ПРЕВЫШЕН!' : ''}`);
console.log(`Цифры: ${N.subjects} предметов, ${N.topics} тем, ${N.labs} лабораторий, ${N.graphs} схем, ${N.tests} тестов`);
