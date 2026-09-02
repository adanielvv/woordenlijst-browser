'use strict';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const SECTION_ORDER = Object.freeze(['0-9', ...ALPHABET, 'other']);
const APOSTROPHES = /^[\u0027\u2018\u2019\u02bc]/u;

function normalized(value) {
  return String(value || '').trimStart().normalize('NFD')
    .replace(/\p{M}+/gu, '').toLocaleLowerCase('nl-NL');
}

function exportSection(value) {
  const text = normalized(value);
  const first = [...text][0] || '';
  if (/^[0-9]$/.test(first)) return '0-9';
  if (/^[a-z]$/.test(first)) return first;
  if (APOSTROPHES.test(text)) {
    const remainder = text.replace(APOSTROPHES, '').trimStart();
    const letter = [...remainder].find(character => /^[a-z]$/.test(character));
    return letter || 'other';
  }
  return 'other';
}

function apostropheRank(value) {
  return APOSTROPHES.test(normalized(value)) ? 0 : 1;
}

function sortText(value) {
  return normalized(value).replace(APOSTROPHES, '').trimStart();
}

function sectionOrder(section) {
  const index = SECTION_ORDER.indexOf(section);
  return index < 0 ? SECTION_ORDER.length : index;
}

function sectionLabel(section) {
  if (section === '0-9') return '0–9';
  if (section === 'other') return 'Overig';
  return String(section || '').toUpperCase();
}

function parseSections(value, fallback = SECTION_ORDER) {
  const raw = String(value || '').trim();
  const items = raw ? raw.split(',').flatMap(item => {
    const clean = item.trim().toLowerCase();
    return /^[a-z]{2,}$/.test(clean) && clean !== 'other' ? [...clean] : [clean];
  }) : [...fallback];
  const wanted = new Set(items.filter(item => SECTION_ORDER.includes(item)));
  return SECTION_ORDER.filter(section => wanted.has(section));
}

module.exports = { ALPHABET, SECTION_ORDER, exportSection, apostropheRank, sortText, sectionOrder, sectionLabel, parseSections };
