// Генератор QR-кода без интернета и без библиотек (ISO/IEC 18004).
// Байтовый режим, уровень коррекции M, версии 1–10 — хватает для адреса до 213 байт.

// [всего кодовых слов, слов коррекции в блоке, [[блоков, слов данных в блоке], ...]]
const VERSIONS = [null,
  [26, 10, [[1, 16]]], [44, 16, [[1, 28]]], [70, 26, [[1, 44]]], [100, 18, [[2, 32]]], [134, 24, [[2, 43]]],
  [172, 16, [[4, 27]]], [196, 18, [[4, 31]]], [242, 22, [[2, 38], [2, 39]]], [292, 22, [[3, 36], [2, 37]]], [346, 26, [[4, 43], [1, 44]]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// Поле Галуа GF(256) с образующим многочленом x^8+x^4+x^3+x^2+1
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    g = next;
  }
  return g;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], f);
  }
  return rem;
}

function encodeData(bytes, version) {
  const [total, ecLen, groups] = VERSIONS[version];
  const dataLen = groups.reduce((s, [n, k]) => s + n * k, 0);
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);
  // Разбиваем на блоки, считаем коррекцию, перемежаем.
  const blocks = [];
  let pos = 0;
  for (const [n, k] of groups) for (let i = 0; i < n; i++) { const d = data.slice(pos, pos += k); blocks.push({ d, e: rsRemainder(d, ecLen) }); }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  if (out.length !== total) throw new Error('QR: ошибка в таблице версий');
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(codewords, version, mask) {
  const n = version * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  // Поисковые узоры с разделителями
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  // Синхронизирующие полосы
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Выравнивающие узоры
  const al = ALIGN[version];
  for (const ay of al) for (const ax of al) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === n - 7) || (ax === n - 7 && ay === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Информация о формате (уровень M = 00)
  const fdata = (0b00 << 3) | mask;
  let rem = fdata;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const fbits = ((fdata << 10) | rem) ^ 0x5412;
  const fb = (i) => ((fbits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, fb(i));
  set(8, 7, fb(6)); set(8, 8, fb(7)); set(7, 8, fb(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, fb(i));
  for (let i = 0; i < 8; i++) set(n - 1 - i, 8, fb(i));
  for (let i = 8; i < 15; i++) set(8, n - 15 + i, fb(i));
  set(8, n - 8, true); // тёмный модуль
  // Информация о версии (с 7-й)
  if (version >= 7) {
    let r = version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const vbits = (version << 12) | r;
    for (let i = 0; i < 18; i++) {
      const bit = ((vbits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
  // Данные змейкой снизу справа
  let i = 0;
  const total = codewords.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (fn[y][x]) continue;
        let dark = false;
        if (i < total) { dark = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
        m[y][x] = dark !== MASKS[mask](x, y);
      }
    }
  }
  return m;
}

function penalty(m) {
  const n = m.length;
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b <= n; b++) {
        if (b < n && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      for (let b = 0; b + 10 < n; b++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  line((a, b) => m[a][b]);
  line((a, b) => m[b][a]);
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++;
    if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  return p + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
}

/** Матрица QR-кода: массив строк из true (тёмный) / false. mask — номер маски 0–7 или автоматически. */
export function qrMatrix(text, mask) {
  const bytes = [...new TextEncoder().encode(text)];
  const version = VERSIONS.findIndex((v) => v && v[2].reduce((s, [n, k]) => s + n * k, 0) >= bytes.length + (v === VERSIONS[10] ? 3 : 2));
  if (version < 1) throw new Error('Адрес слишком длинный для QR-кода');
  const cw = encodeData(bytes, version);
  if (mask !== undefined) return build(cw, version, mask);
  let best = null;
  for (let k = 0; k < 8; k++) {
    const mtx = build(cw, version, k);
    const p = penalty(mtx);
    if (!best || p < best.p) best = { p, mtx };
  }
  return best.mtx;
}

/** SVG-картинка QR-кода (тёмные модули на белом фоне — так его читает любая камера). */
export function qrSVG(text, { size = 220, margin = 4, label = 'QR-код' } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  let d = '';
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + margin} ${y + margin}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
