// «Что будет, если…»: прогноз словами, цепочка домино под схемой и широкая карточка
// «Разбор результатов с Совой» с быстрыми вопросами и диалогом. Здесь же общий запрос к ИИ
// по контексту (askContext), которым пользуется и «Песочница».
import { pathTo, findLoops, checkPredictions, trend, DEFAULT_DELAY_LABELS } from './engine.js';
import { relationVerb } from './graph-view.js';
import { checkPredictionText } from './tutor-local.js';
import { PREDICT_CHECK_PROMPT, DEBRIEF_CHAT_PROMPT } from './llm-browser.js';

const ARROW = { up: '▲', down: '▼', same: '=' };
const TREND_WORD = { up: 'вырастет', down: 'уменьшится', same: 'не изменится' };
const TREND_PAST = { up: 'вырос', down: 'уменьшился', same: 'не изменился' };

let ctx = null;
/** Связь с приложением: состояние, отрисовка и способы спросить нейросеть (их даёт app.js). */
export function initSimulationUI(context) { ctx = context; }

const esc = (s) => ctx.esc(s);
const label = (g, id) => g.nodes.find((n) => n.id === id)?.label || id;

/**
 * Общий запрос к ИИ по контексту с выводом по мере печати в контейнер boxId.
 * Коробка (/api/chat, кэш на сервере) → нейросеть без коробки (кэш в браузере) → встроенный разбор local().
 * Обрыв сети или ошибка нейросети не вешают интерфейс: сразу отвечает встроенный разбор.
 */
export async function askContext({ mode, context, message = '', history = [], system, boxId, url = 'api/chat', headers = {}, local, maxTokens = 500 }) {
  const onDelta = ctx.liveBubble(boxId);
  if (ctx.S.server?.llm) {
    try {
      const r = await ctx.chatServer({ mode, context, message, history }, onDelta, url, headers);
      if (r.answer) return { text: r.answer, by: `Сова · нейросеть ${r.model || ''}${r.cached ? ' · из кэша' : ''}`.trim() };
    } catch { /* коробка или нейросеть недоступна — ниже встроенный разбор */ }
  } else if (ctx.browserAI()) {
    try {
      const user = JSON.stringify(context) + (message ? `\n\nВопрос: ${message}` : '');
      const text = await ctx.cachedBrowserAsk([{ role: 'system', content: system }, ...history, { role: 'user', content: user }], onDelta, maxTokens);
      if (text) return { text, by: `Сова · нейросеть ${ctx.browserAI()}` };
    } catch { /* нет связи — встроенный разбор */ }
  }
  return { text: local(), by: 'Сова · встроенный разбор' };
}

// ---------- текст цепочек и встроенный разбор ----------
export function chainText(g, r, path) {
  return path.map((e) => `«${label(g, e.from)}» ${ARROW[trend(r.total[e.from])]} ${relationVerb(e)} «${label(g, e.to)}» ${ARROW[trend(r.total[e.to])]} — «${e.evidence}»`).join(';\n');
}

export function localDebrief(g, r, checks, changes) {
  const lines = [];
  const wrong = checks.filter((c) => !c.correct);
  if (checks.length) {
    lines.push(wrong.length ? `Ты угадал ${checks.length - wrong.length} из ${checks.length}. Разберём, где схема повела себя иначе.` : 'Все прогнозы верны — отличное рассуждение!');
    for (const c of wrong.slice(0, 2)) {
      const p = pathTo(r, c.node);
      lines.push(p.length ? `«${label(g, c.node)}» ${TREND_PAST[c.actual]}: ${chainText(g, r, p)}.` : `«${label(g, c.node)}» не изменился: изменение до него не дошло.`);
    }
  } else {
    const top = Object.keys(r.total).filter((id) => !(id in changes)).sort((a, b) => Math.abs(r.total[b]) - Math.abs(r.total[a]))[0];
    if (top) lines.push(`Сильнее всего изменился фактор «${label(g, top)}». Цепочка: ${chainText(g, r, pathTo(r, top))}.`);
    lines.push('В следующий раз сначала сделай прогноз — так ты лучше проверишь своё понимание.');
  }
  const loops = findLoops(g).filter((l) => l.nodes.some((n) => n in r.total));
  if (loops.length) lines.push(`Заметь петлю: ${loops[0].nodes.map((n) => label(g, n)).join(' → ')} → ${label(g, loops[0].nodes[0])}. Она ${loops[0].type === 'reinforcing' ? 'усиливает' : 'гасит'} начальное изменение.`);
  lines.push('Помни: схема — упрощённая модель. Если не согласен со связью, нажми на стрелку и проверь цитату.');
  return lines.join('\n\n');
}

/** Всё, что нужно нейросети, чтобы сравнить прогноз с результатом. */
export function resultContext(g, x) {
  const r = x.result;
  return {
    схема: g.title,
    ученик_изменил: Object.entries(x.changes).map(([id, v]) => `${v > 0 ? '▲' : '▼'} ${label(g, id)}`),
    прогноз_словами: x.textPrediction || '(ученик не писал прогноз словами)',
    отметки_на_узлах: checkPredictions(r, x.predictions).map((c) => ({ фактор: label(g, c.node), думал: TREND_WORD[c.guess], на_схеме: TREND_PAST[c.actual] })),
    результаты: Object.keys(r.total).filter((id) => !(id in x.changes) && trend(r.total[id]) !== 'same')
      .sort((a, b) => Math.abs(r.total[b]) - Math.abs(r.total[a])).slice(0, 10)
      .map((id) => ({ фактор: label(g, id), итог: TREND_PAST[trend(r.total[id])], цепочка: chainText(g, r, pathTo(r, id)) })),
  };
}

// ---------- поле «Мой прогноз словами» ----------
export function predictionFieldHTML(x) {
  return `<label class="text-predict"><span>✍ Мой прогноз словами</span>
    <textarea data-action-input="text-prediction" rows="3" maxlength="800" placeholder="Опиши своими словами, что изменится в цепочке и почему… Например: Из-за нагрева воды водоросли погибнут, и рыбам станет нечего есть">${esc(x.textPrediction || '')}</textarea></label>`;
}

// ---------- цепочка домино под схемой ----------
export function timelineHTML(g, x) {
  if (x.phase !== 'done' || !x.result) return '';
  const r = x.result;
  const delays = g.delayLabels || DEFAULT_DELAY_LABELS;
  const affected = Object.keys(r.total).filter((id) => !(id in x.changes) && trend(r.total[id]) !== 'same');
  const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
  const stepName = (i) => (i === 0 ? 'Сразу' : i === delays.length - 1 && delays.length > 2 ? 'Долгосрочный эффект' : cap(delays[i]));
  return `<div class="step timeline-card"><h3>🁢 Цепочка домино</h3><ol class="domino">${delays.map((name, i) => {
    const items = affected.filter((id) => (r.when[id] ?? 0) === i).sort((a, b) => Math.abs(r.total[b]) - Math.abs(r.total[a]));
    return `<li class="dcol"><span class="tlabel">Шаг ${i + 1} · ${esc(stepName(i))}${i && stepName(i) !== cap(name) ? ` <span class="muted">(${esc(name)})</span>` : ''}</span>${items.map((id) => {
      const via = r.via[id];
      return `<button class="titem ${trend(r.total[id])}" data-action="why" data-id="${esc(id)}">${ARROW[trend(r.total[id])]} ${esc(label(g, id))}${via ? `<span class="tvia">из-за: «${esc(label(g, via.from))}» ${ARROW[trend(r.total[via.from] || x.changes[via.from] || 0)]}</span>` : ''}</button>`;
    }).join('') || '<span class="muted small">—</span>'}</li>`;
  }).join('')}</ol><p class="muted small">Нажми на последствие или на узел схемы, чтобы увидеть цепочку «почему» и цитаты.</p></div>`;
}

// ---------- карточка «Разбор результатов с Совой» во всю ширину под схемой ----------
function quickQuestions(g, x) {
  const r = x.result;
  const top = Object.keys(r.total).filter((id) => !(id in x.changes) && trend(r.total[id]) !== 'same').sort((a, b) => Math.abs(r.total[b]) - Math.abs(r.total[a]))[0];
  return [
    'Разбери мой результат подробно',
    top && `Почему «${label(g, top)}» ${TREND_PAST[trend(r.total[top])]}?`,
    'Что будет через много лет?',
    'Как можно остановить это изменение?',
    'Какое звено цепочки самое важное?',
  ].filter(Boolean);
}

export function debriefCardHTML(g, x) {
  if (x.phase !== 'done' || !x.result) {
    return `<h2>🦉 Разбор результатов с Совой</h2>
      <p class="muted">Измени условие, отметь прогноз на узлах или напиши его словами и нажми «Запустить и проверить прогноз» — здесь Сова сравнит твой прогноз с тем, что произошло, и ответит на вопросы.</p>`;
  }
  const checks = checkPredictions(x.result, x.predictions);
  const t = (x.talk ||= []);
  return `<h2>🦉 Разбор результатов с Совой</h2>
    <div class="debrief-grid">
      <div>
        ${checks.length ? `<h3>Отметки на узлах: ${checks.filter((c) => c.correct).length} из ${checks.length}</h3><ul class="checks">${checks.map((c) => `<li class="${c.correct ? 'ok' : 'bad'}">${c.correct ? '✓' : '✗'} ${esc(label(g, c.node))}: ты думал «${TREND_WORD[c.guess]}», на схеме — ${TREND_PAST[c.actual]}</li>`).join('')}</ul>` : ''}
        ${x.textPrediction ? `<h3>Твой прогноз словами</h3><blockquote>${esc(x.textPrediction)}</blockquote>` : ''}
        <div class="md local-debrief">${ctx.renderMarkdown(localDebrief(g, x.result, checks, x.changes))}</div>
        ${g.questions?.length ? `<p class="question"><strong>Подумай:</strong> ${esc(g.questions[0])}</p>` : ''}
      </div>
      <div class="debrief-chat">
        <div class="messages" id="debrief-messages" aria-live="polite">
          ${t.map((m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? `<div class="md">${ctx.renderMarkdown(m.text)}</div>` : esc(m.text)}${m.by ? `<span class="by">${esc(m.by)}</span>` : ''}</div>`).join('')}
          ${x.talkBusy ? '<div class="msg assistant typing">Сова думает…</div>' : ''}
        </div>
        <div class="row quick-q">${quickQuestions(g, x).map((q) => `<button type="button" class="chip" data-action="debrief-q" data-q="${esc(q)}" ${x.talkBusy ? 'disabled' : ''}>${esc(q)}</button>`).join('')}</div>
        <form class="composer" data-form="debrief-q"><input name="q" maxlength="400" autocomplete="off" placeholder="Спроси Сову о результате…" aria-label="Вопрос Сове о результате"><button class="btn primary" ${x.talkBusy ? 'disabled' : ''}>Спросить</button></form>
      </div>
    </div>`;
}

/** Ответ на вопрос о результате без нейросети: цепочка для названного фактора или общий разбор. */
function localAnswer(g, x, question) {
  const q = question.toLowerCase().replace(/ё/g, 'е');
  if (/подробно|разбер|прогноз/.test(q) && x.textPrediction) {
    return checkPredictionText(x.textPrediction, g, x.result.total, x.changes, (id) => chainText(g, x.result, pathTo(x.result, id)));
  }
  const node = g.nodes.find((n) => n.label.toLowerCase().replace(/ё/g, 'е').split(/\s+/).some((w) => w.length > 3 && q.includes(w.slice(0, Math.max(4, w.length - 2)))));
  if (node) {
    const p = pathTo(x.result, node.id);
    if (p.length) return `«${node.label}» ${TREND_PAST[trend(x.result.total[node.id])]}. Цепочка:\n\n${p.map((e, i) => `${i + 1}. ${chainText(g, x.result, [e])}`).join('\n')}\n\n**Вопрос:** какое звено этой цепочки можно изменить, чтобы результат стал другим?`;
    return `«${node.label}» в этом запуске не изменился: изменение до него не дошло. **Вопрос:** какое условие нужно поменять, чтобы он изменился?`;
  }
  if (/лет|будущ|долго/.test(q)) {
    const late = Object.keys(x.result.total).filter((id) => (x.result.when[id] ?? 0) >= 1 && trend(x.result.total[id]) !== 'same');
    return late.length ? `Через годы проявятся: ${late.map((id) => `${ARROW[trend(x.result.total[id])]} «${label(g, id)}»`).join(', ')}. Посмотри «Цепочку домино» — там видно, что меняется сразу, а что позже.\n\n**Вопрос:** что из этого труднее всего будет исправить?` : 'В этой схеме все последствия наступают сразу. **Вопрос:** какие долгие последствия могли бы быть в жизни?';
  }
  if (/останов|исправ|помеш/.test(q)) {
    const adj = g.nodes.filter((n) => n.adjustable && !(n.id in x.changes));
    return `Остановить цепочку можно, если изменить другой фактор, который на неё влияет${adj.length ? `, например ${adj.map((n) => `«${n.label}»`).join(', ')}` : ''}. Попробуй запустить схему ещё раз с таким условием.\n\n**Вопрос:** какое звено цепочки ты бы «разорвал» и почему?`;
  }
  return localDebrief(g, x.result, checkPredictions(x.result, x.predictions), x.changes);
}

/** Вопрос Сове о результате (быстрая кнопка или своё поле). */
export async function askDebrief(g, x, question, redraw) {
  if (!question.trim() || x.talkBusy) return;
  const history = (x.talk ||= []).slice(-6).map((m) => ({ role: m.role, content: m.text }));
  x.talk.push({ role: 'user', text: question });
  x.talkBusy = true;
  redraw();
  const detailed = /подробно|разбер/.test(question.toLowerCase());
  const reply = await askContext({
    mode: detailed ? 'predict_check' : 'debrief_chat',
    system: detailed ? PREDICT_CHECK_PROMPT : DEBRIEF_CHAT_PROMPT,
    context: resultContext(g, x), message: detailed ? '' : question, history, boxId: 'debrief-messages',
    local: () => localAnswer(g, x, question),
  });
  if (ctx.S.ex !== x) return;
  x.talk.push({ role: 'assistant', text: reply.text, by: reply.by });
  x.talkBusy = false;
  redraw();
}

/** После анимации: если ученик написал прогноз словами — Сова сразу его проверяет. */
export async function afterRun(g, x, redraw) {
  x.talk = [];
  if (!x.textPrediction?.trim()) return;
  x.talkBusy = true;
  redraw();
  const reply = await askContext({
    mode: 'predict_check', system: PREDICT_CHECK_PROMPT, context: resultContext(g, x), boxId: 'debrief-messages',
    local: () => checkPredictionText(x.textPrediction, g, x.result.total, x.changes, (id) => chainText(g, x.result, pathTo(x.result, id))),
  });
  if (ctx.S.ex !== x) return;
  x.talk.push({ role: 'assistant', text: `**Проверка твоего прогноза.**\n\n${reply.text}`, by: reply.by });
  x.talkBusy = false;
  redraw();
}
