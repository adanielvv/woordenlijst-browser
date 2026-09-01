'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const port = 3187;
const base = `http://127.0.0.1:${port}`;
let child;

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Testserver startte niet binnen 15 seconden');
});

after(() => child?.kill('SIGTERM'));

test('healthcheck en security headers', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
});

test('homepage en ETag', async () => {
  const first = await fetch(`${base}/`);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Woordenlijst Browser/);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const cached = await fetch(`${base}/`, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
});

test('stats, woorden en details', async () => {
  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.ok(stats.archive.responses > 600000);
  assert.equal(stats.percent, 100);

  const words = await (await fetch(`${base}/api/words?prefix=aa&limit=10&page=1`)).json();
  assert.ok(words.rows.length > 0);
  assert.ok(words.total >= words.rows.length);

  const detail = await (await fetch(`${base}/api/words/${words.rows[0].id}`)).json();
  assert.ok(detail.response.query_word);
  assert.ok(Array.isArray(detail.lemmata));
});

