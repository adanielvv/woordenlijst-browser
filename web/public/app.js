'use strict';

const state = { q: '', prefix: '', page: 1, limit: 40, pages: 1 };
const $ = selector => document.querySelector(selector);
const fmt = value => new Intl.NumberFormat('nl-NL').format(value || 0);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const hyphen = value => esc(value || '').replaceAll('|', '·');

async function api(path, { signal } = {}) {
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function loadStats() {
  const data = await api('/api/stats');
  const a = data.archive;
  $('#stats').innerHTML = `
    <div class="stat"><strong>${fmt(a.responses)}</strong><span>XML-responses</span></div>
    <div class="stat"><strong>${fmt(a.lemmata)}</strong><span>Lemma’s</span></div>
    <div class="stat"><strong>${fmt(a.paradigms)}</strong><span>Woordvormen</span></div>
    <div class="stat"><strong>${fmt(a.xml_nodes)}</strong><span>XML-nodes</span></div>`;
  $('#progress-bar').style.width = `${Math.min(100, data.percent)}%`;
  $('#progress-text').textContent = `${data.percent}%`;
  $('#progress-detail').textContent = `${fmt(data.complete)} van ${fmt(data.discovered)} ontdekte zoekvormen opgeslagen`;
  const running = data.run?.status === 'running';
  $('#run-pill').innerHTML = `<span class="pulse"></span><span>${running ? `Bezig met ${esc(data.run.current_prefix || data.run.current_letter || 'archief')}` : esc(data.run?.status || 'Downloader niet actief')}</span>`;
  $('#run-pill').classList.toggle('is-complete', !running);
  return data;
}

async function loadPrefixes() {
  const rows = await api('/api/prefixes');
  $('#prefixes').innerHTML = rows.map(row => `
    <button class="prefix ${state.prefix === row.prefix ? 'active' : ''}" data-prefix="${esc(row.prefix)}">
      ${esc(row.prefix)}<small>${fmt(row.complete)}/${fmt(row.total)}</small>
    </button>`).join('');
  document.querySelectorAll('.prefix').forEach(button => button.addEventListener('click', () => {
    state.prefix = button.dataset.prefix; state.page = 1; loadPrefixes(); loadWords();
  }));
}

let availableLetters = [];
async function loadLetters() {
  availableLetters = await api('/api/letters');
  const counts = Object.fromEntries(availableLetters.map(item => [item.letter, item.lemmata]));
  $('#letter-grid').innerHTML = 'abcdefghijklmnopqrstuvwxyz'.split('').map(letter => `
    <label class="letter-choice"><input type="checkbox" value="${letter}" ${counts[letter] ? '' : 'disabled'}>
      <span>${letter.toUpperCase()}</span><small>${counts[letter] ? fmt(counts[letter]) : '—'}</small></label>`).join('');
  document.querySelectorAll('#letter-grid input').forEach(input => input.addEventListener('change', updateExport));
}

function selectedLetters() {
  return [...document.querySelectorAll('#letter-grid input:checked')].map(input => input.value);
}

function updateExport() {
  const selected = selectedLetters();
  const counts = Object.fromEntries(availableLetters.map(item => [item.letter, item.lemmata]));
  const total = selected.reduce((sum, letter) => sum + (counts[letter] || 0), 0);
  $('#export-summary').textContent = selected.length
    ? `${selected.map(letter => letter.toUpperCase()).join(', ')} · ${fmt(total)} unieke lemma’s in de huidige momentopname`
    : 'Kies minimaal één letter.';
  $('#generate-pdf').disabled = !selected.length;
}

let wordController;
async function loadWords() {
  wordController?.abort();
  wordController = new AbortController();
  $('#word-list').innerHTML = '<div class="loading">Woorden laden…</div>';
  const params = new URLSearchParams({ q: state.q, prefix: state.prefix, page: state.page, limit: state.limit });
  let data;
  try {
    data = await api(`/api/words?${params}`, { signal: wordController.signal });
  } catch (error) {
    if (error.name === 'AbortError') return;
    throw error;
  }
  state.pages = data.pages;
  $('#result-count').textContent = fmt(data.total);
  $('#active-filter').textContent = state.prefix ? `· prefix ${state.prefix}` : '';
  $('#page-label').textContent = `Pagina ${data.page} van ${data.pages}`;
  $('#prev').disabled = data.page <= 1; $('#next').disabled = data.page >= data.pages;
  if (!data.rows.length) {
    $('#word-list').innerHTML = '<div class="empty">Geen opgeslagen woorden gevonden.</div>'; return;
  }
  $('#word-list').innerHTML = data.rows.map(row => `
    <article class="word-row" data-id="${row.id}" tabindex="0" role="button" aria-label="Open ${esc(row.query_word)}">
      <div><div class="word">${esc(row.query_word)}</div>${row.pronunciation ? `<div class="pron">/${esc(row.pronunciation)}/</div>` : ''}</div>
      <div><div class="kind">${esc(row.label || 'Woordvorm')}</div>${row.gloss ? `<div class="gloss">${esc(row.gloss)}</div>` : ''}</div>
      <span class="badge">${row.lemma_count} ${row.lemma_count === 1 ? 'lemma' : 'lemma’s'}</span><span class="arrow">›</span>
    </article>`).join('');
  document.querySelectorAll('.word-row').forEach(row => {
    const open = () => openWord(row.dataset.id);
    row.addEventListener('click', open); row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

function fact(label, value) { return value ? `<div class="fact"><b>${label}</b>${esc(value)}</div>` : ''; }

async function openWord(id) {
  const data = await api(`/api/words/${id}`);
  const r = data.response;
  const firstPron = data.lemmata.find(l => l.pronunciation)?.pronunciation || '';
  $('#detail-content').innerHTML = `
    <div class="detail-title"><h2>${esc(r.query_word)}</h2>${firstPron ? `<div class="pronunciation">/${esc(firstPron)}/</div>` : ''}
      <div class="detail-meta">Prefix ${esc(r.prefix_bucket)} · ${fmt(r.bytes)} bytes · opgeslagen ${new Date(r.downloaded_at).toLocaleString('nl-NL')}</div></div>
    ${data.lemmata.map(lemma => `
      <section class="lemma-card"><div class="lemma-head"><h3>${esc(lemma.lemma || r.query_word)}</h3><span class="lemma-kind">${esc(lemma.label || lemma.lemma_part_of_speech)}</span></div>
        ${lemma.pronunciation ? `<div class="pron">/${esc(lemma.pronunciation)}/</div>` : ''}${lemma.gloss ? `<p class="definition">${esc(lemma.gloss)}</p>` : ''}
        <div class="facts">${fact('Lemma-ID',lemma.lemma_id)}${fact('Type',lemma.entry_type)}${fact('Taalvariant',lemma.taalvariant)}${fact('Bronset',lemma.subset_name)}${fact('Herkomst',lemma.source_name)}${fact('Advies',lemma.taaladvies)}</div>
        ${lemma.paradigms.length ? `<table class="forms"><thead><tr><th>Vorm</th><th>Spelling</th><th>Afbreking</th><th>Woordsoort</th></tr></thead><tbody>${lemma.paradigms.map(p => `<tr><td>${esc(p.label)}</td><td>${esc(p.wordform)}</td><td class="hyphen">${p.hyphenation ? `[${hyphen(p.hyphenation)}]` : ''}</td><td>${esc(p.part_of_speech)}</td></tr>`).join('')}</tbody></table>` : ''}
      </section>`).join('')}
    <div class="detail-actions"><a href="/api/words/${id}/xml" target="_blank">Open ruwe XML</a><button id="show-nodes">Toon alle XML-nodes</button></div><div class="xml-panel" id="xml-panel">Laden…</div>`;
  $('#detail-dialog').showModal();
  $('#show-nodes').addEventListener('click', async () => {
    const panel = $('#xml-panel'); panel.classList.toggle('open');
    if (panel.dataset.loaded) return;
    const nodes = await api(`/api/words/${id}/nodes`);
    panel.innerHTML = nodes.map(n => `<div class="xml-node"><b>${esc(n.tag)}</b> ${esc(n.text_value)}<small>${esc(n.xpath)}</small></div>`).join('');
    panel.dataset.loaded = '1';
  });
}

let timer;
$('#search').addEventListener('input', event => { clearTimeout(timer); timer = setTimeout(() => { state.q = event.target.value; state.page = 1; loadWords(); }, 220); });
$('#page-size').addEventListener('change', event => { state.limit = Number(event.target.value); state.page = 1; loadWords(); });
$('#prev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadWords(); scrollTo(0, 400); } });
$('#next').addEventListener('click', () => { if (state.page < state.pages) { state.page++; loadWords(); scrollTo(0, 400); } });
$('#all-prefixes').addEventListener('click', () => { state.prefix = ''; state.page = 1; loadPrefixes(); loadWords(); });
$('#close-detail').addEventListener('click', () => $('#detail-dialog').close());
$('#detail-dialog').addEventListener('click', event => { if (event.target === $('#detail-dialog')) $('#detail-dialog').close(); });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); } });

$('#export-open').addEventListener('click', async () => {
  await loadLetters(); updateExport(); $('#export-dialog').showModal();
});
$('#close-export').addEventListener('click', () => $('#export-dialog').close());
$('#export-dialog').addEventListener('click', event => {
  if (event.target === $('#export-dialog')) $('#export-dialog').close();
});
$('#select-available').addEventListener('click', () => {
  document.querySelectorAll('#letter-grid input:not(:disabled)').forEach(input => { input.checked = true; });
  updateExport();
});
$('#clear-letters').addEventListener('click', () => {
  document.querySelectorAll('#letter-grid input').forEach(input => { input.checked = false; });
  updateExport();
});
$('#generate-pdf').addEventListener('click', () => {
  const letters = selectedLetters();
  if (!letters.length) return;
  window.location.href = `/api/export.pdf?letters=${encodeURIComponent(letters.join(','))}`;
  $('#export-dialog').close();
});

async function initialize() {
  try {
    const [stats] = await Promise.all([loadStats(), loadPrefixes(), loadWords()]);
    if (stats.run?.status === 'running') {
      setInterval(async () => {
        const update = await loadStats().catch(console.error);
        if (update?.run?.status === 'running') loadPrefixes().catch(console.error);
      }, 30000);
    }
  } catch (error) {
    console.error(error);
    $('#word-list').innerHTML = `<div class="empty">Kon de database niet laden: ${esc(error.message)}</div>`;
  }
}

initialize();
