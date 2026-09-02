'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const prefixes = require(path.join(__dirname, '..', '..', 'docs', 'data', 'prefixes.json'));
const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'app.js'), 'utf8');

test('prefixmetadata bevat letters, cijfers en alle speciale tekens', () => {
  const names = new Set(prefixes.map(row => row.prefix));
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    assert.ok([...names].some(name => name.startsWith(letter)), `lettergroep ${letter} ontbreekt`);
  }
  for (let digit = 0; digit <= 9; digit += 1) assert.ok(names.has(`digit-${digit}`));
  for (const symbol of ['symbol-apostrophe', 'symbol-micro', 'symbol-omega']) assert.ok(names.has(symbol));
});

test('alle 601 prefixbuckets passen in de drie navigatieniveaus', () => {
  const classified = prefixes.filter(({ prefix }) => (
    /^[a-z](?:[a-z]|_)$/.test(prefix)
    || /^digit-[0-9]$/.test(prefix)
    || /^symbol-(?:apostrophe|micro|omega)$/.test(prefix)
  ));
  assert.equal(prefixes.length, 601);
  assert.equal(classified.length, prefixes.length);
});

test('de UI koppelt zichtbare hoofdgroepen via hun groepssleutel', () => {
  assert.match(appSource, /rowsByGroup\.has\(group\.key\)/);
  assert.equal((appSource.match(/rowsByGroup\.get\(group\.key\)/g) || []).length, 2);
});
