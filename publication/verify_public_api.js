'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = { window: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(root, 'docs', 'config.js'), 'utf8'),
  context,
  { filename: 'docs/config.js' },
);

const { supabaseUrl, supabaseAnonKey } = context.window.WOORDENLIJST_CONFIG || {};
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Publieke Supabase-configuratie ontbreekt');
}

const headers = {
  apikey: supabaseAnonKey,
  Authorization: `Bearer ${supabaseAnonKey}`,
};

async function verify() {
  const read = await fetch(`${supabaseUrl}/rest/v1/entries?select=id,word&limit=1`, {
    headers: { ...headers, Prefer: 'count=exact' },
  });
  const rows = await read.json().catch(() => []);
  if (![200, 206].includes(read.status) || !Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Publieke SELECT faalde (${read.status}, ${rows.length} rijen)`);
  }

  const total = Number((read.headers.get('content-range') || '*/0').split('/')[1]);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error('Exacte publieke telling ontbreekt');
  }

  // An empty row cannot satisfy NOT NULL constraints. A correct deployment
  // rejects it earlier because anon has no INSERT grant or policy.
  const write = await fetch(`${supabaseUrl}/rest/v1/entries`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (![401, 403].includes(write.status)) {
    throw new Error(`Publieke write is niet afgeschermd (status ${write.status})`);
  }

  console.log(JSON.stringify({ select: read.status, rows: total, insert: write.status }));
}

verify().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
