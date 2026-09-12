'use strict';
/*
 * Barcodes als SVG, ohne Zusatzpaket.
 *
 * Unterstuetzt Code 128 (Zeichensatz B und C) und EAN-13. Der Code wird als
 * Folge schwarzer Balken gezeichnet; die Breite eines Moduls ergibt sich aus
 * der gewuenschten Gesamtbreite.
 */

/* Balkenmuster der 107 Code-128-Zeichen. */
const CODE128 = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '11000111010'
];
const STOP = '1100011101011';

/** Code 128 B: druckbare ASCII-Zeichen von Leerzeichen bis Tilde. */
function code128Bits(value) {
  const text = String(value).replace(/[^\x20-\x7e]/g, '');
  if (!text) return null;
  const codes = [104]; // Start B
  for (const ch of text) codes.push(ch.charCodeAt(0) - 32);
  let sum = 104;
  codes.slice(1).forEach((c, i) => { sum += c * (i + 1); });
  codes.push(sum % 103);
  return codes.map((c) => CODE128[c]).join('') + STOP;
}

/* EAN-13: Codierung der linken Haelfte haengt an der ersten Ziffer. */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function eanCheckDigit(twelve) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function ean13Bits(value) {
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 12) digits += eanCheckDigit(digits);
  if (digits.length !== 13) return null;
  if (eanCheckDigit(digits.slice(0, 12)) !== digits[12]) return null;
  const parity = EAN_PARITY[Number(digits[0])];
  let bits = '101';
  for (let i = 1; i <= 6; i += 1) {
    bits += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[Number(digits[i])];
  }
  bits += '01010';
  for (let i = 7; i <= 12; i += 1) bits += EAN_R[Number(digits[i])];
  return bits + '101';
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Barcode als SVG. `widthMm`/`heightMm` legen die Groesse auf dem Etikett
 * fest; `kind` ist 'code128', 'ean13' oder 'keiner'.
 */
function svg(value, { kind = 'code128', widthMm = 40, heightMm = 12, showText = true } = {}) {
  if (kind === 'keiner') return '';
  const bits = kind === 'ean13' ? ean13Bits(value) : code128Bits(value);
  if (!bits) return '';
  const module = widthMm / bits.length;
  const barHeight = showText ? heightMm - 3 : heightMm;
  let bars = '';
  let x = 0;
  let i = 0;
  while (i < bits.length) {
    let run = 1;
    while (i + run < bits.length && bits[i + run] === bits[i]) run += 1;
    if (bits[i] === '1') {
      bars += `<rect x="${(x).toFixed(3)}" y="0" width="${(module * run).toFixed(3)}" height="${barHeight.toFixed(2)}"/>`;
    }
    x += module * run;
    i += run;
  }
  const label = showText
    ? `<text x="${(widthMm / 2).toFixed(2)}" y="${heightMm.toFixed(2)}" font-size="2.6" text-anchor="middle" font-family="monospace">${escapeAttr(value)}</text>`
    : '';
  return `<svg viewBox="0 0 ${widthMm} ${heightMm}" width="${widthMm}mm" height="${heightMm}mm" `
    + `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Barcode ${escapeAttr(value)}">`
    + `<g fill="#000">${bars}${label}</g></svg>`;
}

function supports(kind, value) {
  if (kind === 'keiner') return true;
  return Boolean(kind === 'ean13' ? ean13Bits(value) : code128Bits(value));
}

module.exports = { svg, supports, eanCheckDigit, code128Bits, ean13Bits };
