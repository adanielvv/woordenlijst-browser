'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SECTION_ORDER, exportSection, apostropheRank, sortText, parseSections } = require('../../publication/pdf_sections');

test('PDF-secties volgen het echte eerste teken', () => {
  assert.equal(exportSection('007'), '0-9');
  assert.equal(exportSection('06-nummer'), '0-9');
  assert.equal(exportSection("'s avonds"), 's');
  assert.equal(exportSection('’t kofschip'), 't');
  assert.equal(exportSection('Éclair'), 'e');
  assert.equal(exportSection('µA'), 'other');
  assert.equal(exportSection('Ω'), 'other');
});

test('apostrofwoorden krijgen binnen hun letter sorteerrang nul', () => {
  assert.equal(apostropheRank("'s avonds"), 0);
  assert.equal(apostropheRank('straat'), 1);
  assert.equal(sortText("'s avonds"), 's avonds');
});

test('PDF-keuzes worden altijd geordend als 0-9, A-Z, Overig', () => {
  assert.deepEqual(parseSections('other,z,0-9,a'), ['0-9', 'a', 'z', 'other']);
  assert.deepEqual(parseSections('', SECTION_ORDER), SECTION_ORDER);
});
