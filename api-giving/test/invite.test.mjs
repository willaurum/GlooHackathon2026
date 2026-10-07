// Creating a church from Tekton needs an invite code (TEKTON_INVITE_CODES); without one, public signup stays off.
// Runs the real handlers with in-memory SQLite, like test/local-worker.mjs:
//   node --test api-giving/test/invite.test.mjs   (Node 22.13+, after npm ci in api-giving/)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { transform } from 'esbuild';

const source = (await readFile(new URL('../index.ts', import.meta.url), 'utf8'))
  .replace(/import \{ DurableObject \} from 'cloudflare:workers';/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { default: handler, GivingDO, GivingRegistry } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

function namespace(Type, env) {
  const instances = new Map();
  return { getByName(name) {
    if (!instances.has(name)) {
      const db = new DatabaseSync(':memory:');
      const sql = { exec(query, ...args) {
        const stmt = db.prepare(query);
        const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      } };
      const storage = { sql, transactionSync(fn) {
        db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
      } };
      instances.set(name, new Type({ storage }, env));
    }
    return instances.get(name);
  } };
}

function worker(codes) {
  const env = { ALLOWED_ORIGIN: 'http://localhost:5199', PUBLIC_ORIGIN: 'http://127.0.0.1:8803', ADMIN_KEY: 'unused-demo-key',
    STRIPE_KEY_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    ...(codes === undefined ? {} : { TEKTON_INVITE_CODES: codes }) };
  env.GIVING = namespace(GivingDO, env);
  env.GIVING_REGISTRY = namespace(GivingRegistry, env);
  return async (body, ip = '10.0.0.1') => {
    const response = await handler.fetch(new Request('http://127.0.0.1:8803/api/churches', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5199', 'cf-connecting-ip': ip },
      body: JSON.stringify(body) }), env);
    return { status: response.status, data: await response.json() };
  };
}

const church = (extra = {}) => ({ name: 'Cedar Hollow Church', city: 'Millbrook', ownerName: 'Pat Pastor',
  ownerEmail: 'Pat@Cedar.test', password: 'a long password 1', ...extra });

test('without the secret, public registration stays off whatever the code', async () => {
  const post = worker();
  for (const inviteCode of [undefined, '', 'anything-at-all']) {
    const r = await post(church({ inviteCode }));
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'Public church registration is not available on this site.');
  }
  assert.equal((await worker('short')(church({ inviteCode: 'short' }))).status, 403, 'codes under 8 characters do not count');
});

test('a right code creates the church and its owner; a wrong or missing one does not', async () => {
  const post = worker(' first-code-123 , second-code-456 ');
  let r = await post(church());
  assert.equal(r.status, 403);
  assert.equal(r.data.inviteRequired, true);
  r = await post(church({ inviteCode: 'second-code-45' }));
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'That invite code is not right.');
  r = await post(church({ inviteCode: ' second-code-456 ' }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.slug, 'cedar-hollow-church');
  assert.ok(r.data.token.length > 20);
  r = await post(church({ inviteCode: 'first-code-123' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.slug, 'cedar-hollow-church-2', 'the same name gets its own address');
});

test('the details are checked before anything is created', async () => {
  const post = worker('first-code-123');
  for (const [extra, message] of [[{ name: 'AB' }, 'Church name'], [{ ownerEmail: 'nope' }, 'valid email'],
    [{ password: 'short' }, 'at least 10'], [{ ownerName: '' }, 'your name']]) {
    const r = await post(church({ inviteCode: 'first-code-123', ...extra }));
    assert.equal(r.status, 400);
    assert.match(r.data.error, new RegExp(message, 'i'));
  }
});

test('wrong codes are limited per address', async () => {
  const post = worker('first-code-123');
  for (let i = 0; i < 5; i++) assert.equal((await post(church({ inviteCode: 'guess-' + i }), '10.9.9.9')).status, 403);
  const r = await post(church({ inviteCode: 'first-code-123' }), '10.9.9.9');
  assert.equal(r.status, 429);
  assert.equal((await post(church({ inviteCode: 'first-code-123' }), '10.9.9.8')).status, 201);
});
