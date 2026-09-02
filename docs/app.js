'use strict';

const GATE_CODE = '8086';
const GATE_KEY = 'woordenlijst_gate_ok';
const PDF_BUILD = 'combined-cover-v3';
const INTEGRAL_PDF_BUILD = 'integral-a-z-v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const config = window.WOORDENLIJST_CONFIG || {};
const state = { q: '', prefix: '', prefixGroup: '', page: 1, limit: 40, pages: 1 };
const $ = selector => document.querySelector(selector);
const fmt = value => new Intl.NumberFormat('nl-NL').format(value || 0);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const hyphen = value => esc(value || '').replaceAll('|', '·');
const dataUrl = file => new URL(`./data/${file}`, document.baseURI);

async function staticJson(file) {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error(`Datafout ${response.status}`);
  return response.json();
}

async function supabase(path, { signal } = {}) {
  if (!config.supabaseUrl || !config.supabaseAnonKey || config.supabaseUrl.includes('YOUR_PROJECT')) {
    throw new Error('Supabase-configuratie ontbreekt');
  }
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    signal,
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      Prefer: 'count=exact',
    },
  });
  if (!response.ok) throw new Error(`Zoekservice ${response.status}`);
  const range = response.headers.get('content-range') || '*/0';
  return { rows: await response.json(), total: Number(range.split('/')[1] || 0) };
}

let metadata;
async function loadMetadata() {
  const [stats, prefixes] = await Promise.all([staticJson('stats.json'), staticJson('prefixes.json')]);
  metadata = { stats, prefixes };
  $('#stats').innerHTML = `<div class="stat"><strong>${fmt(stats.responses)}</strong><span>Zoekvormen</span></div><div class="stat"><strong>${fmt(stats.lemmata)}</strong><span>Lemma's</span></div><div class="stat"><strong>${fmt(stats.paradigms)}</strong><span>Woordvormen</span></div><div class="stat"><strong>${fmt(stats.prefixes)}</strong><span>Prefixes</span></div>`;
  renderPrefixes();
}

const SPECIAL_PREFIXES = Object.freeze({
  'symbol-apostrophe': { label: "'", name: 'apostrof' },
  'symbol-micro': { label: 'µ', name: 'microteken' },
  'symbol-omega': { label: 'Ω', name: 'omega' },
});

function prefixGroup(prefix) {
  if (/^[a-z](?:[a-z]|_)$/.test(prefix)) return `letter-${prefix[0]}`;
  if (/^digit-[0-9]$/.test(prefix)) return 'numbers';
  if (SPECIAL_PREFIXES[prefix]) return 'symbols';
  return 'other';
}

function prefixLabel(prefix) {
  if (/^[a-z]_$/.test(prefix)) return `${prefix[0]}…`;
  if (/^digit-[0-9]$/.test(prefix)) return prefix.at(-1);
  return SPECIAL_PREFIXES[prefix]?.label || prefix;
}

function prefixName(prefix) {
  if (/^[a-z]_$/.test(prefix)) return `${prefix[0].toUpperCase()} en varianten`;
  if (/^digit-[0-9]$/.test(prefix)) return `cijfer ${prefix.at(-1)}`;
  return SPECIAL_PREFIXES[prefix]?.name || prefix;
}

function prefixGroups() {
  const rowsByGroup = new Map();
  metadata.prefixes.forEach(row => {
    const group = prefixGroup(row.prefix);
    if (!rowsByGroup.has(group)) rowsByGroup.set(group, []);
    rowsByGroup.get(group).push(row);
  });
  const groups = ALPHABET.split('').map(letter => ({ key: `letter-${letter}`, label: letter.toUpperCase() }));
  groups.push({ key: 'numbers', label: '0–9', wide: true }, { key: 'symbols', label: 'Tekens', wide: true });
  return groups.filter(group => rowsByGroup.has(group)).map(group => ({
    ...group,
    rows: rowsByGroup.get(group),
    total: rowsByGroup.get(group).reduce((sum, row) => sum + row.total, 0),
  }));
}

function renderPrefixes() {
  const groups = prefixGroups();
  const expanded = groups.find(group => group.key === state.prefixGroup);
  const groupButtons = groups.map(group => {
    const active = group.rows.some(row => row.prefix === state.prefix);
    const open = group.key === state.prefixGroup;
    return `<button class="prefix-group${active ? ' active' : ''}${group.wide ? ' wide' : ''}" data-group="${group.key}" aria-expanded="${open}" aria-controls="prefix-children"><span>${esc(group.label)}</span><small>${fmt(group.total)}</small></button>`;
  }).join('');
  const children = expanded ? `<section class="prefix-panel" aria-label="${esc(expanded.label)}-voorvoegsels"><div class="prefix-panel-head"><b>${esc(expanded.label)}-voorvoegsels</b><span>${fmt(expanded.total)} vormen</span></div><div class="prefix-children" id="prefix-children">${expanded.rows.map(row => `<button class="prefix ${state.prefix === row.prefix ? 'active' : ''}" data-prefix="${esc(row.prefix)}" title="${esc(prefixName(row.prefix))}" aria-pressed="${state.prefix === row.prefix}">${esc(prefixLabel(row.prefix))}<small>${fmt(row.total)}</small></button>`).join('')}</div></section>` : '';
  $('#prefixes').innerHTML = `<div class="prefix-groups">${groupButtons}</div>${children}`;
  document.querySelectorAll('.prefix-group').forEach(button => button.addEventListener('click', () => {
    state.prefixGroup = state.prefixGroup === button.dataset.group ? '' : button.dataset.group;
    renderPrefixes();
  }));
  document.querySelectorAll('.prefix').forEach(button => button.addEventListener('click', () => {
    state.prefix = button.dataset.prefix;
    state.prefixGroup = prefixGroup(state.prefix);
    state.page = 1;
    renderPrefixes();
    loadWords();
  }));
}

let wordsController;
async function loadWords() {
  wordsController?.abort();
  wordsController = new AbortController();
  $('#word-list').innerHTML = '<div class="loading">Woorden laden...</div>';
  const params = new URLSearchParams({
    select: 'id,word,prefix,label,pronunciation,gloss,lemma_count',
    order: 'word_search.asc,id.asc',
    limit: String(state.limit), offset: String((state.page - 1) * state.limit),
  });
  if (state.q) params.set('word_search', `ilike.*${state.q.toLocaleLowerCase('nl-NL')}*`);
  if (state.prefix) params.set('prefix', `eq.${state.prefix}`);
  try {
    const data = await supabase(`entries?${params}`, { signal: wordsController.signal });
    state.pages = Math.max(1, Math.ceil(data.total / state.limit));
    $('#result-count').textContent = fmt(data.total);
    $('#active-filter').textContent = state.prefix ? ` - ${prefixName(state.prefix)}` : '';
    $('#page-label').textContent = `Pagina ${state.page} van ${state.pages}`;
    $('#prev').disabled = state.page <= 1; $('#next').disabled = state.page >= state.pages;
    $('#word-list').innerHTML = data.rows.length ? data.rows.map(row => `<article class="word-row" data-id="${row.id}" data-prefix="${esc(row.prefix)}" tabindex="0" role="button" aria-label="Open ${esc(row.word)}"><div><div class="word">${esc(row.word)}</div>${row.pronunciation ? `<div class="pron">/${esc(row.pronunciation)}/</div>` : ''}</div><div><div class="kind">${esc(row.label)}</div>${row.gloss ? `<div class="gloss">${esc(row.gloss)}</div>` : ''}</div><span class="badge">${fmt(row.lemma_count)} analyses</span><span class="arrow">&rsaquo;</span></article>`).join('') : '<div class="empty">Geen woorden gevonden.</div>';
    document.querySelectorAll('.word-row').forEach(row => {
      const open = () => openWord(Number(row.dataset.id), row.dataset.prefix);
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
  } catch (error) {
    if (error.name !== 'AbortError') $('#word-list').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

const detailCache = new Map();
function prefixFile(prefix) { return [...new TextEncoder().encode(prefix)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function loadShard(prefix) {
  if (detailCache.has(prefix)) return detailCache.get(prefix);
  const response = await fetch(dataUrl(`details/${prefixFile(prefix)}.ndjson.gz`));
  if (!response.ok) throw new Error('Details niet gevonden');
  if (!globalThis.DecompressionStream) throw new Error('Decompressie niet ondersteund');
  const compressed = await response.arrayBuffer();
  let text;
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } catch {
    text = new TextDecoder().decode(compressed);
  }
  const map = new Map(text.trim().split('\n').filter(Boolean).map(line => { const item = JSON.parse(line); return [item.id, item]; }));
  if (detailCache.size >= 4) detailCache.delete(detailCache.keys().next().value);
  detailCache.set(prefix, map);
  return map;
}

function fact(label, value) { return value ? `<div class="fact"><b>${label}</b>${esc(value)}</div>` : ''; }
async function openWord(id, prefix) {
  $('#detail-content').innerHTML = '<div class="loading">Details laden...</div>';
  $('#detail-dialog').showModal();
  try {
    const data = (await loadShard(prefix)).get(id);
    if (!data) throw new Error('Detailrecord ontbreekt');
    const firstPron = data.lemmata.find(lemma => lemma.pronunciation)?.pronunciation || '';
    $('#detail-content').innerHTML = `<div class="detail-title"><h2>${esc(data.query_word)}</h2>${firstPron ? `<div class="pronunciation">/${esc(firstPron)}/</div>` : ''}<div class="detail-meta">Prefix ${esc(data.prefix_bucket)} - ${fmt(data.bytes)} bytes</div></div>${data.lemmata.map(lemma => `<section class="lemma-card"><div class="lemma-head"><h3>${esc(lemma.lemma || data.query_word)}</h3><span class="lemma-kind">${esc(lemma.label || lemma.lemma_part_of_speech)}</span></div>${lemma.pronunciation ? `<div class="pron">/${esc(lemma.pronunciation)}/</div>` : ''}${lemma.gloss ? `<p class="definition">${esc(lemma.gloss)}</p>` : ''}<div class="facts">${fact('Lemma-ID',lemma.lemma_id)}${fact('Type',lemma.entry_type)}${fact('Taalvariant',lemma.taalvariant)}${fact('Bron',lemma.subset_name)}${fact('Herkomst',lemma.source_name)}${fact('Advies',lemma.taaladvies)}</div>${lemma.paradigms.length ? `<table class="forms"><thead><tr><th>Vorm</th><th>Spelling</th><th>Afbreking</th><th>Woordsoort</th></tr></thead><tbody>${lemma.paradigms.map(form => `<tr><td>${esc(form.label)}</td><td>${esc(form.wordform)}</td><td class="hyphen">${form.hyphenation ? `[${hyphen(form.hyphenation)}]` : ''}</td><td>${esc(form.part_of_speech)}</td></tr>`).join('')}</tbody></table>` : ''}</section>`).join('')}`;
  } catch (error) { $('#detail-content').innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}

function buildLetterGrid() {
  $('#letter-grid').innerHTML = 'abcdefghijklmnopqrstuvwxyz'.split('').map(letter => `<label class="letter-choice"><input type="checkbox" value="${letter}" ${metadata.stats.letters[letter] ? '' : 'disabled'}><span>${letter.toUpperCase()}</span><small>${metadata.stats.letters[letter] ? fmt(metadata.stats.letters[letter]) : '-'}</small></label>`).join('');
  document.querySelectorAll('#letter-grid input').forEach(input => input.addEventListener('change', updateExport));
}
function selectedLetters() { return [...document.querySelectorAll('#letter-grid input:checked')].map(input => input.value); }
function updateExport() { const letters = selectedLetters(); $('#export-summary').textContent = letters.length ? letters.map(letter => letter.toUpperCase()).join(', ') : 'Kies minimaal een letter.'; $('#generate-pdf').disabled = !letters.length; }

function centeredText(page, text, y, font, size, color) {
  page.drawText(text, { x: (page.getWidth() - font.widthOfTextAtSize(text, size)) / 2, y, font, size, color });
}

async function buildCombinedPdf(letters) {
  if (!globalThis.PDFLib) throw new Error('De PDF-module kon niet worden geladen. Ververs de pagina en probeer opnieuw.');
  const { PDFDocument, StandardFonts, rgb } = globalThis.PDFLib;
  const combined = await PDFDocument.create();
  const regular = await combined.embedFont(StandardFonts.Helvetica);
  const bold = await combined.embedFont(StandardFonts.HelveticaBold);
  const italic = await combined.embedFont(StandardFonts.HelveticaOblique);
  const page = combined.addPage([595.28, 841.89]);
  const green = rgb(0.086, 0.298, 0.224);
  const dark = rgb(0.09, 0.137, 0.118);
  const muted = rgb(0.41, 0.45, 0.43);
  const paper = rgb(0.965, 0.953, 0.91);
  const letterLabel = letters.map(letter => letter.toUpperCase()).join(' + ');

  page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: paper });
  page.drawRectangle({ x: 0, y: 665, width: page.getWidth(), height: 177, color: green });
  centeredText(page, 'WOORDENLIJST NEDERLANDSE TAAL', 775, bold, 12, rgb(1, 1, 1));
  centeredText(page, 'Samengestelde boekexport', 715, regular, 15, rgb(0.88, 0.93, 0.90));
  centeredText(page, letterLabel, 487, bold, letters.length > 12 ? 25 : 34, dark);
  centeredText(page, letters.length === 1 ? '1 letter' : `${letters.length} letters`, 449, italic, 12, muted);
  page.drawLine({ start: { x: 92, y: 410 }, end: { x: 503, y: 410 }, thickness: 1, color: rgb(0.78, 0.81, 0.78) });
  centeredText(page, 'Alle lemma-pagina\'s staan per letter achter elkaar.', 370, regular, 11, muted);
  centeredText(page, 'De afzonderlijke lettervoorbladen zijn weggelaten.', 351, regular, 11, muted);
  centeredText(page, 'Woordenlijst Browser', 79, bold, 10, green);
  centeredText(page, new Date().toLocaleDateString('nl-NL'), 60, regular, 9, muted);

  combined.setTitle(`Woordenlijst - ${letterLabel}`);
  combined.setSubject(`Samengestelde woordenlijst voor ${letterLabel}`);
  combined.setCreator('Woordenlijst Browser');

  for (let index = 0; index < letters.length; index += 1) {
    const letter = letters[index];
    $('#export-summary').textContent = `Letter ${letter.toUpperCase()} laden (${index + 1}/${letters.length})...`;
    const response = await fetch(new URL(`./pdf/${letter}.pdf?v=${PDF_BUILD}`, document.baseURI));
    if (!response.ok) throw new Error(`PDF voor letter ${letter.toUpperCase()} kon niet worden geladen (${response.status}).`);
    const source = await PDFDocument.load(await response.arrayBuffer(), { ignoreEncryption: true });
    const contentPages = Array.from({ length: Math.max(0, source.getPageCount() - 1) }, (_, pageIndex) => pageIndex + 1);
    const copiedPages = await combined.copyPages(source, contentPages);
    copiedPages.forEach(copiedPage => combined.addPage(copiedPage));
  }

  $('#export-summary').textContent = 'Samengestelde PDF opslaan...';
  return combined.save({ useObjectStreams: true });
}

async function downloadCombinedPdf() {
  const letters = selectedLetters();
  if (!letters.length) return;
  if (letters.join('') === ALPHABET) {
    const link = document.createElement('a');
    link.href = new URL(`./pdf/woordenlijst-a-z-compact.pdf?v=${INTEGRAL_PDF_BUILD}`, document.baseURI);
    link.download = 'woordenlijst-a-z-compact.pdf';
    document.body.append(link);
    link.click();
    link.remove();
    $('#export-dialog').close();
    return;
  }
  const button = $('#generate-pdf');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'PDF samenstellen...';
  try {
    const bytes = await buildCombinedPdf(letters);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `woordenlijst-${letters.join('-')}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    $('#export-dialog').close();
  } catch (error) {
    $('#export-summary').textContent = `Export mislukt: ${error.message}`;
  } finally {
    button.textContent = originalLabel;
    button.disabled = !selectedLetters().length;
  }
}

function showApp() {
  $('#gate-screen').hidden = true;
  $('#app-content').hidden = false;
  $('#gate-code').value = '';

  let timer;
  $('#search').addEventListener('input', event => { clearTimeout(timer); timer = setTimeout(() => { state.q = event.target.value.trim(); state.page = 1; loadWords(); }, 220); });
  $('#page-size').addEventListener('change', event => { state.limit = Number(event.target.value); state.page = 1; loadWords(); });
  $('#prev').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadWords(); } });
  $('#next').addEventListener('click', () => { if (state.page < state.pages) { state.page += 1; loadWords(); } });
  $('#all-prefixes').addEventListener('click', () => { state.prefix = ''; state.prefixGroup = ''; state.page = 1; renderPrefixes(); loadWords(); });
  $('#close-detail').addEventListener('click', () => $('#detail-dialog').close());
  $('#detail-dialog').addEventListener('click', event => { if (event.target === $('#detail-dialog')) $('#detail-dialog').close(); });
  $('#export-open').addEventListener('click', () => { buildLetterGrid(); updateExport(); $('#export-dialog').showModal(); });
  $('#close-export').addEventListener('click', () => $('#export-dialog').close());
  $('#select-available').addEventListener('click', () => { document.querySelectorAll('#letter-grid input:not(:disabled)').forEach(input => { input.checked = true; }); updateExport(); });
  $('#clear-letters').addEventListener('click', () => { document.querySelectorAll('#letter-grid input').forEach(input => { input.checked = false; }); updateExport(); });
  $('#generate-pdf').addEventListener('click', downloadCombinedPdf);
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); } });

  Promise.all([loadMetadata(), loadWords()]).catch(error => { $('#word-list').innerHTML = `<div class="empty">${esc(error.message)}</div>`; });
}

function checkGate() {
  if (sessionStorage.getItem(GATE_KEY) === '1') { showApp(); return; }
  $('#gate-screen').hidden = false;
  $('#app-content').hidden = true;
  $('#gate-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('#gate-code').value.trim() === GATE_CODE) {
      sessionStorage.setItem(GATE_KEY, '1');
      showApp();
    } else {
      $('#gate-error').hidden = false;
      $('#gate-code').value = '';
      $('#gate-code').focus();
    }
  });
}

checkGate();
