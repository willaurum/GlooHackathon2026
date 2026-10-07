// Anonymizing a gift on the demo church: owners only, demo church only, amounts and totals unchanged.
// Uses the real handlers on in-memory SQLite (Node 22.13+). Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = (await readFile(new URL('../index.ts', import.meta.url), 'utf8'))
  .replace(/import \{ DurableObject \} from 'cloudflare:workers';/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { GivingDO } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

async function fixture({ demo }) {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...params) {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const worker = new GivingDO({ storage: { sql, transactionSync: fn => {
    db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } } }, {});
  const first = await worker.init('anon-church', 'Fictional Anon Church', '', 'usd', 'fixture password 1', 'First Owner', 'first@example.org');
  if (demo) db.prepare('UPDATE church SET demo_locked = 1 WHERE id = 1').run();
  const gift = db.prepare("INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, created_at, cadence, subscription_id) VALUES (?, 'general', ?, ?, ?, 0, ?, 'demo', ?, ?, ?)");
  gift.run('g1', 2500, 'Real Teammate', 'teammate@example.org', 'demo_1', '2026-10-01T12:00:00Z', 'month', 'sub_1');
  gift.run('g2', 2500, 'Real Teammate', 'teammate@example.org', 'in_2', '2026-11-01T12:00:00Z', 'month', 'sub_1'); // its renewal
  gift.run('g3', 1000, 'Other Donor', 'other@example.org', 'demo_3', '2026-10-02T12:00:00Z', 'once', '');
  async function call(method, path, body, token) {
    const headers = { 'x-church-slug': 'anon-church', 'content-type': 'application/json', 'cf-connecting-ip': crypto.randomUUID() };
    if (token) headers.authorization = 'Bearer ' + token;
    const response = await worker.fetch(new Request('https://example.org/c/admin' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, data: await response.json() };
  }
  return { db, call, token: first.token };
}

const totals = db => db.prepare('SELECT COUNT(*) AS n, SUM(amount) AS sum FROM gifts').get();

test('an owner on the demo church anonymizes a gift and its renewals, and nothing else changes', async () => {
  const { db, call, token } = await fixture({ demo: true });
  const before = totals(db);
  const r = await call('POST', '/donations/g1/anonymize', {}, token);
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.donations.map(d => [d.id, d]));
  for (const id of ['g1', 'g2']) {
    assert.equal(byId[id].name, 'Demo donor');
    assert.equal(byId[id].email, '');
    assert.equal(byId[id].amount, 2500);
  }
  assert.equal(byId.g3.name, 'Other Donor');
  assert.equal(byId.g3.email, 'other@example.org');
  assert.deepEqual(totals(db), before);
  assert.equal(JSON.stringify(r.data).includes('teammate@example.org'), false);
});

test('a site admin, a stranger, an unknown gift and a real church are all refused', async () => {
  const { call, token } = await fixture({ demo: true });
  const added = await call('POST', '/users', { name: 'Site Admin', email: 'admin@example.org', role: 'site_admin', password: 'fixture password 2' }, token);
  assert.equal(added.status, 200);
  const login = await call('POST', '/login', { email: 'admin@example.org', password: 'fixture password 2' });
  assert.equal(login.status, 200);
  assert.equal((await call('POST', '/donations/g1/anonymize', {}, login.data.token)).status, 403);
  assert.equal((await call('POST', '/donations/g1/anonymize', {})).status, 401);
  assert.equal((await call('POST', '/donations/nope/anonymize', {}, token)).status, 404);

  const real = await fixture({ demo: false });
  const refused = await real.call('POST', '/donations/g1/anonymize', {}, real.token);
  assert.equal(refused.status, 403);
  assert.equal(real.db.prepare("SELECT name FROM gifts WHERE id = 'g1'").get().name, 'Real Teammate');
});
