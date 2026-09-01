'use strict';

const GATE_CODE = '8086';
const GATE_KEY = 'woordenlijst_gate_ok';
const config = window.WOORDENLIJST_CONFIG || {};
const state = { q: '', prefix: '', page: 1, limit: 40, pages: 1 };
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

function renderPrefixes() {
  $('#prefixes').innerHTML = metadata.prefixes.map(row => `<button class="prefix ${state.prefix === row.prefix ? 'active' : ''}" data-prefix="${esc(row.prefix)}">${esc(row.prefix)}<small>${fmt(row.total)}</small></button>`).join('');
  document.querySelectorAll('.prefix').forEach(button => button.addEventListener('click', () => {
    state.prefix = button.dataset.prefix; state.page = 1; renderPrefixes(); loadWords();
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
    $('#active-filter').textContent = state.prefix ? ` - prefix ${state.prefix}` : '';
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

function showApp() {
  $('#gate-screen').hidden = true;
  $('#app-content').hidden = false;
  $('#gate-code').value = '';

  let timer;
  $('#search').addEventListener('input', event => { clearTimeout(timer); timer = setTimeout(() => { state.q = event.target.value.trim(); state.page = 1; loadWords(); }, 220); });
  $('#page-size').addEventListener('change', event => { state.limit = Number(event.target.value); state.page = 1; loadWords(); });
  $('#prev').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadWords(); } });
  $('#next').addEventListener('click', () => { if (state.page < state.pages) { state.page += 1; loadWords(); } });
  $('#all-prefixes').addEventListener('click', () => { state.prefix = ''; state.page = 1; renderPrefixes(); loadWords(); });
  $('#close-detail').addEventListener('click', () => $('#detail-dialog').close());
  $('#detail-dialog').addEventListener('click', event => { if (event.target === $('#detail-dialog')) $('#detail-dialog').close(); });
  $('#export-open').addEventListener('click', () => { buildLetterGrid(); updateExport(); $('#export-dialog').showModal(); });
  $('#close-export').addEventListener('click', () => $('#export-dialog').close());
  $('#select-available').addEventListener('click', () => { document.querySelectorAll('#letter-grid input:not(:disabled)').forEach(input => { input.checked = true; }); updateExport(); });
  $('#clear-letters').addEventListener('click', () => { document.querySelectorAll('#letter-grid input').forEach(input => { input.checked = false; }); updateExport(); });
  $('#generate-pdf').addEventListener('click', () => { selectedLetters().forEach((letter, index) => setTimeout(() => { const link = document.createElement('a'); link.href = new URL(`./pdf/${letter}.pdf`, document.baseURI); link.download = `woordenlijst-${letter}.pdf`; link.click(); }, index * 250)); $('#export-dialog').close(); });
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
