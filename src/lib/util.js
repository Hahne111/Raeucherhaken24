'use strict';

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'eintrag';
}

function formatPrice(cents) {
  const value = (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
  return value + ' €';
}

function parsePrice(input) {
  if (input === null || input === undefined) return 0;
  const cleaned = String(input).replace(/[^0-9,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function formatDate(value) {
  if (!value) return '';
  const iso = String(value).replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDay(value) {
  if (!value) return '';
  const iso = String(value).replace(' ', 'T');
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Wandelt einfachen Text (Absaetze / Zeilen) in sicheres HTML. */
function textToHtml(str) {
  const blocks = String(str || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => '<p>' + escapeHtml(b).replace(/\n/g, '<br>') + '</p>').join('');
}

function orderNumber(id) {
  return 'RH-' + String(new Date().getFullYear()) + '-' + String(10000 + Number(id)).slice(-5);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(value || '').trim());
}

module.exports = { slugify, formatPrice, parsePrice, toInt, clamp, formatDate, formatDay, escapeHtml, textToHtml, orderNumber, isEmail };
