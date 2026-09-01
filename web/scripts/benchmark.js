'use strict';

const { performance } = require('node:perf_hooks');

const base = process.env.BASE_URL || 'http://127.0.0.1:3080';
const routes = [
  '/', '/health', '/api/stats', '/api/prefixes', '/api/letters',
  '/api/words?limit=40&page=1',
  '/api/words?prefix=aa&limit=40&page=1',
  '/api/words?q=aan&limit=40&page=1',
];
const iterations = Number(process.env.ITERATIONS || 5);

async function measure(route) {
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    const response = await fetch(`${base}${route}`);
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    samples.push(performance.now() - start);
    bytes = body.byteLength;
  }
  samples.sort((a, b) => a - b);
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return { route, average, p50: samples[Math.floor(samples.length / 2)], max: samples.at(-1), bytes };
}

(async () => {
  const results = [];
  for (const route of routes) results.push(await measure(route));
  console.table(results.map(row => ({
    route: row.route,
    'avg ms': row.average.toFixed(1),
    'p50 ms': row.p50.toFixed(1),
    'max ms': row.max.toFixed(1),
    bytes: row.bytes,
  })));
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

