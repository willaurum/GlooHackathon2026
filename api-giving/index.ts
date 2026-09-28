// Donate / Giving area.
//
// A church-agnostic giving stack on the Cloudflare Workers stack: a pure-JS
// Worker routes to a single SQLite Durable Object. Stripe is ordinary HTTPS —
// the Worker calls the Stripe API directly and no card data ever touches us.
//
// With no STRIPE_SECRET_KEY set the object runs a demo gateway: gifts are
// recorded with status "demo", checkout is faked with a simulated confirmation
// round-trip, and the page shows a "demo mode" banner. When a real or test
// key is present the same code performs live Stripe Checkout and verifies the
// checkout.session.completed webhook.

import { DurableObject } from 'cloudflare:workers';

type Cause = {
  id: string;
  name: string;
  description?: string;
  presets?: number[]; // minor units (cents)
};

type Goal = { id: string; title: string; amount: number };

type Secrets = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };
type GivingEnv = Env & Secrets;

// ALLOWED_ORIGIN is a comma-separated list of frontend origins. The first is the default.
function allowedOrigins(env: GivingEnv): string[] {
  return String(env.ALLOWED_ORIGIN).split(',').map((o) => o.trim()).filter(Boolean);
}

/** The request's Origin when it is allowed, otherwise the default origin. */
function frontendOrigin(request: Request, env: GivingEnv): string {
  const list = allowedOrigins(env);
  const origin = request.headers.get('origin') || '';
  return list.includes(origin) ? origin : list[0];
}

type GiftRow = {
  id: string;
  cause_id: string;
  amount: number;
  name: string;
  email: string;
  anonymous: number;
  session_id: string;
  status: string;
  created_at: string;
};

const CAUSE_DEFAULTS: Cause[] = [
  { id: 'general', name: 'General Fund', description: 'Support the day-to-day work and mission.', presets: [100, 5000, 10000, 15000] },
];

const DEFAULT_PRESETS = [100, 5000, 10000, 15000]; // $1, $50, $100, $150
const DEFAULT_GOAL: Goal = { id: 'main', title: 'Support the mission', amount: 250000 }; // $2,500

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

// Constant-time compare so a wrong admin key does not leak via timing.
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function normalizeCause(c: any): Cause {
  return {
    id: String(c.id || '').slice(0, 40),
    name: String(c.name || '').slice(0, 120),
    description: c.description ? String(c.description).slice(0, 500) : undefined,
    presets: Array.isArray(c.presets) ? c.presets.map((n: any) => Math.max(0, Math.round(Number(n) || 0))).filter(Boolean).slice(0, 12) : undefined,
  };
}

// HMAC-SHA256 of `${timestamp}.${payload}` as hex — the value Stripe signs.
async function stripeSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class GivingDO extends DurableObject<GivingEnv> {
  constructor(ctx: any, env: GivingEnv) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK (id = 1), church_name TEXT NOT NULL, currency TEXT NOT NULL, presets TEXT NOT NULL, goal TEXT NOT NULL, causes TEXT NOT NULL, price_map TEXT NOT NULL, webhook_secret TEXT NOT NULL)'
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, cause_id TEXT NOT NULL, amount INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL)'
    );
    sql.exec('CREATE TABLE IF NOT EXISTS rate (ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)');
  }

  get #sql() {
    return this.ctx.storage.sql;
  }

  #mode(): 'demo' | 'live' {
    return this.env.STRIPE_SECRET_KEY ? 'live' : 'demo';
  }

  #admin(request: Request): boolean {
    const key = this.env.ADMIN_KEY;
    if (!key) return false;
    const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    return !!m && ctEqual(m[1], key);
  }

  #readRaw() {
    let row = this.#sql
      .exec('SELECT church_name, currency, presets, goal, causes, price_map, webhook_secret FROM config WHERE id = 1')
      .toArray()[0];
    if (!row) {
      this.#sql.exec(
        'INSERT INTO config (id, church_name, currency, presets, goal, causes, price_map, webhook_secret) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
        'Grace Community',
        'usd',
        JSON.stringify(DEFAULT_PRESETS),
        JSON.stringify(DEFAULT_GOAL),
        JSON.stringify(CAUSE_DEFAULTS),
        '{}',
        ''
      );
      row = this.#sql
        .exec('SELECT church_name, currency, presets, goal, causes, price_map, webhook_secret FROM config WHERE id = 1')
        .toArray()[0];
    }
    const num = (v: any, d: number[]) => (Array.isArray(v) ? v.map((n: any) => Math.max(0, Math.round(Number(n) || 0))).filter(Boolean) : d);
    const goal = (() => {
      try {
        const g = JSON.parse(String(row.goal));
        return { id: String(g.id || 'main'), title: String(g.title || 'Goal'), amount: Math.max(0, Math.round(Number(g.amount) || 0)) };
      } catch {
        return { ...DEFAULT_GOAL };
      }
    })();
    const price_map = (() => {
      try {
        return JSON.parse(String(row.price_map || '{}'));
      } catch {
        return {};
      }
    })();
    return {
      church_name: String(row.church_name),
      currency: String(row.currency),
      presets: num(row.presets, DEFAULT_PRESETS),
      goal,
      causes: (() => {
        try {
          return JSON.parse(String(row.causes));
        } catch {
          return [];
        }
      })() as Cause[],
      price_map,
      webhook_secret: String(row.webhook_secret || ''),
    };
  }

  #raised() {
    const r = this.#sql.exec("SELECT COALESCE(SUM(amount), 0) AS n FROM gifts WHERE status IN ('completed', 'demo')").toArray()[0];
    return Number(r ? r.n : 0);
  }

  #publicConfig(r: any) {
    return {
      churchName: r.church_name,
      currency: r.currency,
      presets: r.presets,
      goal: r.goal,
      raised: this.#raised(),
      causes: r.causes,
      mode: this.#mode(),
    };
  }

  async health(): Promise<Response> {
    return json({ ok: true, mode: this.#mode(), ts: new Date().toISOString() });
  }

  async readConfig(): Promise<Response> {
    return json(this.#publicConfig(this.#readRaw()));
  }

  async writeConfig(request: Request): Promise<Response> {
    if (!this.#admin(request)) return json({ error: 'Admin key required.' }, 403);
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be valid JSON.' }, 400);
    }
    const cur = this.#readRaw();
    const next = {
      church_name: typeof body.churchName === 'string' && body.churchName.trim() ? body.churchName.trim().slice(0, 120) : cur.church_name,
      currency: typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim().toLowerCase().slice(0, 8) : cur.currency,
      presets: Array.isArray(body.presets) ? body.presets.map((n: any) => Math.max(0, Math.round(Number(n) || 0))).filter(Boolean).slice(0, 12) : cur.presets,
      goal: body.goal
        ? {
            id: String(body.goal.id || cur.goal.id),
            title: String(body.goal.title || cur.goal.title).slice(0, 120),
            amount: Math.max(0, Math.round(Number(body.goal.amount) || cur.goal.amount)),
          }
        : cur.goal,
      causes: Array.isArray(body.causes) ? body.causes.map(normalizeCause) : cur.causes,
    };
    this.#sql.exec(
      'UPDATE config SET church_name = ?, currency = ?, presets = ?, goal = ?, causes = ? WHERE id = 1',
      next.church_name,
      next.currency,
      JSON.stringify(next.presets),
      JSON.stringify(next.goal),
      JSON.stringify(next.causes)
    );
    return json(this.#publicConfig({ ...cur, ...next }));
  }

  async recentGifts(): Promise<Response> {
    const rows = this.#sql
      .exec("SELECT name, anonymous, amount, created_at FROM gifts WHERE status IN ('completed', 'demo') ORDER BY created_at DESC LIMIT 15")
      .toArray();
    const list = rows.map((r) => ({
      name: Number(r.anonymous) ? 'Anonymous' : String(r.name),
      amount: Number(r.amount),
      created_at: String(r.created_at),
    }));
    return json({ list });
  }

  #rateOk(ip: string, now: number): boolean {
    const MAX = 10;
    const WINDOW = 60_000;
    return this.ctx.storage.transactionSync(() => {
      const row = this.#sql.exec('SELECT window_start, count FROM rate WHERE ip = ?', ip).toArray()[0];
      if (!row) {
        this.#sql.exec('INSERT INTO rate (ip, window_start, count) VALUES (?, ?, 1)', ip, now);
        return true;
      }
      if (now - row.window_start >= WINDOW) {
        this.#sql.exec('UPDATE rate SET window_start = ?, count = 1 WHERE ip = ?', now, ip);
        return true;
      }
      if (row.count >= MAX) return false;
      this.#sql.exec('UPDATE rate SET count = count + 1 WHERE ip = ?', ip);
      return true;
    });
  }

  async createCheckout(request: Request): Promise<Response> {
    const now = Date.now();
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'anon';
    if (!this.#rateOk(ip, now)) return json({ error: 'Too many requests. Please slow down.' }, 429);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be valid JSON.' }, 400);
    }
    const amount = Math.round(Number(body.amount));
    const anonymous = body.anonymous ? 1 : 0;
    const name = anonymous ? 'Anonymous' : String(body.name || '').trim().slice(0, 120);
    const email = anonymous ? '' : String(body.email || '').trim().slice(0, 200);
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'Choose or enter an amount.' }, 400);
    if (!anonymous) {
      if (!name) return json({ error: 'Please add your name, or choose anonymous.' }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Please add a valid email, or choose anonymous.' }, 400);
    }

    const cfg = this.#readRaw();
    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    const mode = this.#mode();

    if (mode === 'demo') {
      const sessionId = 'demo_' + id;
      this.#sql.exec(
        'INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, cfg.goal.id, amount, name, email, anonymous, sessionId, 'demo', created
      );
      return json({ id, url: frontendOrigin(request, this.env) + '/give?session_id=' + sessionId + '&status=demo', demo: true, mode });
    }

    // Live Stripe Checkout. Use a pre-made price for a known preset, otherwise
    // build the amount inline so any custom amount works.
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('currency', cfg.currency);
    form.set('line_items[0][quantity]', '1');
    const priceId = cfg.price_map[String(amount)];
    if (priceId) {
      form.set('line_items[0][price]', priceId);
    } else {
      form.set('line_items[0][price_data][currency]', cfg.currency);
      form.set('line_items[0][price_data][unit_amount]', String(amount));
      form.set('line_items[0][price_data][product_data][name]', cfg.goal.title);
    }
    form.set('metadata[anonymous]', String(anonymous));
    form.set('metadata[name]', name);
    form.set('metadata[email]', email);
    const origin = frontendOrigin(request, this.env);
    form.set('success_url', origin + '/give?session_id={CHECKOUT_SESSION_ID}&status=complete');
    form.set('cancel_url', origin + '/give?status=cancel');

    let resp: Response;
    try {
      resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer ' + this.env.STRIPE_SECRET_KEY },
        body: form,
      });
    } catch {
      return json({ error: 'Could not reach the payment provider.' }, 502);
    }
    const data = await resp.json().catch(() => ({} as any));
    if (!resp.ok || !data.url) return json({ error: (data && data.error && data.error.message) || 'Checkout could not be started.' }, 502);
    this.#sql.exec(
      'INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, cfg.goal.id, amount, name, email, anonymous, data.id, 'pending', created
    );
    return json({ id, url: data.url, demo: false, mode });
  }

  async confirm(sessionId: string): Promise<Response> {
    const r = this.#sql.exec('SELECT * FROM gifts WHERE session_id = ? OR id = ?', sessionId, sessionId).toArray()[0] as GiftRow | undefined;
    if (!r) return json({ error: 'Not found.' }, 404);
    const cfg = this.#readRaw();
    return json({
      status: r.status,
      amount: r.amount,
      currency: cfg.currency,
      causeId: r.cause_id,
      causeName: cfg.goal.id === r.cause_id ? cfg.goal.title : r.cause_id,
      anonymous: Number(r.anonymous) ? true : false,
      demo: r.status === 'demo',
    });
  }

  async adminGifts(request: Request): Promise<Response> {
    if (!this.#admin(request)) return json({ error: 'Admin key required.' }, 403);
    const rows = this.#sql.exec('SELECT id, cause_id, amount, name, email, anonymous, session_id, status, created_at FROM gifts ORDER BY created_at DESC').toArray();
    return json({ gifts: rows });
  }

  async stripeWebhook(request: Request): Promise<Response> {
    const raw = await request.text();
    const secret = this.env.STRIPE_WEBHOOK_SECRET || this.#readRaw().webhook_secret;
    const header = request.headers.get('stripe-signature');
    if (!secret || !header) return json({ error: 'Missing signature.' }, 400);
    const t = Number(/t=(\d+)/.exec(header)?.[1] || 0);
    const v1 = /v1=([0-9a-fA-F]+)/.exec(header)?.[1];
    if (!t || !v1) return json({ error: 'Malformed signature.' }, 400);
    if (Math.abs(Date.now() - t * 1000) > 5 * 60 * 1000) return json({ error: 'Signature too old.' }, 400);
    const expected = await stripeSignature(secret, t, raw);
    if (!ctEqual(expected, v1)) return json({ error: 'Signature mismatch.' }, 400);
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      return json({ error: 'Bad payload.' }, 400);
    }
    if (evt?.type === 'checkout.session.completed') {
      const s = evt.data.object;
      const meta = s.metadata || {};
      const status = s.payment_status === 'unpaid' ? 'pending' : 'completed';
      const anon = meta.anonymous === '1' || meta.anonymous === 'true' ? 1 : 0;
      const goalId = this.#readRaw().goal.id;
      // Idempotent upsert keyed on the Stripe session id.
      this.ctx.storage.transactionSync(() => {
        this.#sql.exec(
          "INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET status = excluded.status",
          crypto.randomUUID(),
          goalId,
          Number(s.amount_total || 0),
          anon ? 'Anonymous' : String(meta.name || '').slice(0, 120),
          anon ? '' : String(meta.email || '').slice(0, 200),
          anon,
          s.id,
          status,
          new Date().toISOString()
        );
      });
    }
    return json({ received: true });
  }

  // Given a key, do the Stripe-dashboard work over HTTPS: create/verify the
  // products + prices for the configured presets and register a
  // checkout.session.completed webhook endpoint, then persist the resulting
  // price ids (and webhook signing secret) so the checkout flow can use them.
  async bootstrapStripe(request: Request): Promise<Response> {
    if (!this.#admin(request)) return json({ error: 'Admin key required.' }, 403);
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      /* optional */
    }
    const key = this.env.STRIPE_SECRET_KEY || String(body.key || '');
    if (!key) return json({ error: 'Set STRIPE_SECRET_KEY (wrangler secret) or pass "key".' }, 400);

    const stripe = async (method: string, path: string, params: Record<string, string> = {}): Promise<any> => {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) form.set(k, v);
      const r = await fetch('https://api.stripe.com' + path, {
        method,
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer ' + key },
        body: method === 'GET' ? undefined : form,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data && data.error && data.error.message) || ('Stripe ' + method + ' failed (' + r.status + ')'));
      return data;
    };

    try {
      await stripe('GET', '/v1/customers', { limit: '1' }); // verify the key
    } catch (e: any) {
      return json({ error: 'Key check failed: ' + e.message }, 400);
    }

    const cfg = this.#readRaw();
    const created: string[] = [];
    const price_map = { ...cfg.price_map };
    for (const preset of cfg.presets) {
      if (price_map[String(preset)]) continue;
      try {
        const product = await stripe('POST', '/v1/products', {
          name: cfg.church_name + ' — ' + Math.round(preset / 100) + ' ' + cfg.currency.toUpperCase(),
          metadata: 'gift=1',
          idempotency_key: 'don-' + preset,
        });
        const price = await stripe('POST', '/v1/prices', {
          product: product.id,
          unit_amount: String(preset),
          currency: cfg.currency,
          metadata: 'gift=1',
          idempotency_key: 'don-' + preset,
        });
        price_map[String(preset)] = price.id;
        created.push(product.id);
      } catch (e: any) {
        return json({ error: 'Product/price creation failed: ' + e.message }, 400);
      }
    }

    let webhook: any = null;
    try {
      webhook = await stripe('POST', '/v1/webhook_endpoints', {
        url: this.env.PUBLIC_ORIGIN + '/api/webhooks/stripe',
        'enabled_events[0]': 'checkout.session.completed',
      });
    } catch (e: any) {
      return json({ error: 'Webhook endpoint creation failed: ' + e.message }, 400);
    }

    const webhook_secret = webhook.secret || cfg.webhook_secret;
    this.#sql.exec('UPDATE config SET price_map = ?, webhook_secret = ? WHERE id = 1', JSON.stringify(price_map), webhook_secret);
    return json({ ok: true, mode: this.#mode(), products: created, prices: price_map, webhook: { id: webhook.id, url: this.env.PUBLIC_ORIGIN + '/api/webhooks/stripe' } });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/health' && request.method === 'GET') return this.health();
      if (p === '/api/config' && request.method === 'GET') return this.readConfig();
      if (p === '/api/config' && (request.method === 'PUT' || request.method === 'POST')) return this.writeConfig(request);
      if (p === '/api/gifts' && request.method === 'GET') return this.recentGifts();
      if (p === '/api/checkout' && request.method === 'POST') return this.createCheckout(request);
      if (p.startsWith('/api/confirm/') && request.method === 'GET') return this.confirm(p.split('/')[3]);
      if (p === '/api/webhooks/stripe' && request.method === 'POST') return this.stripeWebhook(request);
      if (p === '/api/admin/gifts' && request.method === 'GET') return this.adminGifts(request);
      if (p === '/api/admin/bootstrap-stripe' && request.method === 'POST') return this.bootstrapStripe(request);
      return json({ error: 'Not found.' }, 404);
    } catch (err) {
      console.error('giving-do', err);
      return json({ error: 'Internal error.' }, 500);
    }
  }
}

function withCors(response: Response, env: GivingEnv, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', frontendOrigin(request, env));
  headers.set('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  headers.set('access-control-allow-headers', 'Content-Type, Authorization');
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: GivingEnv): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), env, request);
    return withCors(await env.GIVING.getByName('main').fetch(request), env, request);
  },
};
