// Лёгкий Markdown → HTML для ответов нейросети. Без библиотек и без интернета.
// Безопасно: весь текст сначала экранируется, поэтому HTML из ответа модели не выполняется.
// Поддерживает: заголовки #…####, **жирный**, *курсив*, `код`, блоки ```кода```, списки (- * + и 1.),
// вложенные списки, цитаты >, таблицы | a | b |, горизонтальную черту --- и абзацы.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Строчное оформление: код, жирный, курсив. Вход уже экранирован. */
function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\wа-яё])_([^_\s][^_\n]*?)_(?![\wа-яё])/gi, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

function renderList(lines, start) {
  // Собираем подряд идущие пункты списка (с вложенными по отступу).
  const items = [];
  let i = start;
  const baseIndent = lines[start].match(LIST_RE)[1].length;
  const ordered = /\d/.test(lines[start].match(LIST_RE)[2]);
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
      items.push({ text: m[3], children: [] });
      i++;
    } else if (m && m[1].length > baseIndent && items.length) {
      const sub = renderList(lines, i);
      items[items.length - 1].children.push(sub.html);
      i = sub.next;
    } else if (!m && lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
      items[items.length - 1].text += ` ${lines[i].trim()}`; // продолжение пункта на новой строке
      i++;
    } else {
      break;
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered ? Number(lines[start].match(LIST_RE)[2].replace(/\D/g, '')) : 1;
  const html = `<${tag}${ordered && startAttr !== 1 ? ` start="${startAttr}"` : ''}>${items.map((it) => `<li>${inline(it.text)}${it.children.join('')}</li>`).join('')}</${tag}>`;
  return { html, next: i };
}

function renderTable(lines, start) {
  const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = row(lines[start]);
  let i = start + 2; // строка заголовка и разделитель |---|
  const body = [];
  while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
  const html = `<div class="table-wrap"><table class="table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
    + `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return { html, next: i };
}

/** Markdown → безопасный HTML. */
export function renderMarkdown(md) {
  const lines = esc(String(md || '').replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // закрывающие ``` (если модель их не дописала — блок закончится в конце текста)
      out.push(`<pre class="md-code"><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flush();
      // # и ## → h3, ### → h4, остальное → h5: внутри сообщения крупные заголовки не нужны.
      const level = Math.min(5, Math.max(3, h[1].length + (h[1].length <= 2 ? 3 - h[1].length : 1)));
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (LIST_RE.test(line)) { flush(); const r = renderList(lines, i); out.push(r.html); i = r.next; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush(); const r = renderTable(lines, i); out.push(r.html); i = r.next; continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('');
}

/** Markdown → простой текст (для озвучки и копирования): без символов разметки. */
export function markdownToText(md) {
  return String(md || '')
    .replace(/```[\w-]*\n?/g, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .trim();
}
