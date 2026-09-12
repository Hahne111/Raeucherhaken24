'use strict';

function amount(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d{1,7}(?:[,.]\d{1,2})?$/.test(raw)) return null;
  const [euros, cents = ''] = raw.replace(',', '.').split('.');
  return Number(euros) * 100 + Number(cents.padEnd(2, '0'));
}

function basisPoints(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d{1,2}(?:[,.]\d{1,2})?$/.test(raw)) return null;
  return amount(raw);
}

function calculate(body, taxRate) {
  const material_cents = amount(body.material);
  const hourly_cents = amount(body.hourly);
  const other_cents = amount(body.other);
  const fee_bps = basisPoints(body.fee);
  const margin_bps = basisPoints(body.margin);
  const minutes = String(body.minutes == null ? '' : body.minutes).trim();
  const labor_minutes = /^\d{1,5}$/.test(minutes) ? Number(minutes) : null;
  if ([material_cents, hourly_cents, other_cents, fee_bps, margin_bps, labor_minutes].some((n) => n == null) ||
      fee_bps + margin_bps >= 9500 || !Number.isInteger(taxRate) || taxRate < 0 || taxRate > 30) {
    return { ok: false, message: 'Beträge, Minuten, Gebühren oder Marge sind ungültig. Gebühren plus Marge müssen unter 95 % liegen.' };
  }
  const labor_cents = Math.round(hourly_cents * labor_minutes / 60);
  const cost_cents = material_cents + labor_cents + other_cents;
  if (cost_cents <= 0) return { ok: false, message: 'Bitte Kosten größer als 0 angeben.' };
  const net_price_cents = Math.ceil(cost_cents * 10000 / (10000 - fee_bps - margin_bps));
  const gross_price_cents = Math.round(net_price_cents * (100 + taxRate) / 100);
  if (!Number.isSafeInteger(gross_price_cents) || gross_price_cents > 999999999) {
    return { ok: false, message: 'Der errechnete Preis ist zu hoch.' };
  }
  return { ok: true, values: {
    material_cents, labor_minutes, hourly_cents, labor_cents, other_cents, fee_bps, margin_bps,
    tax_rate: taxRate, cost_cents, net_price_cents, gross_price_cents
  } };
}

module.exports = { calculate };
