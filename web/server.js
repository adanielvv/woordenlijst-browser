#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const PDFDocument = require('pdfkit');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const CONTENT_DB = path.join(ROOT, 'database', 'woordenlijst.sqlite');
const STATE_DB = path.join(ROOT, 'state', 'downloader.sqlite');
const RUN_STATE = path.join(ROOT, 'state', 'full-run.json');
const RUN_STATE_DIR = path.join(ROOT, 'state');
const PORT = Number(process.env.PORT || 3080);
const FONT_REGULAR = '/System/Library/Fonts/Supplemental/Arial.ttf';
const FONT_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONT_ITALIC = '/System/Library/Fonts/Supplemental/Arial Italic.ttf';

const content = new DatabaseSync(CONTENT_DB, { readOnly: true });
const state = new DatabaseSync(STATE_DB, { readOnly: true });
content.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=60000; PRAGMA cache_size=-65536;');
state.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=60000; PRAGMA cache_size=-16384;');

function initialLetter(value) {
  const normalized = String(value || '')
    .trimStart()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('nl-NL');
  return [...normalized].find(character => /^[a-z]$/.test(character)) || '';
}

content.function('initial_letter', { deterministic: true, directOnly: true }, initialLetter);

const metadataCache = new Map();
const countCache = new Map();

function cached(key, maxAgeMs, producer) {
  const hit = metadataCache.get(key);
  if (hit && Date.now() - hit.createdAt < maxAgeMs) return hit.value;
  const value = producer();
  metadataCache.set(key, { createdAt: Date.now(), value });
  return value;
}

function commonHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

function json(res, value, status = 200, cacheControl = 'no-store') {
  const body = JSON.stringify(value);
  res.writeHead(status, commonHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cacheControl,
  }));
  res.end(body);
}

function readRunState() {
  try {
    const parallel = fs.readdirSync(RUN_STATE_DIR)
      .filter(name => /^(?:letter-[a-z]|prefix-[a-z]{2})\.json$/.test(name))
      .sort()
      .map(name => JSON.parse(fs.readFileSync(path.join(RUN_STATE_DIR, name), 'utf8')));
    if (parallel.length) {
      const running = parallel.filter(item => item.status === 'running');
      return {
        status: running.length ? 'running' : (parallel.every(item => item.status === 'complete') ? 'complete' : 'mixed'),
        current_prefix: running.length ? `${running.length} taken parallel` : null,
        current_letter: running.map(item => item.current_letter).join(''),
        workers: parallel.length,
        running_workers: running.length,
      };
    }
  } catch {}
  try {
    return JSON.parse(fs.readFileSync(RUN_STATE, 'utf8'));
  } catch {
    return null;
  }
}

function getStats() {
  const archive = cached('archive-stats', 60 * 60 * 1000, () => content.prepare(`
    SELECT
      (SELECT COALESCE(MAX(id), 0) FROM responses) AS responses,
      (SELECT COALESCE(MAX(id), 0) FROM lemmata) AS lemmata,
      (SELECT COALESCE(MAX(id), 0) FROM paradigms) AS paradigms,
      (SELECT COALESCE(MAX(id), 0) FROM xml_nodes) AS xml_nodes,
      0 AS xml_bytes
  `).get());
  const statuses = cached('candidate-statuses', 60 * 1000, () => Object.fromEntries(
    state.prepare('SELECT status, COUNT(*) AS count FROM candidates WHERE active_source=1 GROUP BY status')
      .all().map(row => [row.status, row.count])
  ));
  const discovered = cached('candidate-total', 60 * 60 * 1000,
    () => state.prepare('SELECT COUNT(*) AS count FROM candidates WHERE active_source=1').get().count);
  const complete = statuses.complete || 0;
  return {
    archive,
    statuses,
    discovered,
    complete,
    percent: discovered ? Math.round((complete / discovered) * 10000) / 100 : 0,
    run: readRunState(),
    generated_at: new Date().toISOString(),
  };
}

function getPrefixes() {
  return cached('prefixes', 60 * 60 * 1000, () => state.prepare(`
    SELECT prefix_bucket AS prefix,
      COUNT(*) AS total,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS complete,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
    FROM candidates
    WHERE active_source=1
    GROUP BY prefix_bucket
    ORDER BY prefix_bucket
  `).all());
}

function getLetters() {
  return cached('letters', 60 * 60 * 1000, () => state.prepare(`
    SELECT first_bucket AS letter,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS lemmata
    FROM candidates
    WHERE active_source=1 AND first_bucket BETWEEN 'a' AND 'z'
    GROUP BY first_bucket ORDER BY first_bucket
  `).all());
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function getWords(url) {
  const query = (url.searchParams.get('q') || '').trim();
  const prefix = (url.searchParams.get('prefix') || '').trim().toLowerCase();
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const limit = Math.min(100, Math.max(10, Number(url.searchParams.get('limit') || 40)));
  const offset = (page - 1) * limit;
  const where = [];
  const params = {};
  if (query) {
    where.push("r.query_word LIKE :query ESCAPE '\\' COLLATE NOCASE");
    params.query = `%${escapeLike(query)}%`;
  }
  if (prefix) {
    where.push('r.prefix_bucket = :prefix');
    params.prefix = prefix;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countKey = JSON.stringify([query.toLocaleLowerCase('nl-NL'), prefix]);
  let total = countCache.get(countKey);
  if (total === undefined) {
    total = content.prepare(`SELECT COUNT(*) AS count FROM responses r ${whereSql}`).get(params).count;
    if (countCache.size >= 200) countCache.delete(countCache.keys().next().value);
    countCache.set(countKey, total);
  }
  const rows = content.prepare(`
    SELECT r.id, r.query_word, r.prefix_bucket, r.bytes, r.downloaded_at,
      (SELECT label FROM lemmata WHERE response_id=r.id ORDER BY id LIMIT 1) AS label,
      (SELECT pronunciation FROM lemmata WHERE response_id=r.id AND pronunciation<>'' ORDER BY id LIMIT 1) AS pronunciation,
      (SELECT gloss FROM lemmata WHERE response_id=r.id AND gloss<>'' ORDER BY id LIMIT 1) AS gloss,
      (SELECT COUNT(*) FROM lemmata WHERE response_id=r.id) AS lemma_count
    FROM responses r
    ${whereSql}
    ORDER BY r.query_word, r.id
    LIMIT :limit OFFSET :offset
  `).all({ ...params, limit, offset });
  return { rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), query, prefix };
}

function getWord(id) {
  const response = content.prepare(`
    SELECT id, query_word, prefix_bucket, xml_path, sha256, bytes,
      http_status, xml_message, downloaded_at
    FROM responses WHERE id=?
  `).get(id);
  if (!response) return null;
  const lemmata = content.prepare('SELECT * FROM lemmata WHERE response_id=? ORDER BY id').all(id);
  const paradigms = content.prepare(`
    SELECT p.* FROM paradigms p
    JOIN lemmata l ON l.id=p.lemma_row_id
    WHERE l.response_id=? ORDER BY l.id, CAST(p.position AS INTEGER), p.id
  `).all(id);
  const byLemma = new Map();
  for (const item of paradigms) {
    if (!byLemma.has(item.lemma_row_id)) byLemma.set(item.lemma_row_id, []);
    byLemma.get(item.lemma_row_id).push(item);
  }
  for (const lemma of lemmata) lemma.paradigms = byLemma.get(lemma.id) || [];
  return { response, lemmata };
}

function getNodes(id) {
  return content.prepare(`
    SELECT node_order, xpath, tag, text_value, attributes_json
    FROM xml_nodes WHERE response_id=? ORDER BY node_order
  `).all(id);
}

function rawXml(id) {
  return content.prepare('SELECT raw_xml FROM responses WHERE id=?').get(id);
}

function cleanLetters(value) {
  return [...new Set(String(value || '').toLowerCase().split(',')
    .map(item => item.trim()).filter(item => /^[a-z]$/.test(item)))].sort();
}

function pdfArticle(label) {
  if (!label || !label.includes('zelfstandig naamwoord')) return '';
  return label.includes('(o)') ? 'het ' : 'de ';
}

function pdfSafe(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function generatePdf(res, letters) {
  const placeholders = letters.map(() => '?').join(',');
  const exportLetter = "initial_letter(COALESCE(NULLIF(l.lemma, ''), r.query_word))";
  const rows = content.prepare(`
    WITH ranked AS (
      SELECT l.*, r.prefix_bucket, r.query_word,
        ${exportLetter} AS export_letter,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN l.lemma_id<>'' THEN 'id:'||l.lemma_id
                            ELSE 'text:'||lower(l.lemma)||'|'||l.label END
          ORDER BY r.id, l.id
        ) AS rn
      FROM lemmata l JOIN responses r ON r.id=l.response_id
      WHERE ${exportLetter} IN (${placeholders})
    )
    SELECT * FROM ranked WHERE rn=1
    ORDER BY export_letter, lemma COLLATE NOCASE, lemma, id
  `).iterate(...letters);
  const forms = content.prepare(`
    SELECT label, wordform, hyphenation, part_of_speech, position
    FROM paradigms WHERE lemma_row_id=?
    ORDER BY CAST(position AS INTEGER), id
  `);
  const counts = Object.fromEntries(content.prepare(`
    WITH ranked AS (
      SELECT ${exportLetter} AS export_letter,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN l.lemma_id<>'' THEN 'id:'||l.lemma_id
                            ELSE 'text:'||lower(l.lemma)||'|'||l.label END
          ORDER BY r.id, l.id
        ) AS rn
      FROM lemmata l JOIN responses r ON r.id=l.response_id
      WHERE ${exportLetter} IN (${placeholders})
    )
    SELECT export_letter, COUNT(*) AS lemmata
    FROM ranked WHERE rn=1 GROUP BY export_letter
  `).all(...letters).map(row => [row.export_letter, row.lemmata]));
  const filename = `woordenlijst-${letters.join('-')}.pdf`;
  res.writeHead(200, commonHeaders({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  }));

  const doc = new PDFDocument({
    size: 'A4', margins: { top: 56, right: 52, bottom: 52, left: 52 },
    info: {
      Title: `Woordenlijst ${letters.map(letter => letter.toUpperCase()).join(', ')}`,
      Author: 'Woordenlijst Browser',
      Subject: 'Lokale export van woordenlijst.org XML-archief',
    },
  });
  doc.registerFont('Regular', FONT_REGULAR);
  doc.registerFont('Bold', FONT_BOLD);
  doc.registerFont('Italic', FONT_ITALIC);
  doc.pipe(res);

  let pageNumber = 1;
  let currentLetter = '';
  function footer() {
    const oldX = doc.x, oldY = doc.y;
    doc.font('Regular').fontSize(7).fillColor('#738078').text(
      `Woordenlijst Browser · ${currentLetter ? `Letter ${currentLetter.toUpperCase()} · ` : ''}${pageNumber}`,
      52, doc.page.height - doc.page.margins.bottom - 10,
      { width: doc.page.width - 104, align: 'center', lineBreak: false }
    );
    doc.x = oldX; doc.y = oldY;
  }
  doc.on('pageAdded', () => { pageNumber += 1; footer(); });

  doc.rect(0, 0, doc.page.width, doc.page.height).fill('#184f3c');
  doc.fillColor('#cce36f').font('Bold').fontSize(10)
    .text('WOORDENLIJST NEDERLANDSE TAAL', 52, 72, { characterSpacing: 1.8 });
  doc.fillColor('#ffffff').font('Regular').fontSize(40).text('Woordenlijst', 52, 130);
  doc.font('Italic').fillColor('#cce36f').fontSize(33).text('boekexport', 52, 178);
  doc.font('Regular').fillColor('#dbe9e3').fontSize(14)
    .text(`Letters ${letters.map(letter => letter.toUpperCase()).join(', ')}`, 52, 250);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  doc.fontSize(10).fillColor('#b9cec5')
    .text(`${total.toLocaleString('nl-NL')} unieke lemma’s in de huidige lokale momentopname`, 52, 285, { width: 430 });
  doc.fontSize(8).text(
    `Gegenereerd op ${new Date().toLocaleString('nl-NL')} · Bron: woordenlijst.org (MolexServe API)`,
    52, 700, { width: 430 }
  );

  let exported = 0;
  for (const lemma of rows) {
    if (lemma.export_letter !== currentLetter) {
      currentLetter = lemma.export_letter;
      doc.addPage();
      doc.fillColor('#1f6b4f').font('Bold').fontSize(44).text(currentLetter.toUpperCase(), 52, 58);
      doc.fillColor('#66736c').font('Regular').fontSize(9)
        .text(`${(counts[currentLetter] || 0).toLocaleString('nl-NL')} unieke lemma’s`, 54, 112);
      doc.moveTo(52, 135).lineTo(doc.page.width - 52, 135).strokeColor('#cdd5cf').stroke();
      doc.y = 158;
    }
    const paradigms = forms.all(lemma.id);
    const estimated = 55 + Math.min(paradigms.length, 5) * 17 + (lemma.gloss ? 18 : 0);
    if (doc.y + estimated > doc.page.height - 58) doc.addPage();
    const title = `${pdfArticle(lemma.label)}${pdfSafe(lemma.lemma || lemma.query_word)}`;
    doc.fillColor('#164c39').font('Bold').fontSize(12).text(title, 52, doc.y, { width: 490 });
    if (lemma.pronunciation) {
      doc.fillColor('#53615a').font('Italic').fontSize(9)
        .text(`/${pdfSafe(lemma.pronunciation)}/`, { width: 490 });
    }
    doc.fillColor('#27362f').font('Regular').fontSize(8.5)
      .text(pdfSafe(lemma.label || lemma.lemma_part_of_speech), { width: 490 });
    if (lemma.gloss) {
      doc.fillColor('#4f5c56').font('Italic').fontSize(8.5).text(pdfSafe(lemma.gloss), { width: 490 });
    }
    for (const form of paradigms) {
      if (doc.y > doc.page.height - 65) doc.addPage();
      const cut = form.hyphenation ? `[${pdfSafe(form.hyphenation).replaceAll('|', '·')}]` : '';
      const rowY = doc.y;
      doc.fillColor('#6a756f').font('Regular').fontSize(7.8)
        .text(pdfSafe(form.label), 66, rowY, { width: 78, lineBreak: false });
      doc.fillColor('#1d2b25').font('Bold')
        .text(pdfSafe(form.wordform), 148, rowY, { width: 175, lineBreak: false });
      doc.fillColor('#65716a').font('Regular')
        .text(cut, 330, rowY, { width: 205, lineBreak: false });
      doc.y = rowY + 12;
    }
    if (lemma.taalvariant && lemma.taalvariant !== '-') {
      doc.fillColor('#68736d').font('Regular').fontSize(7.5)
        .text(`Taalvariant: ${pdfSafe(lemma.taalvariant)}`, 66, doc.y, { width: 460 });
    }
    doc.moveDown(.45);
    doc.moveTo(52, doc.y).lineTo(doc.page.width - 52, doc.y)
      .strokeColor('#e0e5e1').lineWidth(.5).stroke();
    doc.moveDown(.55);
    exported += 1;
  }
  if (!exported) {
    doc.addPage();
    doc.fillColor('#17231e').font('Bold').fontSize(20).text('Geen opgeslagen lemma’s gevonden.', 52, 80);
  }
  footer();
  doc.end();
}

function serveStatic(reqPath, res) {
  const relative = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const staticRoot = relative.startsWith('pdf/') ? path.join(ROOT, 'docs') : PUBLIC;
  const resolved = path.resolve(staticRoot, relative);
  if (!resolved.startsWith(staticRoot + path.sep) && resolved !== path.join(staticRoot, 'index.html')) {
    res.writeHead(403, commonHeaders()); res.end('Forbidden'); return;
  }
  try {
    const data = fs.readFileSync(resolved);
    const etag = `\"${crypto.createHash('sha1').update(data).digest('base64url')}\"`;
    if (res.req?.headers['if-none-match'] === etag) {
      res.writeHead(304, commonHeaders({ ETag: etag }));
      res.end();
      return;
    }
    res.writeHead(200, commonHeaders({
      'Content-Type': mime[path.extname(resolved)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': path.extname(resolved) === '.html' ? 'no-cache' : 'public, max-age=3600',
      ETag: etag,
    }));
    res.end(data);
  } catch {
    res.writeHead(404, commonHeaders()); res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') return json(res, { status: 'ok' });
    if (url.pathname === '/api/stats') return json(res, getStats(), 200, 'public, max-age=10');
    if (url.pathname === '/api/prefixes') return json(res, getPrefixes(), 200, 'public, max-age=300');
    if (url.pathname === '/api/letters') return json(res, getLetters(), 200, 'public, max-age=300');
    if (url.pathname === '/api/words') return json(res, getWords(url));
    if (url.pathname === '/api/export.pdf') {
      const letters = cleanLetters(url.searchParams.get('letters'));
      if (!letters.length) return json(res, { error: 'Kies minimaal één letter' }, 400);
      return generatePdf(res, letters);
    }
    const match = url.pathname.match(/^\/api\/words\/(\d+)(?:\/(xml|nodes))?$/);
    if (match) {
      const id = Number(match[1]);
      if (match[2] === 'xml') {
        const row = rawXml(id);
        if (!row) return json(res, { error: 'Niet gevonden' }, 404);
        const data = Buffer.isBuffer(row.raw_xml) ? row.raw_xml : Buffer.from(row.raw_xml);
        res.writeHead(200, commonHeaders({ 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': data.length }));
        return res.end(data);
      }
      if (match[2] === 'nodes') return json(res, getNodes(id));
      const word = getWord(id);
      return word ? json(res, word) : json(res, { error: 'Niet gevonden' }, 404);
    }
    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    return json(res, { error: 'Interne fout' }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Woordenlijst Browser draait op http://127.0.0.1:${PORT}`);
  console.log(`Database: ${CONTENT_DB}`);
});

function close() {
  server.close(() => {
    content.close();
    state.close();
    process.exit(0);
  });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
