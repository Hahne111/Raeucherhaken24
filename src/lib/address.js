'use strict';

const FIELDS = ['first_name', 'last_name', 'company', 'street', 'zip', 'city', 'country', 'phone'];

const LABELS = {
  first_name: 'Vorname', last_name: 'Nachname', company: 'Firma',
  street: 'Straße und Hausnummer', zip: 'PLZ', city: 'Ort', country: 'Land', phone: 'Telefon'
};

const COUNTRIES = [
  ['DE', 'Deutschland'], ['AT', 'Österreich'], ['CH', 'Schweiz'],
  ['NL', 'Niederlande'], ['DK', 'Dänemark'], ['BE', 'Belgien'], ['LU', 'Luxemburg']
];

function fromBody(body, prefix = '') {
  const out = {};
  for (const field of FIELDS) out[field] = String(body[prefix + field] || '').trim().slice(0, 120);
  if (!out.country) out.country = 'DE';
  return out;
}

function validate(address) {
  const errors = {};
  if (!address.first_name) errors.first_name = 'Bitte den Vornamen angeben.';
  if (!address.last_name) errors.last_name = 'Bitte den Nachnamen angeben.';
  if (!address.street) errors.street = 'Bitte Straße und Hausnummer angeben.';
  if (!address.zip) errors.zip = 'Bitte die Postleitzahl angeben.';
  else if (!/^[0-9A-Za-z\- ]{4,10}$/.test(address.zip)) errors.zip = 'Diese Postleitzahl sieht nicht gültig aus.';
  if (!address.city) errors.city = 'Bitte den Ort angeben.';
  if (!COUNTRIES.some(([code]) => code === address.country)) errors.country = 'Bitte ein Lieferland wählen.';
  return errors;
}

function countryName(code) {
  const found = COUNTRIES.find(([c]) => c === code);
  return found ? found[1] : code;
}

function format(address) {
  if (!address) return '';
  const parts = [
    [address.first_name, address.last_name].filter(Boolean).join(' '),
    address.company,
    address.street,
    [address.zip, address.city].filter(Boolean).join(' '),
    countryName(address.country)
  ];
  return parts.filter(Boolean).join('\n');
}

module.exports = { FIELDS, LABELS, COUNTRIES, fromBody, validate, format, countryName };
