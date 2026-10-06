// Deterministic concurrency checks using the real handlers and SQLite (Node 22.13+).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = (await readFile(new URL('../index.ts', import.meta.url), 'utf8'))
  .replace(/import \{ DurableObject \} from 'cloudflare:workers';/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { GivingDO } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const realCrypto = globalThis.crypto;
let nextPause;
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
  getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
  randomUUID: realCrypto.randomUUID.bind(realCrypto),
  subtle: new Proxy(realCrypto.subtle, { get(target, name) {
    if (name === 'deriveBits') return async (...args) => {
      const pause = nextPause; nextPause = undefined;
      const result = await target.deriveBits(...args);
      if (pause) { pause.enter(); await pause.release; }
      return result;
    };
    const value = Reflect.get(target, name, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }),
} });
function pauseCrypto() {
  let enter, resume;
  const entered = new Promise(r => { enter = r; });
  const release = new Promise(r => { resume = r; });
  nextPause = { enter, release };
  return { entered, resume };
}
async function fixture() {
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
  const first = await worker.init('race-church', 'Fictional Race Church', '', 'usd', 'fixture password 1', 'First Owner', 'first@example.org');
  async function call(method, path, body, token) {
    const headers = { 'x-church-slug': 'race-church', 'content-type': 'application/json', 'cf-connecting-ip': realCrypto.randomUUID() };
    if (token) headers.authorization = 'Bearer ' + token;
    const response = await worker.fetch(new Request('https://example.org/c/admin' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, data: await response.json() };
  }
  return { db, call, token: first.token };
}

test('an owner removed during password hashing cannot finish adding an account', async () => {
  const { db, call, token } = await fixture();
  try {
    const added = await call('POST', '/users', { name: 'Second Owner', email: 'second@example.org', role: 'owner', password: 'fixture password 2' }, token);
    const firstId = added.data.users.find(u => u.you).id;
    const second = await call('POST', '/login', { email: 'second@example.org', password: 'fixture password 2' });
    const pause = pauseCrypto();
    const pending = call('POST', '/users', { name: 'Replacement Owner', email: 'replacement@example.org', role: 'owner', password: 'fixture password 3' }, token);
    await pause.entered;
    assert.equal((await call('DELETE', '/users/' + firstId, undefined, second.data.token)).status, 200);
    pause.resume();
    assert.equal((await pending).status, 401);
    assert.equal((await call('POST', '/login', { email: 'replacement@example.org', password: 'fixture password 3' })).status, 401);
  } finally { db.close(); }
});

test('a login verifying the old password cannot outlive password rotation', async () => {
  const { db, call, token } = await fixture();
  try {
    const pause = pauseCrypto();
    const pending = call('POST', '/login', { email: 'first@example.org', password: 'fixture password 1' });
    await pause.entered;
    assert.equal((await call('POST', '/password', { current: 'fixture password 1', next: 'fixture replacement 1' }, token)).status, 200);
    pause.resume();
    assert.equal((await pending).status, 401);
    assert.equal((await call('POST', '/login', { email: 'first@example.org', password: 'fixture replacement 1' })).status, 200);
  } finally { db.close(); }
});
