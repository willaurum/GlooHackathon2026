// Local-only test adapter. Never deploy this file; production uses index.ts.
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { transform } from 'esbuild';
import { unstable_readConfig } from 'wrangler';
const source = (await readFile('index.ts', 'utf8')).replace(/import \{ DurableObject \} from 'cloudflare:workers';/, 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { default: handler, GivingDO, GivingRegistry } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const env = { ...unstable_readConfig({ config: 'wrangler.jsonc' }).vars };
env.STRIPE_KEY_ENCRYPTION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
env.STRIPE_API_BASE = 'http://127.0.0.1:12111';
env.ALLOWED_ORIGIN = 'http://localhost:5199';
env.PUBLIC_ORIGIN = 'http://127.0.0.1:8803';
if (process.env.TEKTON_INVITE_CODES) env.TEKTON_INVITE_CODES = process.env.TEKTON_INVITE_CODES;
if (process.env.PLATFORM_KEY) env.PLATFORM_ADMIN_KEY = process.env.PLATFORM_KEY;
function namespace(Type) {
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
        db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      } };
      instances.set(name, new Type({ storage }, env));
    }
    return instances.get(name);
  } };
}
env.GIVING = namespace(GivingDO); env.GIVING_REGISTRY = namespace(GivingRegistry);
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = new Request('http://127.0.0.1:8803' + req.url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) });
    let response;
    if (req.url === '/__fixtures/churches' && req.method === 'POST') {
      const fixture = JSON.parse(body.toString());
      const registry = env.GIVING_REGISTRY.getByName('registry');
      const reserved = await registry.reserve(fixture.name, fixture.city || '', crypto.randomUUID());
      if (!reserved.slug) throw new Error('Fixture slug reservation failed');
      const result = await env.GIVING.getByName('church:' + reserved.slug).init(reserved.slug, fixture.name, fixture.city || '', fixture.currency || 'usd', fixture.password, fixture.ownerName || '', fixture.ownerEmail?.toLowerCase() || '');
      response = Response.json({ slug: reserved.slug, name: fixture.name, token: result.token }, { status: 201 });
    } else response = await handler.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) { res.writeHead(500); res.end('Local adapter error: ' + e.message); }
});
server.listen(Number(process.env.LOCAL_TEST_PORT ?? 8803), '127.0.0.1', () => console.log('Direct SQLite adapter ready on ' + server.address().port));
