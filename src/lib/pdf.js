'use strict';
/**
 * Kleiner PDF-Erzeuger ohne zusätzliche Abhängigkeit.
 *
 * Erzeugt echte PDF-1.4-Dateien mit den Standardschriften Helvetica und
 * Helvetica-Bold in WinAnsiEncoding – damit sind Umlaute und das Eurozeichen
 * darstellbar. Unterstützt werden Text, Linien, Rechtecke und ein
 * Seitenumbruch. Für Rechnungen, Lieferscheine und Etiketten reicht das aus;
 * Bilder und eingebettete Schriften sind bewusst nicht enthalten.
 */

const A4 = { width: 595.28, height: 841.89 };

/** WinAnsi (CP1252) – nur die Abweichungen zu Latin-1 im Bereich 0x80–0x9F. */
const WINANSI = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
  [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
  [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
  [0x017E, 0x9E], [0x0178, 0x9F]
]);

function toWinAnsi(text) {
  const bytes = [];
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (WINANSI.has(code)) bytes.push(WINANSI.get(code));
    else if (code <= 0xFF) bytes.push(code);
    else bytes.push(0x3F); // '?'
  }
  return Buffer.from(bytes);
}

function escapePdf(buffer) {
  const out = [];
  for (const byte of buffer) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5C) out.push(0x5C);
    out.push(byte);
  }
  return Buffer.from(out);
}

/** Zeichenbreiten der Standardschriften (1/1000 em) für Umbruch und Rechtsbündigkeit. */
const WIDTHS_REGULAR = { ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333, '{': 334, '|': 260, '}': 334, '~': 584 };
const DIGIT_W = 556;

function charWidth(char, bold) {
  const code = char.codePointAt(0);
  if (char >= '0' && char <= '9') return DIGIT_W;
  if (WIDTHS_REGULAR[char] !== undefined) return WIDTHS_REGULAR[char];
  if (char >= 'A' && char <= 'Z') return bold ? 722 : 667;
  if (char >= 'a' && char <= 'z') {
    const narrow = 'iljft'.includes(char);
    return narrow ? (bold ? 333 : 250) : (bold ? 611 : 556);
  }
  if (code > 127) return bold ? 611 : 556;
  return bold ? 611 : 556;
}

function textWidth(text, size, bold) {
  let sum = 0;
  for (const char of String(text)) sum += charWidth(char, bold);
  return (sum / 1000) * size;
}

class PdfDoc {
  constructor({ title = '', margin = 48 } = {}) {
    this.pages = [];
    this.title = title;
    this.margin = margin;
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = A4.height - this.margin;
    return this;
  }

  /** Sorgt dafür, dass unterhalb von `needed` Punkten noch Platz ist. */
  ensure(needed) {
    if (this.y - needed < this.margin) this.newPage();
    return this;
  }

  text(value, x, y, { size = 10, bold = false, align = 'left', width = 0, color = null } = {}) {
    const content = String(value === null || value === undefined ? '' : value);
    let posX = x;
    if (align === 'right') posX = x + width - textWidth(content, size, bold);
    else if (align === 'center') posX = x + (width - textWidth(content, size, bold)) / 2;
    const parts = [];
    if (color) parts.push(`${color[0]} ${color[1]} ${color[2]} rg`);
    parts.push('BT', `/${bold ? 'F2' : 'F1'} ${size} Tf`, `1 0 0 1 ${posX.toFixed(2)} ${y.toFixed(2)} Tm`);
    this.ops.push(parts.join('\n'));
    this.ops.push({ raw: Buffer.concat([Buffer.from('('), escapePdf(toWinAnsi(content)), Buffer.from(') Tj\nET\n')]) });
    if (color) this.ops.push('0 0 0 rg');
    return this;
  }

  /** Schreibt eine Zeile am aktuellen Stand und rückt den Cursor weiter. */
  line(value, options = {}) {
    const size = options.size || 10;
    this.ensure(size + 4);
    this.y -= size + (options.lead === undefined ? 3 : options.lead);
    this.text(value, options.x === undefined ? this.margin : options.x, this.y, options);
    return this;
  }

  gap(points = 10) {
    this.y -= points;
    return this;
  }

  hline(y, x1 = this.margin, x2 = A4.width - this.margin, thickness = 0.6) {
    this.ops.push(`${thickness} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
    return this;
  }

  rect(x, y, w, h, { fill = null, stroke = null, thickness = 0.6 } = {}) {
    const parts = [];
    if (fill) parts.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
    if (stroke) parts.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG`);
    parts.push(`${thickness} w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    parts.push(fill && stroke ? 'B' : (fill ? 'f' : 'S'));
    if (fill || stroke) parts.push('0 0 0 rg', '0 0 0 RG');
    this.ops.push(parts.join('\n'));
    return this;
  }

  /** Bricht Text auf eine Breite um und gibt die Zeilen zurück. */
  static wrap(text, width, size, bold = false) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    words.forEach((word) => {
      const candidate = current ? current + ' ' + word : word;
      if (textWidth(candidate, size, bold) > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    if (current) lines.push(current);
    return lines;
  }

  static width(text, size, bold) { return textWidth(text, size, bold); }

  build() {
    const objects = [];
    const add = (buffer) => { objects.push(buffer); return objects.length; };

    const fontRegular = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
    const fontBold = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));

    const pageIds = [];
    const contentIds = [];
    this.pages.forEach((ops) => {
      const chunks = ops.map((op) => (op && op.raw ? op.raw : Buffer.from(String(op) + '\n')));
      const content = Buffer.concat(chunks);
      contentIds.push(add(Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')
      ])));
      pageIds.push(0);
    });

    const pagesId = objects.length + this.pages.length + 1;
    this.pages.forEach((_, index) => {
      pageIds[index] = add(Buffer.from(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] `
        + `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> `
        + `/Contents ${contentIds[index]} 0 R >>`));
    });

    const realPagesId = add(Buffer.from(
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => id + ' 0 R').join(' ')}] >>`));
    const infoId = add(Buffer.concat([
      Buffer.from('<< /Title ('), escapePdf(toWinAnsi(this.title)),
      Buffer.from(`) /Producer (Raeucherhaken24) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`)
    ]));
    const catalogId = add(Buffer.from(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`));

    // Die Seiten verweisen auf realPagesId; beim Aufbau oben war der Wert geschätzt.
    pageIds.forEach((id) => {
      objects[id - 1] = Buffer.from(objects[id - 1].toString('latin1').replace(`/Parent ${pagesId} 0 R`, `/Parent ${realPagesId} 0 R`), 'latin1');
    });

    const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
    const parts = [header];
    const offsets = [0];
    let position = header.length;
    objects.forEach((body, index) => {
      const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
      offsets.push(position);
      position += chunk.length;
      parts.push(chunk);
    });
    const xrefStart = position;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
  }
}

module.exports = { PdfDoc, A4, textWidth };
