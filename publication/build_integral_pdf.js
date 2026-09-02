#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const webRequire = createRequire(path.join(ROOT, 'web', 'server.js'));
const PDFDocument = webRequire('pdfkit');
const DB_PATH = path.join(ROOT, 'database', 'woordenlijst.sqlite');
const DEFAULT_OUTPUT = path.join(ROOT, 'docs', 'pdf', 'woordenlijst-a-z-compact.pdf');
const FONT_REGULAR = '/System/Library/Fonts/Supplemental/Arial.ttf';
const FONT_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONT_ITALIC = '/System/Library/Fonts/Supplemental/Arial Italic.ttf';
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN_X = 27;
const COLUMN_GAP = 15;
const COLUMN_WIDTH = (PAGE.width - (2 * MARGIN_X) - COLUMN_GAP) / 2;
const CONTENT_TOP = 42;
const CONTENT_BOTTOM = 812;
const LETTER_TOP = 72;
const LINE = '#dce2de';

function argument(name, fallback = '') {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

const output = path.resolve(argument('output', DEFAULT_OUTPUT));
const letters = [...new Set(argument('letters', 'abcdefghijklmnopqrstuvwxyz')
  .toLowerCase().split('').filter(letter => /^[a-z]$/.test(letter)))];
const includeCover = argument('cover', '1') !== '0';
const coverOnly = argument('cover-only', '0') === '1';
if (!letters.length) throw new Error('Geen geldige letters opgegeven.');

function initialLetter(value) {
  const normalized = String(value || '')
    .trimStart().normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase('nl-NL');
  return [...normalized].find(character => /^[a-z]$/.test(character)) || '';
}

function safe(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function article(label) {
  if (!label || !label.includes('zelfstandig naamwoord')) return '';
  return label.includes('(o)') ? 'het ' : 'de ';
}

function formText(form) {
  const cut = form.hyphenation ? ` [${safe(form.hyphenation).replaceAll('|', '·')}]` : '';
  const label = safe(form.label);
  return `${label ? `${label}: ` : ''}${safe(form.wordform)}${cut}`;
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.part`;
try { fs.unlinkSync(temporary); } catch {}

const database = new DatabaseSync(DB_PATH, { readOnly: true });
database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=60000; PRAGMA cache_size=-131072;');
database.function('initial_letter', { deterministic: true, directOnly: true }, initialLetter);

const placeholders = letters.map(() => '?').join(',');
const lemmaRows = database.prepare(`
  WITH ranked AS (
    SELECT l.*, r.query_word,
      initial_letter(COALESCE(NULLIF(l.lemma, ''), r.query_word)) AS export_letter,
      ROW_NUMBER() OVER (
        PARTITION BY CASE WHEN l.lemma_id<>'' THEN 'id:'||l.lemma_id
                          ELSE 'text:'||lower(l.lemma)||'|'||l.label END
        ORDER BY r.id, l.id
      ) AS rn
    FROM lemmata l JOIN responses r ON r.id=l.response_id
    WHERE initial_letter(COALESCE(NULLIF(l.lemma, ''), r.query_word)) IN (${placeholders})
  )
  SELECT * FROM ranked WHERE rn=1
  ORDER BY export_letter, lemma COLLATE NOCASE, lemma, id
`);
const formRows = database.prepare(`
  SELECT label, wordform, hyphenation, part_of_speech, position
  FROM paradigms WHERE lemma_row_id=?
  ORDER BY CAST(position AS INTEGER), id
`);

const doc = new PDFDocument({
  autoFirstPage: false,
  size: 'A4',
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  compress: true,
  bufferPages: false,
  info: {
    Title: `Woordenlijst ${letters.map(letter => letter.toUpperCase()).join('–')} — compacte integrale editie`,
    Author: 'Woordenlijst Browser',
    Subject: 'Compacte tweekoloms boekexport van het woordenlijst.org-archief',
    Creator: 'Woordenlijst Browser',
  },
});
doc.registerFont('Regular', FONT_REGULAR);
doc.registerFont('Bold', FONT_BOLD);
doc.registerFont('Italic', FONT_ITALIC);
const stream = fs.createWriteStream(temporary, { flags: 'wx' });
doc.pipe(stream);

let pageNumber = 0;
let currentLetter = '';
let column = 0;
let cursorY = CONTENT_TOP;
let exported = 0;
let contentPages = 0;
const started = Date.now();

function columnX() {
  return MARGIN_X + column * (COLUMN_WIDTH + COLUMN_GAP);
}

function drawRunningMatter(letter) {
  const label = `WOORDENLIJST · ${letter.toUpperCase()}`;
  doc.font('Bold').fontSize(5.8).fillColor('#557067')
    .text(label, MARGIN_X, 18, { width: PAGE.width - 2 * MARGIN_X, characterSpacing: 0.7, lineBreak: false });
  doc.font('Regular').fontSize(5.8).fillColor('#6f7c76')
    .text(`${letter.toUpperCase()} · ${pageNumber}`, MARGIN_X, 823, { width: PAGE.width - 2 * MARGIN_X, align: 'center', lineBreak: false });
}

function addContentPage(letter, letterStart = false) {
  doc.addPage({ size: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  pageNumber += 1;
  contentPages += 1;
  column = 0;
  cursorY = letterStart ? LETTER_TOP : CONTENT_TOP;
  drawRunningMatter(letter);
  if (letterStart) {
    doc.font('Bold').fontSize(25).fillColor('#164c39')
      .text(letter.toUpperCase(), MARGIN_X, 37, { width: PAGE.width - 2 * MARGIN_X, lineBreak: false });
    doc.moveTo(MARGIN_X + 35, 54).lineTo(PAGE.width - MARGIN_X, 54)
      .lineWidth(0.7).strokeColor('#a9b8b0').stroke();
    const outline = doc.outline.addItem(`Letter ${letter.toUpperCase()}`);
    outline.expanded = false;
  }
}

function nextColumn() {
  if (column === 0) {
    column = 1;
    cursorY = CONTENT_TOP;
  } else {
    addContentPage(currentLetter, false);
  }
}

function ensureSpace(height) {
  if (cursorY + height <= CONTENT_BOTTOM) return false;
  nextColumn();
  return true;
}

function measure(text, font, size, options = {}) {
  doc.font(font).fontSize(size);
  return doc.heightOfString(text || ' ', { width: COLUMN_WIDTH, lineGap: 0, ...options });
}

function wrapSegments(segments, font, size, width) {
  doc.font(font).fontSize(size);
  const lines = [];
  let line = '';
  for (const segment of segments) {
    const candidate = line ? `${line}  ·  ${segment}` : segment;
    if (line && doc.widthOfString(candidate) > width) {
      lines.push(line);
      line = segment;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCover() {
  doc.addPage({ size: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  pageNumber = 1;
  doc.rect(0, 0, PAGE.width, PAGE.height).fill('#164c39');
  doc.fillColor('#cce36f').font('Bold').fontSize(8.5)
    .text('WOORDENLIJST NEDERLANDSE TAAL', 48, 70, { characterSpacing: 1.6, lineBreak: false });
  doc.fillColor('#ffffff').font('Regular').fontSize(34).text('Woordenlijst', 48, 132, { lineBreak: false });
  doc.fillColor('#cce36f').font('Italic').fontSize(28).text('integrale editie', 48, 176, { lineBreak: false });
  doc.fillColor('#e1ece7').font('Regular').fontSize(12)
    .text(`Letters ${letters[0].toUpperCase()}–${letters.at(-1).toUpperCase()} · compacte tweekoloms opmaak`, 48, 245);
  doc.moveTo(48, 288).lineTo(350, 288).lineWidth(1).strokeColor('#7aa08f').stroke();
  doc.fillColor('#bdd0c7').font('Regular').fontSize(9)
    .text('Lemma’s, uitspraak, woordsoort, betekenis, woordvormen en afbreking.', 48, 315, { width: 410 });
  doc.fontSize(7.5).fillColor('#a9c0b6')
    .text(`Gegenereerd op ${new Date().toLocaleDateString('nl-NL')} · Bron: woordenlijst.org (MolexServe API)`, 48, 755, { width: 470 });
}

function drawLemma(lemma, forms) {
  const title = `${article(lemma.label)}${safe(lemma.lemma || lemma.query_word)}`;
  const meta = [lemma.pronunciation ? `/${safe(lemma.pronunciation)}/` : '', safe(lemma.label || lemma.lemma_part_of_speech)]
    .filter(Boolean).join(' · ');
  const gloss = safe(lemma.gloss);
  const titleHeight = measure(title, 'Bold', 7.4);
  const metaHeight = meta ? measure(meta, 'Regular', 5.8) : 0;
  const glossHeight = gloss ? measure(gloss, 'Italic', 5.7) : 0;
  const headerHeight = titleHeight + metaHeight + glossHeight + 4;
  ensureSpace(Math.min(headerHeight + (forms.length ? 8 : 0), 80));

  const x = columnX();
  doc.font('Bold').fontSize(7.4).fillColor('#143e31')
    .text(title, x, cursorY, { width: COLUMN_WIDTH, lineGap: 0 });
  cursorY += titleHeight;
  if (meta) {
    doc.font('Regular').fontSize(5.8).fillColor('#43534b')
      .text(meta, x, cursorY, { width: COLUMN_WIDTH, lineGap: 0 });
    cursorY += metaHeight;
  }
  if (gloss) {
    doc.font('Italic').fontSize(5.7).fillColor('#5f6d66')
      .text(gloss, x, cursorY, { width: COLUMN_WIDTH, lineGap: 0 });
    cursorY += glossHeight;
  }

  const formLines = wrapSegments(forms.map(formText), 'Regular', 5.45, COLUMN_WIDTH - 6);
  for (let index = 0; index < formLines.length; index += 1) {
    const line = formLines[index];
    const lineHeight = measure(line, 'Regular', 5.45, { width: COLUMN_WIDTH - 6 });
    if (ensureSpace(lineHeight + 2)) {
      const continuation = `${safe(lemma.lemma || lemma.query_word)} (vervolg)`;
      const continuationHeight = measure(continuation, 'Italic', 5.5);
      doc.font('Italic').fontSize(5.5).fillColor('#65736c')
        .text(continuation, columnX(), cursorY, { width: COLUMN_WIDTH });
      cursorY += continuationHeight + 1;
    }
    doc.font('Regular').fontSize(5.45).fillColor('#27342e')
      .text(line, columnX() + 6, cursorY, { width: COLUMN_WIDTH - 6, lineGap: 0 });
    cursorY += lineHeight;
  }
  cursorY += 2.3;
  doc.moveTo(columnX(), cursorY).lineTo(columnX() + COLUMN_WIDTH, cursorY)
    .lineWidth(0.28).strokeColor(LINE).stroke();
  cursorY += 3.2;
}

if (includeCover || coverOnly) drawCover();
if (!coverOnly) {
  let letterCount = 0;
  for (const lemma of lemmaRows.iterate(...letters)) {
    if (lemma.export_letter !== currentLetter) {
      if (currentLetter) process.stdout.write(`\n${currentLetter.toUpperCase()}: ${letterCount.toLocaleString('nl-NL')} lemma's\n`);
      currentLetter = lemma.export_letter;
      letterCount = 0;
      addContentPage(currentLetter, true);
    }
    drawLemma(lemma, formRows.all(lemma.id));
    letterCount += 1;
    exported += 1;
    if (exported % 1000 === 0) {
      const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
      process.stdout.write(`\r${exported.toLocaleString('nl-NL')} lemma's · ${contentPages.toLocaleString('nl-NL')} pagina's · ${seconds}s`);
    }
  }
  if (currentLetter) process.stdout.write(`\n${currentLetter.toUpperCase()}: ${letterCount.toLocaleString('nl-NL')} lemma's\n`);
}

doc.end();
stream.on('finish', () => {
  fs.renameSync(temporary, output);
  const bytes = fs.statSync(output).size;
  console.log(`Klaar: ${output}`);
  console.log(`${exported.toLocaleString('nl-NL')} lemma's · ${pageNumber.toLocaleString('nl-NL')} pagina's · ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
});
stream.on('error', error => {
  try { fs.unlinkSync(temporary); } catch {}
  throw error;
});
