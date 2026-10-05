// Donate / Giving area.
//
// A multi-church giving stack on Cloudflare Workers. Each church lives in its
// own SQLite Durable Object (GivingDO), so one church can never read another
// church's gifts, funds or applications. A small registry object
// (GivingRegistry) owns church names and URL slugs.
//
// A church signs up with a staff password, then pastes its own Stripe secret
// key once. The key is checked against Stripe, encrypted with AES-GCM under
// STRIPE_KEY_ENCRYPTION_KEY and kept only in that church's Durable Object. It
// is never sent back to a browser or logged. On connect the Worker sets up
// Stripe for the church: one Product per fund (General giving, Tithes,
// Missions, and one per mission trip), preset Prices found again by
// lookup_key, and a webhook endpoint. Re-running setup reuses what exists.
//
// Until a church connects Stripe its gifts are simulated ("demo" status). The
// built-in demo church (Grace Community) always stays in demo mode.
//
// Donor names and emails are private: public endpoints return totals, goal
// progress and anonymous counts only. Stripe Checkout asks each donor for their
// name and email; signed-in staff see them for giving records and receipts.
//
// Donors can cancel a monthly gift on their own. With Stripe connected, setup
// also creates a Stripe customer portal configuration (with a hosted login
// page), and the thank-you screen can open the portal for that gift's own
// customer. In demo mode a monthly gift gets a private manage link instead,
// stored here only as a hash.

import { DurableObject } from 'cloudflare:workers';

type Secrets = {
  STRIPE_KEY_ENCRYPTION_KEY?: string;
  STRIPE_API_BASE?: string;
  // Optional: once churches have subdomains (grace.<BASE_DOMAIN>), any of them is an allowed origin.
  BASE_DOMAIN?: string;
  // Optional: turns on GET /api/platform/churches for the platform team (Authorization: Bearer <key>).
  PLATFORM_ADMIN_KEY?: string;
};
type GivingEnv = Env & Secrets & { GIVING_REGISTRY: DurableObjectNamespace<GivingRegistry> };

const DEMO_SLUG = 'grace-community';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const CURRENCIES = ['usd', 'cad', 'gbp', 'eur', 'aud', 'nzd'];
const NEW_CHURCH_PRESETS = [2500, 5000, 10000, 25000];
const DEMO_PRESETS = [100, 5000, 10000, 15000];
const MIN_GIFT = 100;
const MAX_GIFT = 99_999_900;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000;

// ALLOWED_ORIGIN is a comma-separated list of frontend origins. The first is the default.
function allowedOrigins(env: GivingEnv): string[] {
  return String(env.ALLOWED_ORIGIN).split(',').map((o) => o.trim()).filter(Boolean);
}

/** True for https://<base> and https://<one-label>.<base> when BASE_DOMAIN (e.g. belong.example.org) is set. */
function onBaseDomain(origin: string, base: string | undefined): boolean {
  const domain = String(base || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!domain || !origin.startsWith('https://')) return false;
  const host = origin.slice('https://'.length).toLowerCase();
  if (host === domain) return true;
  return host.endsWith('.' + domain) && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(host.slice(0, -domain.length - 1));
}

/** The request's Origin when it is allowed, otherwise the default origin. */
function frontendOrigin(request: Request, env: GivingEnv): string {
  const list = allowedOrigins(env);
  const origin = request.headers.get('origin') || '';
  return list.includes(origin) || onBaseDomain(origin, env.BASE_DOMAIN) ? origin : list[0];
}

// Branch and PR previews proxy to this Worker and say where they are in X-Return-Origin, so a donor
// who starts a gift on a preview comes back to that preview from Stripe. Only preview Workers of
// this app qualify; anything else falls back to the allowed origins.
const PREVIEW_ORIGIN = /^https:\/\/preview-[a-z0-9-]+-gloo-hackathon2026\.jaronwilson2025\.workers\.dev$/;

/** Where Stripe should send the donor back to. */
function returnOrigin(request: Request, env: GivingEnv): string {
  const preview = request.headers.get('x-return-origin') || '';
  return PREVIEW_ORIGIN.test(preview) ? preview : frontendOrigin(request, env);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

// Constant-time compare so a wrong secret does not leak via timing.
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken(bytes = 32): string {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function shortId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(3)).buffer);
}
async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return b64(new Uint8Array(bits));
}
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !salt || !hash) return false;
  return ctEqual(await pbkdf2(password, unb64(salt), Number(iter)), hash);
}

// AES-GCM with a server-held key. The church slug and purpose are bound in as
// additional data, so a ciphertext copied to another church or field fails.
async function cryptoKey(env: GivingEnv): Promise<CryptoKey | null> {
  const raw = env.STRIPE_KEY_ENCRYPTION_KEY;
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    bytes = unb64(raw.trim());
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env: GivingEnv, plain: string, aad: string): Promise<string> {
  const key = await cryptoKey(env);
  if (!key) throw new Error('missing encryption key');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plain));
  return 'v1.' + b64(iv) + '.' + b64(new Uint8Array(ct));
}
async function unseal(env: GivingEnv, sealed: string, aad: string): Promise<string> {
  const key = await cryptoKey(env);
  const [v, iv, ct] = sealed.split('.');
  if (!key || v !== 'v1' || !iv || !ct) throw new Error('cannot decrypt');
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, key, unb64(ct));
  return dec.decode(out);
}

// HMAC-SHA256 of `${timestamp}.${payload}` as hex, the value Stripe signs.
async function stripeSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`)));
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function cents(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function isoDate(v: unknown): string {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[_\s-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'church';
}

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function readJson(request: Request, max = 20_000): Promise<any> {
  const text = await request.text();
  if (text.length > max) throw new BadRequest('Request is too large.', 413);
  try {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new BadRequest('Body must be valid JSON.');
  }
}

// ---------- Stripe over plain HTTPS (form-encoded, no SDK) ----------

class StripeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Params = [string, string][];

async function stripe(env: GivingEnv, key: string, method: string, path: string, params: Params = [], idempotencyKey = ''): Promise<any> {
  const base = (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
  const form = new URLSearchParams();
  for (const [k, v] of params) form.append(k, v);
  const headers: Record<string, string> = { authorization: 'Bearer ' + key };
  let url = base + path;
  let body: string | undefined;
  if (method === 'GET' || method === 'DELETE') {
    if (params.length) url += '?' + form.toString();
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = form.toString();
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  }
  let resp: Response;
  try {
    resp = await fetch(url, { method, headers, body });
  } catch {
    throw new StripeError('Could not reach Stripe.', 502);
  }
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new StripeError((data && data.error && data.error.message) || `Stripe returned ${resp.status}.`, resp.status);
  return data;
}

// Demo gifts have no Stripe Checkout to ask who is giving.
const DEMO_DONOR = 'Demo donor';

// The donor's name and email from a Checkout Session, as typed into Stripe Checkout.
function payer(s: any): { name: string; email: string } {
  const d = s?.customer_details || {};
  return { name: str(d.individual_name || d.name || d.business_name, 120), email: str(d.email || s?.customer_email, 200) };
}

// A Stripe field that is either an ID or an expanded object.
function stripeId(v: any): string {
  const id = typeof v === 'string' ? v : v && typeof v.id === 'string' ? v.id : '';
  return /^[A-Za-z0-9_]{1,255}$/.test(id) ? id : '';
}

function keyInfo(key: string): { mode: 'test' | 'live'; hint: string } | null {
  const m = /^(sk|rk)_(test|live)_([A-Za-z0-9]{16,})$/.exec(key);
  if (!m) return null;
  return { mode: m[2] as 'test' | 'live', hint: `${m[1]}_${m[2]}_…${m[3].slice(-4)}` };
}

// What the platform team sees about one church's giving: counts and mode only.
// Never a key, hint, password, webhook or portal detail, and nothing about a donor.
type PlatformGiving = {
  mode: 'demo' | 'test' | 'live';
  currency: string;
  funds: number;
  trips: number;
  gifts: number;
  raised: number;
  setup: { stripe: boolean; trip: boolean; done: boolean };
};

// ---------- Rows ----------

type ChurchRow = {
  slug: string;
  name: string;
  city: string;
  currency: string;
  presets: string;
  password_hash: string;
  demo_locked: number;
  stripe_key: string;
  stripe_hint: string;
  stripe_mode: string;
  stripe_account: string;
  webhook_id: string;
  webhook_secret: string;
  webhook_note: string;
  portal_config_id: string;
  portal_url: string;
  portal_note: string;
  provisioned_at: string;
  provision_error: string;
  created_at: string;
};

type FundRow = {
  id: string;
  kind: string;
  name: string;
  description: string;
  goal: number;
  recurring: number;
  active: number;
  sort: number;
  start_date: string;
  end_date: string;
  location: string;
  spots: number;
  applications_open: number;
  product_id: string;
  prices: string;
  created_at: string;
};

type GiftRow = {
  id: string;
  cause_id: string;
  amount: number;
  name: string;
  email: string;
  anonymous: number;
  session_id: string;
  status: string;
  cadence: string;
  created_at: string;
  customer_id: string;
  subscription_id: string;
  manage_hash: string;
  canceled_at: string;
};

const DEFAULT_FUNDS = [
  { id: 'general', name: 'General giving', description: 'Support the day-to-day life and ministry of the church.', recurring: 0, sort: 0 },
  { id: 'tithes', name: 'Tithes & offerings', description: 'Your regular tithe. Give once or set up a monthly gift.', recurring: 1, sort: 1 },
  { id: 'missions', name: 'Missions', description: 'Send and support mission teams near and far.', recurring: 0, sort: 2 },
];

// Events the per-church webhook listens for. Re-running setup adds any that are missing.
const WEBHOOK_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'invoice.paid', 'customer.subscription.deleted'];
const MANAGE_TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
// How long the thank-you screen's "Manage or cancel" button works for a Stripe gift.
const PORTAL_FROM_CHECKOUT_TTL = 7 * 24 * 60 * 60 * 1000;

const FUND_INSERT =
  'INSERT OR IGNORE INTO funds (id, kind, name, description, goal, recurring, active, sort, start_date, end_date, location, spots, applications_open, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)';

export class GivingDO extends DurableObject<GivingEnv> {
  #slug = '';

  constructor(ctx: DurableObjectState, env: GivingEnv) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK (id = 1), church_name TEXT NOT NULL, currency TEXT NOT NULL, presets TEXT NOT NULL, goal TEXT NOT NULL, causes TEXT NOT NULL, price_map TEXT NOT NULL, webhook_secret TEXT NOT NULL)'
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, cause_id TEXT NOT NULL, amount INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL)'
    );
    const giftCols = sql.exec('PRAGMA table_info(gifts)').toArray().map((r: any) => String(r.name));
    if (!giftCols.includes('cadence')) sql.exec("ALTER TABLE gifts ADD COLUMN cadence TEXT NOT NULL DEFAULT 'once'");
    for (const col of ['customer_id', 'subscription_id', 'manage_hash', 'canceled_at']) {
      if (!giftCols.includes(col)) sql.exec(`ALTER TABLE gifts ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
    sql.exec('CREATE TABLE IF NOT EXISTS rate (ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)');
    sql.exec(
      "CREATE TABLE IF NOT EXISTS church (id INTEGER PRIMARY KEY CHECK (id = 1), slug TEXT NOT NULL, name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'usd', presets TEXT NOT NULL DEFAULT '[]', password_hash TEXT NOT NULL DEFAULT '', demo_locked INTEGER NOT NULL DEFAULT 0, stripe_key TEXT NOT NULL DEFAULT '', stripe_hint TEXT NOT NULL DEFAULT '', stripe_mode TEXT NOT NULL DEFAULT '', stripe_account TEXT NOT NULL DEFAULT '', webhook_id TEXT NOT NULL DEFAULT '', webhook_secret TEXT NOT NULL DEFAULT '', webhook_note TEXT NOT NULL DEFAULT '', provisioned_at TEXT NOT NULL DEFAULT '', provision_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS funds (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', goal INTEGER NOT NULL DEFAULT 0, recurring INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', spots INTEGER NOT NULL DEFAULT 0, applications_open INTEGER NOT NULL DEFAULT 0, product_id TEXT NOT NULL DEFAULT '', prices TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)"
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, fund_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    const churchCols = sql.exec('PRAGMA table_info(church)').toArray().map((r: any) => String(r.name));
    for (const col of ['portal_config_id', 'portal_url', 'portal_note']) {
      if (!churchCols.includes(col)) sql.exec(`ALTER TABLE church ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
    sql.exec('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  }

  get #sql() {
    return this.ctx.storage.sql;
  }

  // ---------- Church state ----------

  #church(): ChurchRow | null {
    const row = this.#sql.exec('SELECT * FROM church WHERE id = 1').toArray()[0] as unknown as ChurchRow | undefined;
    if (row) return row;
    if (this.#slug !== DEMO_SLUG) return null;
    this.#seedDemo();
    return this.#sql.exec('SELECT * FROM church WHERE id = 1').toArray()[0] as unknown as ChurchRow;
  }

  // The original single-church demo becomes the "grace-community" church. Its
  // existing gifts move from the old "main" goal to the General giving fund.
  #seedDemo() {
    const cfg = this.#readRaw();
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        'INSERT OR IGNORE INTO church (id, slug, name, city, currency, presets, demo_locked, created_at) VALUES (1, ?, ?, ?, ?, ?, 1, ?)',
        DEMO_SLUG, cfg.church_name, 'Springfield', cfg.currency, JSON.stringify(cfg.presets.length ? cfg.presets : DEMO_PRESETS), now
      );
      this.#seedFunds(now);
      this.#sql.exec("UPDATE funds SET goal = ? WHERE id = 'general'", cfg.goal.amount);
      this.#sql.exec("UPDATE funds SET goal = 1500000 WHERE id = 'missions'");
      this.#sql.exec(
        FUND_INSERT, 'trip-guatemala', 'trip', 'Guatemala medical mission',
        'Serve alongside a partner church with a medical clinic and a construction crew. No medical background needed, just a willing heart.',
        1800000, 0, 10, '2027-03-13', '2027-03-21', 'Antigua, Guatemala', 12, 1, now
      );
      this.#sql.exec(
        FUND_INSERT, 'trip-youth-camp', 'trip', 'Student summer camp',
        'Help send every student to camp. Adults can apply to serve as cabin leaders.',
        600000, 0, 11, '2027-06-21', '2027-06-26', 'Lake Ozark, Missouri', 30, 1, now
      );
      this.#sql.exec("UPDATE gifts SET cause_id = 'general' WHERE cause_id NOT IN (SELECT id FROM funds)");
    });
  }

  #seedFunds(now: string) {
    for (const f of DEFAULT_FUNDS) this.#sql.exec(FUND_INSERT, f.id, 'fund', f.name, f.description, 0, f.recurring, f.sort, '', '', '', 0, 0, now);
  }

  #mode(c: ChurchRow): 'demo' | 'test' | 'live' {
    if (c.demo_locked || !c.stripe_key) return 'demo';
    return c.stripe_mode === 'live' ? 'live' : 'test';
  }

  #presets(c: ChurchRow): number[] {
    try {
      const p = JSON.parse(c.presets);
      if (Array.isArray(p) && p.length) return p.map((n) => cents(n)).filter(Boolean).slice(0, 6);
    } catch {
      /* fall through */
    }
    return NEW_CHURCH_PRESETS;
  }

  #funds(includeInactive = false): FundRow[] {
    return this.#sql.exec(`SELECT * FROM funds ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, created_at`).toArray() as unknown as FundRow[];
  }

  #fund(id: string): FundRow | null {
    return (this.#sql.exec('SELECT * FROM funds WHERE id = ?', id).toArray()[0] as unknown as FundRow) || null;
  }

  #countedStatuses(c: ChurchRow): string {
    return this.#mode(c) === 'demo' ? "('completed', 'demo')" : "('completed')";
  }

  // Totals only. Nothing here identifies a donor.
  #publicChurch(c: ChurchRow) {
    const totals = new Map<string, { raised: number; gifts: number }>();
    for (const r of this.#sql.exec(`SELECT cause_id, COALESCE(SUM(amount), 0) AS raised, COUNT(*) AS gifts FROM gifts WHERE status IN ${this.#countedStatuses(c)} GROUP BY cause_id`).toArray()) {
      totals.set(String(r.cause_id), { raised: Number(r.raised), gifts: Number(r.gifts) });
    }
    const accepted = new Map<string, number>();
    for (const r of this.#sql.exec("SELECT fund_id, COUNT(*) AS n FROM applications WHERE status = 'accepted' GROUP BY fund_id").toArray()) {
      accepted.set(String(r.fund_id), Number(r.n));
    }
    const shape = (f: FundRow) => {
      const t = totals.get(f.id) || { raised: 0, gifts: 0 };
      const base = { id: f.id, kind: f.kind, name: f.name, description: f.description, goal: Number(f.goal), raised: t.raised, gifts: t.gifts, recurring: !!f.recurring };
      if (f.kind !== 'trip') return base;
      return { ...base, startDate: f.start_date, endDate: f.end_date, location: f.location, spots: Number(f.spots), filled: accepted.get(f.id) || 0, applicationsOpen: !!f.applications_open };
    };
    const active = this.#funds();
    let raised = 0;
    let gifts = 0;
    for (const t of totals.values()) {
      raised += t.raised;
      gifts += t.gifts;
    }
    return {
      slug: c.slug,
      name: c.name,
      city: c.city,
      currency: c.currency,
      presets: this.#presets(c),
      mode: this.#mode(c),
      // How donors manage a monthly gift: "link" (demo, private link per gift),
      // "portal" (Stripe's hosted login page at portalUrl) or "" (not set up yet).
      manage: this.#mode(c) === 'demo' ? 'link' : c.portal_url ? 'portal' : '',
      portalUrl: this.#mode(c) === 'demo' ? '' : c.portal_url,
      funds: active.filter((f) => f.kind !== 'trip').map(shape),
      trips: active.filter((f) => f.kind === 'trip').map(shape),
      totals: { raised, gifts },
    };
  }

  // ---------- Rate limits ----------

  #rateOk(bucket: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const row = this.#sql.exec('SELECT window_start, count FROM rate WHERE ip = ?', bucket).toArray()[0];
      if (!row) {
        this.#sql.exec('INSERT INTO rate (ip, window_start, count) VALUES (?, ?, 1)', bucket, now);
        return true;
      }
      if (now - Number(row.window_start) >= windowMs) {
        this.#sql.exec('UPDATE rate SET window_start = ?, count = 1 WHERE ip = ?', now, bucket);
        return true;
      }
      if (Number(row.count) >= max) return false;
      this.#sql.exec('UPDATE rate SET count = count + 1 WHERE ip = ?', bucket);
      return true;
    });
  }

  // ---------- Staff sessions ----------

  async #newSession(): Promise<string> {
    const token = randomToken();
    const now = Date.now();
    this.#sql.exec('DELETE FROM sessions WHERE expires_at < ?', now);
    this.#sql.exec('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)', await sha256(token), now + SESSION_TTL);
    return token;
  }

  async #isAdmin(request: Request): Promise<boolean> {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') || '');
    if (!m) return false;
    const row = this.#sql.exec('SELECT expires_at FROM sessions WHERE token_hash = ?', await sha256(m[1])).toArray()[0];
    return !!row && Number(row.expires_at) > Date.now();
  }

  // ---------- RPC from the Worker: create a church ----------

  async init(slug: string, name: string, city: string, currency: string, password: string): Promise<{ token?: string; error?: string }> {
    this.#slug = slug;
    if (this.#sql.exec('SELECT 1 FROM church WHERE id = 1').toArray().length) return { error: 'That church already exists.' };
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        'INSERT INTO church (id, slug, name, city, currency, presets, password_hash, demo_locked, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)',
        slug, name, city, currency, JSON.stringify(NEW_CHURCH_PRESETS), hash, now
      );
      this.#seedFunds(now);
    });
    return { token: await this.#newSession() };
  }

  // ---------- RPC from the Worker: the platform team's church list ----------

  // The same numbers the staff overview shows, and the same "Getting set up" checklist.
  async platformSummary(slug: string): Promise<PlatformGiving | null> {
    this.#slug = slug;
    const c = this.#church();
    if (!c) return null;
    const pub = this.#publicChurch(c);
    const stripeReady = !!c.stripe_key && !c.provision_error;
    const anyTrip = this.#funds(true).some((f) => f.kind === 'trip');
    return {
      mode: this.#mode(c),
      currency: c.currency,
      funds: pub.funds.length,
      trips: pub.trips.length,
      gifts: pub.totals.gifts,
      raised: pub.totals.raised,
      setup: { stripe: stripeReady, trip: anyTrip, done: stripeReady && anyTrip },
    };
  }

  // ---------- Public ----------

  #getChurch(): Response {
    const c = this.#church();
    if (!c) return json({ error: 'Church not found.' }, 404);
    return json(this.#publicChurch(c));
  }

  async #checkout(request: Request, body: any): Promise<Response> {
    const c = this.#church();
    if (!c) return json({ error: 'Church not found.' }, 404);
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    if (!this.#rateOk('checkout:' + ip, 10, 60_000)) return json({ error: 'Too many requests. Please slow down.' }, 429);

    const fund = this.#fund(str(body.fund, 60) || 'general');
    if (!fund || !fund.active) return json({ error: 'That fund is not taking gifts right now.' }, 400);
    const amount = cents(body.amount);
    const cadence = body.cadence === 'month' && fund.recurring ? 'month' : 'once';
    // Stripe Checkout collects the donor's name and email, and they are saved when the
    // payment completes. Name, email or "anonymous" sent by an older page are ignored.
    if (amount < MIN_GIFT) return json({ error: 'Choose or enter an amount of at least 1.00.' }, 400);
    if (amount > MAX_GIFT) return json({ error: 'That amount is too large for an online gift.' }, 400);

    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    const mode = this.#mode(c);
    const back = returnOrigin(request, this.env) + '/give?church=' + encodeURIComponent(c.slug);

    if (mode === 'demo') {
      const sessionId = 'demo_' + id;
      // A demo monthly gift gets a private manage link. Only its hash is stored.
      const manage = cadence === 'month' ? randomToken() : '';
      this.#sql.exec(
        "INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, cadence, created_at, manage_hash) VALUES (?, ?, ?, ?, '', 0, ?, 'demo', ?, ?, ?)",
        id, fund.id, amount, DEMO_DONOR, sessionId, cadence, created, manage ? await sha256(manage) : ''
      );
      return json({ id, url: back + '&session_id=' + sessionId + '&status=demo', demo: true, mode, ...(manage ? { manage: c.slug + '.' + manage } : {}) });
    }

    let key: string;
    try {
      key = await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug);
    } catch {
      return json({ error: 'Online giving is not set up correctly. Please let the church know.' }, 503);
    }
    let f = fund;
    if (!f.product_id) {
      try {
        f = await this.#provisionFund(key, c, fund);
      } catch {
        /* fall back to an inline product below */
      }
    }
    const prices = this.#priceMap(f);
    const form: Params = [
      ['mode', cadence === 'month' ? 'subscription' : 'payment'],
      ['line_items[0][quantity]', '1'],
      ['metadata[belong_church]', c.slug],
      ['metadata[belong_fund]', f.id],
      ['metadata[belong_gift]', id],
      ['success_url', back + '&session_id={CHECKOUT_SESSION_ID}&status=complete'],
      ['cancel_url', back + '&status=cancel'],
      ['client_reference_id', id],
    ];
    const preset = prices[cadence]?.[String(amount)];
    if (preset) {
      form.push(['line_items[0][price]', preset]);
    } else {
      form.push(['line_items[0][price_data][currency]', c.currency], ['line_items[0][price_data][unit_amount]', String(amount)]);
      if (f.product_id) form.push(['line_items[0][price_data][product]', f.product_id]);
      else form.push(['line_items[0][price_data][product_data][name]', f.name]);
      if (cadence === 'month') form.push(['line_items[0][price_data][recurring][interval]', 'month']);
    }
    if (cadence === 'month') {
      form.push(['subscription_data[metadata][belong_church]', c.slug], ['subscription_data[metadata][belong_fund]', f.id], ['subscription_data[metadata][belong_gift]', id]);
    } else {
      form.push(['submit_type', 'donate']);
    }
    // Checkout always asks for an email. Ask for the donor's name too, so staff have it
    // for giving records. An account on an API version without name_collection gets a
    // billing address form instead, which includes the name.
    let session: any;
    try {
      try {
        session = await stripe(this.env, key, 'POST', '/v1/checkout/sessions', [...form, ['name_collection[individual][enabled]', 'true']], 'belong-checkout-' + id);
      } catch (e: any) {
        if (!(e instanceof StripeError && e.status === 400 && /name_collection/.test(e.message))) throw e;
        session = await stripe(this.env, key, 'POST', '/v1/checkout/sessions', [...form, ['billing_address_collection', 'required']], 'belong-checkout-address-' + id);
      }
    } catch (e: any) {
      return json({ error: e instanceof StripeError ? 'Checkout could not be started: ' + e.message : 'Checkout could not be started.' }, 502);
    }
    if (!session.url || !session.id) return json({ error: 'Checkout could not be started.' }, 502);
    this.#sql.exec(
      "INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, cadence, created_at) VALUES (?, ?, ?, '', '', 0, ?, 'pending', ?, ?)",
      id, f.id, amount, String(session.id), cadence, created
    );
    return json({ id, url: session.url, demo: false, mode });
  }

  // Called when the donor lands back on the site. If the webhook has not
  // arrived yet, ask Stripe directly so the thank-you page is accurate.
  async #confirm(sessionId: string): Promise<Response> {
    const c = this.#church();
    if (!c) return json({ error: 'Church not found.' }, 404);
    let r = this.#sql.exec('SELECT * FROM gifts WHERE session_id = ?', sessionId).toArray()[0] as unknown as GiftRow | undefined;
    if (!r) return json({ error: 'We could not find that gift.' }, 404);
    if (r.status === 'pending' && c.stripe_key && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      try {
        const key = await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug);
        const s = await stripe(this.env, key, 'GET', '/v1/checkout/sessions/' + sessionId);
        const status = s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') ? 'completed' : s.status === 'expired' ? 'expired' : 'pending';
        if (status !== 'pending') {
          const amount = Number(s.amount_total) || Number(r.amount);
          const who = payer(s);
          this.#sql.exec(
            "UPDATE gifts SET status = ?, amount = ?, customer_id = COALESCE(NULLIF(?, ''), customer_id), subscription_id = COALESCE(NULLIF(?, ''), subscription_id), name = COALESCE(NULLIF(?, ''), name), email = COALESCE(NULLIF(?, ''), email) WHERE session_id = ?",
            status, amount, stripeId(s.customer), stripeId(s.subscription), who.name, who.email, sessionId
          );
          r = { ...r, status, amount };
        }
      } catch {
        /* keep pending; the webhook will settle it */
      }
    }
    const fund = this.#fund(r.cause_id);
    return json({
      status: r.status,
      amount: Number(r.amount),
      currency: c.currency,
      fund: fund ? fund.name : 'General giving',
      cadence: r.cadence || 'once',
      anonymous: !!Number(r.anonymous),
      demo: r.status === 'demo',
      church: c.name,
      canceled: !!r.canceled_at,
      // How this donor can manage the gift from the thank-you screen.
      manage: r.cadence !== 'month' || r.canceled_at ? '' : r.status === 'demo' ? 'link' : r.status === 'completed' && this.#mode(c) !== 'demo' ? 'portal' : '',
    });
  }

  // ---------- Donors managing a monthly gift ----------

  // Opens the Stripe customer portal for the customer who paid this checkout
  // session, and only that customer. Used by the thank-you screen.
  async #portal(request: Request): Promise<Response> {
    const c = this.#church();
    if (!c) return json({ error: 'Church not found.' }, 404);
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    if (!this.#rateOk('portal:' + ip, 10, 60_000)) return json({ error: 'Too many requests. Please slow down.' }, 429);
    const body = await readJson(request);
    const sessionId = str(body.session, 200);
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json({ error: 'We could not find that gift.' }, 404);
    const r = this.#sql.exec('SELECT * FROM gifts WHERE session_id = ?', sessionId).toArray()[0] as unknown as GiftRow | undefined;
    if (!r) return json({ error: 'We could not find that gift.' }, 404);
    if (r.cadence !== 'month' || r.status !== 'completed') return json({ error: 'Only a monthly gift can be managed here.' }, 400);
    if (Date.now() - Date.parse(r.created_at) > PORTAL_FROM_CHECKOUT_TTL) return json({ error: 'This thank-you page is too old to open your gift. Use "Manage or cancel a monthly gift" on the Give page instead.' }, 400);
    if (this.#mode(c) === 'demo') return json({ error: 'Online giving is not connected to Stripe right now.' }, 400);
    let key: string;
    try {
      key = await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug);
    } catch {
      return json({ error: 'Online giving is not set up correctly. Please let the church know.' }, 503);
    }
    try {
      // The customer always comes from this checkout session, never from the request.
      const s = await stripe(this.env, key, 'GET', '/v1/checkout/sessions/' + sessionId);
      const customer = stripeId(s.customer);
      if (s.metadata?.belong_church !== c.slug || !customer) return json({ error: 'We could not find that gift.' }, 404);
      if (!c.portal_config_id) await this.#ensurePortal(key, c).catch(() => null);
      const configId = this.#church()!.portal_config_id;
      const params: Params = [['customer', customer], ['return_url', returnOrigin(request, this.env) + '/#/give']];
      if (configId) params.push(['configuration', configId]);
      const portal = await stripe(this.env, key, 'POST', '/v1/billing_portal/sessions', params);
      if (!portal.url) return json({ error: 'Stripe did not open the page. Please try again.' }, 502);
      return json({ url: String(portal.url) });
    } catch (e: any) {
      return json({ error: e instanceof StripeError ? 'Stripe could not open the page: ' + e.message : 'Stripe could not open the page.' }, 502);
    }
  }

  async #managedGift(request: Request, token: string): Promise<GiftRow | null> {
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    if (!this.#rateOk('manage:' + ip, 30, 60_000)) throw new BadRequest('Too many requests. Please slow down.', 429);
    if (!MANAGE_TOKEN_RE.test(token)) return null;
    return (this.#sql.exec("SELECT * FROM gifts WHERE manage_hash = ? AND manage_hash != ''", await sha256(token)).toArray()[0] as unknown as GiftRow) || null;
  }

  // What the private manage link shows. No name or email: just the gift.
  #managedView(c: ChurchRow, r: GiftRow) {
    const fund = this.#fund(r.cause_id);
    return {
      church: c.name,
      fund: fund ? fund.name : 'General giving',
      amount: Number(r.amount),
      currency: c.currency,
      cadence: r.cadence,
      demo: r.status === 'demo',
      startedAt: r.created_at,
      canceled: !!r.canceled_at,
      canceledAt: r.canceled_at,
    };
  }

  async #manage(request: Request, token: string, cancel: boolean): Promise<Response> {
    const c = this.#church();
    if (!c) return json({ error: 'Church not found.' }, 404);
    const r = await this.#managedGift(request, token);
    if (!r) return json({ error: 'This link does not work. It may be old or copied wrong.' }, 404);
    if (cancel && !r.canceled_at) {
      const now = new Date().toISOString();
      this.#sql.exec("UPDATE gifts SET canceled_at = ? WHERE id = ? AND canceled_at = ''", now, r.id);
      r.canceled_at = now;
    }
    return json(this.#managedView(c, r));
  }

  async #apply(request: Request, tripId: string): Promise<Response> {
    const c = this.#church();
    if (!c) return json({ error: 'Church not found.' }, 404);
    const trip = this.#fund(tripId);
    if (!trip || trip.kind !== 'trip' || !trip.active) return json({ error: 'Trip not found.' }, 404);
    if (!trip.applications_open) return json({ error: 'Applications for this trip are closed.' }, 400);
    const body = await readJson(request);
    const name = str(body.name, 120);
    const email = str(body.email, 200);
    const phone = str(body.phone, 40);
    const message = str(body.message, 2000);
    if (!name) return json({ error: 'Please add your name.' }, 400);
    if (!EMAIL_RE.test(email)) return json({ error: 'Please add a valid email so the team can reach you.' }, 400);
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    if (!this.#rateOk('apply:' + ip, 5, 10 * 60_000)) return json({ error: 'Too many applications from here. Please try again later.' }, 429);
    const total = Number(this.#sql.exec('SELECT COUNT(*) AS n FROM applications').toArray()[0].n);
    if (total >= 5000) return json({ error: 'This church is not taking more applications right now.' }, 400);
    const now = new Date().toISOString();
    this.#sql.exec(
      "INSERT INTO applications (id, fund_id, name, email, phone, message, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', '', ?, ?)",
      crypto.randomUUID(), trip.id, name, email, phone, message, now, now
    );
    return json({ ok: true });
  }

  async #webhook(request: Request): Promise<Response> {
    const c = this.#church();
    if (!c || !c.webhook_secret) return json({ error: 'Not configured.' }, 400);
    const raw = await request.text();
    if (raw.length > 512_000) return json({ error: 'Too large.' }, 413);
    let secret: string;
    try {
      secret = await unseal(this.env, c.webhook_secret, 'webhook-secret:' + c.slug);
    } catch {
      return json({ error: 'Not configured.' }, 400);
    }
    const header = request.headers.get('stripe-signature') || '';
    const t = Number(/t=(\d+)/.exec(header)?.[1] || 0);
    const sigs = [...header.matchAll(/v1=([0-9a-fA-F]+)/g)].map((m) => m[1]);
    if (!t || !sigs.length) return json({ error: 'Malformed signature.' }, 400);
    if (Math.abs(Date.now() - t * 1000) > 5 * 60 * 1000) return json({ error: 'Signature too old.' }, 400);
    const expected = await stripeSignature(secret, t, raw);
    if (!sigs.some((s) => ctEqual(expected, s))) return json({ error: 'Signature mismatch.' }, 400);
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      return json({ error: 'Bad payload.' }, 400);
    }
    const obj = evt?.data?.object || {};
    const now = new Date().toISOString();
    if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded' || evt.type === 'checkout.session.expired') {
      const meta = obj.metadata || {};
      if (meta.belong_church !== c.slug) return json({ received: true, ignored: true });
      const status = evt.type === 'checkout.session.expired' ? 'expired' : obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required' ? 'completed' : 'pending';
      const fundId = this.#fund(String(meta.belong_fund || '')) ? String(meta.belong_fund) : 'general';
      const customer = stripeId(obj.customer);
      const subscription = stripeId(obj.subscription);
      const who = payer(obj);
      this.ctx.storage.transactionSync(() => {
        const existing = this.#sql.exec('SELECT status FROM gifts WHERE session_id = ?', String(obj.id)).toArray()[0];
        if (existing) {
          if (existing.status !== 'completed') this.#sql.exec('UPDATE gifts SET status = ?, amount = COALESCE(?, amount) WHERE session_id = ?', status, Number(obj.amount_total) || null, String(obj.id));
          // The name and email the donor typed into Stripe Checkout.
          this.#sql.exec(
            "UPDATE gifts SET customer_id = COALESCE(NULLIF(?, ''), customer_id), subscription_id = COALESCE(NULLIF(?, ''), subscription_id), name = COALESCE(NULLIF(?, ''), name), email = COALESCE(NULLIF(?, ''), email) WHERE session_id = ?",
            customer, subscription, who.name, who.email, String(obj.id)
          );
        } else if (status !== 'expired') {
          // Not started from this site (or the row was lost): still record who Stripe says gave.
          this.#sql.exec(
            'INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, cadence, created_at, customer_id, subscription_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
            crypto.randomUUID(), fundId, Number(obj.amount_total || 0), who.name, who.email, String(obj.id), status, obj.mode === 'subscription' ? 'month' : 'once', now, customer, subscription
          );
        }
      });
    } else if (evt.type === 'invoice.paid' && obj.billing_reason === 'subscription_cycle') {
      // Monthly renewals of a recurring gift. The first month is recorded by checkout.session.completed.
      const meta = obj.subscription_details?.metadata || obj.parent?.subscription_details?.metadata || {};
      if (meta.belong_church !== c.slug) return json({ received: true, ignored: true });
      const first = this.#sql.exec('SELECT * FROM gifts WHERE id = ?', String(meta.belong_gift || '')).toArray()[0] as unknown as GiftRow | undefined;
      this.#sql.exec(
        "INSERT INTO gifts (id, cause_id, amount, name, email, anonymous, session_id, status, cadence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'month', ?) ON CONFLICT(session_id) DO NOTHING",
        crypto.randomUUID(),
        first?.cause_id || (this.#fund(String(meta.belong_fund || '')) ? String(meta.belong_fund) : 'general'),
        Number(obj.amount_paid || 0),
        first?.name || str(obj.customer_name, 120),
        first?.email || str(obj.customer_email, 200),
        first ? Number(first.anonymous) : 0,
        String(obj.id),
        now
      );
    } else if (evt.type === 'customer.subscription.deleted') {
      // The donor canceled in the Stripe portal, or staff canceled. Mark the monthly gift.
      const meta = obj.metadata || {};
      if (meta.belong_church !== c.slug) return json({ received: true, ignored: true });
      this.#sql.exec(
        "UPDATE gifts SET canceled_at = ? WHERE cadence = 'month' AND canceled_at = '' AND (id = ? OR (subscription_id != '' AND subscription_id = ?))",
        now, String(meta.belong_gift || ''), String(obj.id || '')
      );
    }
    return json({ received: true });
  }

  // ---------- Staff ----------

  async #login(request: Request): Promise<Response> {
    const c = this.#church();
    if (!c) return json({ error: 'Church not found.' }, 404);
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    if (!this.#rateOk('login:' + ip, 5, 60_000) || !this.#rateOk('login-hour:' + ip, 30, 3_600_000)) return json({ error: 'Too many sign-in attempts. Wait a minute and try again.' }, 429);
    const body = await readJson(request);
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    let ok = false;
    if (c.password_hash) ok = await verifyPassword(password, c.password_hash);
    else if (c.demo_locked && this.env.ADMIN_KEY) ok = ctEqual(password, String(this.env.ADMIN_KEY));
    if (!ok) return json({ error: 'That password is not right.' }, 401);
    return json({ token: await this.#newSession(), expiresIn: SESSION_TTL / 1000 });
  }

  async #logout(request: Request): Promise<Response> {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') || '');
    if (m) this.#sql.exec('DELETE FROM sessions WHERE token_hash = ?', await sha256(m[1]));
    return json({ ok: true });
  }

  #stripeStatus(c: ChurchRow) {
    return {
      connected: !!c.stripe_key,
      locked: !!c.demo_locked,
      mode: this.#mode(c),
      keyHint: c.stripe_hint,
      account: c.stripe_account,
      webhook: !!c.webhook_id,
      webhookNote: c.webhook_note,
      portal: !!c.portal_url,
      portalNote: c.portal_note,
      provisionedAt: c.provisioned_at,
      provisionError: c.provision_error,
      encryptionReady: !!this.env.STRIPE_KEY_ENCRYPTION_KEY,
    };
  }

  #adminOverview(c: ChurchRow) {
    const pub = this.#publicChurch(c);
    const funds = this.#funds(true).map((f) => ({
      id: f.id,
      kind: f.kind,
      name: f.name,
      description: f.description,
      goal: Number(f.goal),
      recurring: !!f.recurring,
      active: !!f.active,
      startDate: f.start_date,
      endDate: f.end_date,
      location: f.location,
      spots: Number(f.spots),
      applicationsOpen: !!f.applications_open,
      inStripe: !!f.product_id,
    }));
    const newApplications = Number(this.#sql.exec("SELECT COUNT(*) AS n FROM applications WHERE status = 'new'").toArray()[0].n);
    return { church: { slug: c.slug, name: c.name, city: c.city, currency: c.currency, demo: !!c.demo_locked }, stripe: this.#stripeStatus(c), public: pub, funds, newApplications };
  }

  async #saveSettings(request: Request, c: ChurchRow): Promise<Response> {
    const body = await readJson(request);
    const name = str(body.name, 80) || c.name;
    const city = typeof body.city === 'string' ? str(body.city, 80) : c.city;
    if (name.length < 3) return json({ error: 'Add your church name.' }, 400);
    this.#sql.exec('UPDATE church SET name = ?, city = ? WHERE id = 1', name, city);
    await this.env.GIVING_REGISTRY.getByName('registry').rename(c.slug, name, city);
    return json(this.#adminOverview(this.#church()!));
  }

  async #changePassword(request: Request, c: ChurchRow): Promise<Response> {
    if (c.demo_locked) return json({ error: 'The demo church password cannot be changed here.' }, 403);
    const body = await readJson(request);
    const current = typeof body.current === 'string' ? body.current.slice(0, 200) : '';
    const next = typeof body.next === 'string' ? body.next : '';
    if (!(await verifyPassword(current, c.password_hash))) return json({ error: 'Your current password is not right.' }, 400);
    if (next.length < 10 || next.length > 200) return json({ error: 'Use at least 10 characters for the new password.' }, 400);
    this.#sql.exec('UPDATE church SET password_hash = ? WHERE id = 1', await hashPassword(next));
    this.#sql.exec('DELETE FROM sessions');
    return json({ ok: true, token: await this.#newSession() });
  }

  async #connectStripe(request: Request, c: ChurchRow): Promise<Response> {
    if (c.demo_locked) return json({ error: 'The demo church always stays in demo mode. Sign up your own church to connect Stripe.' }, 403);
    if (!(await cryptoKey(this.env))) return json({ error: 'This server cannot store Stripe keys yet: STRIPE_KEY_ENCRYPTION_KEY is not set.' }, 503);
    const body = await readJson(request);
    const key = str(body.key, 300);
    const info = keyInfo(key);
    if (!info) return json({ error: 'That does not look like a Stripe secret key. It starts with sk_ or rk_, then test_ or live_.' }, 400);
    try {
      await stripe(this.env, key, 'GET', '/v1/products', [['limit', '1']]);
    } catch (e: any) {
      const status = e instanceof StripeError ? e.status : 502;
      const msg =
        status === 401 ? 'Stripe did not accept that key.'
        : status === 403 ? 'That key cannot read products. Give it write access to Products, Prices, Checkout Sessions, Webhook Endpoints, Customer portal and Subscriptions.'
        : 'Could not check the key with Stripe. Try again in a moment.';
      return json({ error: msg }, 400);
    }
    let account = '';
    try {
      const a = await stripe(this.env, key, 'GET', '/v1/account');
      account = str(a?.settings?.dashboard?.display_name || a?.business_profile?.name || '', 120);
    } catch {
      /* restricted keys often cannot read the account; that is fine */
    }
    const previous = c.stripe_key ? await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug).catch(() => '') : '';
    const sealed = await seal(this.env, key, 'stripe-key:' + c.slug);
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec("UPDATE church SET stripe_key = ?, stripe_hint = ?, stripe_mode = ?, stripe_account = ?, provision_error = '' WHERE id = 1", sealed, info.hint, info.mode, account);
      // A different key may be a different Stripe account: forget objects from the old one.
      if (previous !== key) {
        this.#sql.exec("UPDATE church SET webhook_id = '', webhook_secret = '', webhook_note = '', portal_config_id = '', portal_url = '', portal_note = '', provisioned_at = '' WHERE id = 1");
        this.#sql.exec("UPDATE funds SET product_id = '', prices = '{}'");
      }
    });
    const provision = await this.#provisionAll(key);
    return json({ ...this.#adminOverview(this.#church()!), provision });
  }

  async #syncStripe(c: ChurchRow): Promise<Response> {
    if (!c.stripe_key || c.demo_locked) return json({ error: 'Connect Stripe first.' }, 400);
    let key: string;
    try {
      key = await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug);
    } catch {
      return json({ error: 'The saved key cannot be read. Connect Stripe again.' }, 400);
    }
    const provision = await this.#provisionAll(key);
    return json({ ...this.#adminOverview(this.#church()!), provision });
  }

  async #disconnectStripe(c: ChurchRow): Promise<Response> {
    if (c.stripe_key && c.webhook_id) {
      try {
        const key = await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug);
        await stripe(this.env, key, 'DELETE', '/v1/webhook_endpoints/' + c.webhook_id);
      } catch {
        /* best effort */
      }
    }
    this.#sql.exec(
      "UPDATE church SET stripe_key = '', stripe_hint = '', stripe_mode = '', stripe_account = '', webhook_id = '', webhook_secret = '', webhook_note = '', portal_config_id = '', portal_url = '', portal_note = '', provisioned_at = '', provision_error = '' WHERE id = 1"
    );
    return json(this.#adminOverview(this.#church()!));
  }

  #priceMap(f: FundRow): Record<string, Record<string, string>> {
    try {
      return JSON.parse(f.prices || '{}') || {};
    } catch {
      return {};
    }
  }

  // Finds or creates everything one fund needs in Stripe: a Product tagged
  // with the church and fund in metadata, and one Price per preset amount
  // (plus monthly Prices for recurring funds), each with a stable lookup_key.
  async #provisionFund(key: string, c: ChurchRow, f: FundRow, known?: any[]): Promise<FundRow> {
    let productId = f.product_id;
    let product: any = null;
    if (productId) {
      product = known?.find((p) => p.id === productId) || (await stripe(this.env, key, 'GET', '/v1/products/' + productId).catch(() => null));
      if (!product || product.deleted) productId = '';
    }
    if (!productId) {
      product = (known || (await this.#listChurchProducts(key, c.slug))).find((p) => p.metadata?.belong_fund === f.id);
      if (product) productId = product.id;
    }
    const label = f.name + ' · ' + c.name;
    if (!productId) {
      product = await stripe(
        this.env, key, 'POST', '/v1/products',
        [['name', label], ['description', f.description || f.name], ['metadata[belong_church]', c.slug], ['metadata[belong_fund]', f.id], ['metadata[belong_kind]', f.kind]],
        `belong-product-${c.slug}-${f.id}`
      );
      productId = String(product.id);
    } else if (product && (product.name !== label || product.active === false)) {
      await stripe(this.env, key, 'POST', '/v1/products/' + productId, [['name', label], ['active', 'true']]);
    }

    const tag = `belong_${c.slug}_${f.id}`;
    const want: { cadence: 'once' | 'month'; amount: number; lookup: string }[] = [];
    for (const p of this.#presets(c)) {
      want.push({ cadence: 'once', amount: p, lookup: `${tag}_once_${p}` });
      if (f.recurring) want.push({ cadence: 'month', amount: p, lookup: `${tag}_month_${p}` });
    }
    const found = new Map<string, any>();
    for (let i = 0; i < want.length; i += 10) {
      const q: Params = [['limit', '100'], ['active', 'true']];
      for (const w of want.slice(i, i + 10)) q.push(['lookup_keys[]', w.lookup]);
      const list = await stripe(this.env, key, 'GET', '/v1/prices', q);
      for (const p of list.data || []) found.set(p.lookup_key, p);
    }
    const prices: Record<string, Record<string, string>> = { once: {}, month: {} };
    for (const w of want) {
      let price = found.get(w.lookup);
      const recurringOk = w.cadence === 'month' ? price?.recurring?.interval === 'month' : !price?.recurring;
      if (price && (price.product !== productId || price.unit_amount !== w.amount || price.currency !== c.currency || !recurringOk)) price = null;
      if (!price) {
        const params: Params = [
          ['product', productId], ['unit_amount', String(w.amount)], ['currency', c.currency], ['lookup_key', w.lookup], ['transfer_lookup_key', 'true'],
          ['nickname', (w.cadence === 'month' ? 'Monthly ' : 'One-time ') + f.name], ['metadata[belong_church]', c.slug], ['metadata[belong_fund]', f.id],
        ];
        if (w.cadence === 'month') params.push(['recurring[interval]', 'month']);
        price = await stripe(this.env, key, 'POST', '/v1/prices', params, `belong-price-${w.lookup}-${productId}`);
      }
      prices[w.cadence][String(w.amount)] = String(price.id);
    }
    this.#sql.exec('UPDATE funds SET product_id = ?, prices = ? WHERE id = ?', productId, JSON.stringify(prices), f.id);
    return { ...f, product_id: productId, prices: JSON.stringify(prices) };
  }

  async #listChurchProducts(key: string, slug: string): Promise<any[]> {
    const out: any[] = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      const q: Params = [['limit', '100']];
      if (after) q.push(['starting_after', after]);
      const list = await stripe(this.env, key, 'GET', '/v1/products', q);
      for (const p of list.data || []) if (p.metadata?.belong_church === slug) out.push(p);
      if (!list.has_more || !list.data?.length) break;
      after = list.data[list.data.length - 1].id;
    }
    return out;
  }

  async #ensureWebhook(key: string, c: ChurchRow): Promise<void> {
    const url = String(this.env.PUBLIC_ORIGIN).replace(/\/+$/, '') + '/api/churches/' + c.slug + '/webhooks/stripe';
    const list = await stripe(this.env, key, 'GET', '/v1/webhook_endpoints', [['limit', '100']]);
    const same = (list.data || []).filter((w: any) => w.url === url);
    const mine = c.webhook_id && c.webhook_secret ? same.find((w: any) => w.id === c.webhook_id) : null;
    if (mine) {
      // Endpoints made by an older version miss newer events (like canceled subscriptions).
      const events: string[] = Array.isArray(mine.enabled_events) ? mine.enabled_events : [];
      if (!events.includes('*') && WEBHOOK_EVENTS.some((e) => !events.includes(e))) {
        const params: Params = [];
        for (const e of WEBHOOK_EVENTS) params.push(['enabled_events[]', e]);
        await stripe(this.env, key, 'POST', '/v1/webhook_endpoints/' + mine.id, params);
      }
      return;
    }
    // An endpoint for this URL whose signing secret we no longer hold is useless; replace it.
    for (const w of same) await stripe(this.env, key, 'DELETE', '/v1/webhook_endpoints/' + w.id).catch(() => null);
    const params: Params = [['url', url], ['description', 'belong. giving for ' + c.name], ['metadata[belong_church]', c.slug]];
    for (const e of WEBHOOK_EVENTS) params.push(['enabled_events[]', e]);
    const hook = await stripe(this.env, key, 'POST', '/v1/webhook_endpoints', params);
    if (!hook.secret) throw new StripeError('Stripe did not return a signing secret.', 502);
    const sealed = await seal(this.env, String(hook.secret), 'webhook-secret:' + c.slug);
    this.#sql.exec("UPDATE church SET webhook_id = ?, webhook_secret = ?, webhook_note = '' WHERE id = 1", String(hook.id), sealed);
  }

  // One customer portal configuration per church, tagged with the church in
  // metadata, so donors can cancel a monthly gift or update their card. Its
  // hosted login page lets a donor sign in with just their email. Re-running
  // setup finds the same configuration again instead of making another.
  async #ensurePortal(key: string, c: ChurchRow): Promise<void> {
    let config: any = null;
    if (c.portal_config_id) config = await stripe(this.env, key, 'GET', '/v1/billing_portal/configurations/' + c.portal_config_id).catch(() => null);
    if (!config || config.metadata?.belong_church !== c.slug) {
      config = null;
      let after = '';
      for (let page = 0; page < 5 && !config; page++) {
        const q: Params = [['limit', '100']];
        if (after) q.push(['starting_after', after]);
        const list = await stripe(this.env, key, 'GET', '/v1/billing_portal/configurations', q);
        config = (list.data || []).find((x: any) => x.metadata?.belong_church === c.slug) || null;
        if (!list.has_more || !list.data?.length) break;
        after = list.data[list.data.length - 1].id;
      }
    }
    const returnUrl = allowedOrigins(this.env)[0] + '/#/give';
    const params: Params = [
      ['features[subscription_cancel][enabled]', 'true'],
      ['features[subscription_cancel][mode]', 'immediately'],
      ['features[subscription_cancel][proration_behavior]', 'none'],
      ['features[payment_method_update][enabled]', 'true'],
      ['features[invoice_history][enabled]', 'true'],
      ['business_profile[headline]', ('Your gifts to ' + c.name).slice(0, 60)],
      ['default_return_url', returnUrl],
      ['login_page[enabled]', 'true'],
    ];
    const ready = config && config.active && config.features?.subscription_cancel?.enabled && config.login_page?.enabled && config.login_page?.url && config.default_return_url === returnUrl;
    if (!config) {
      config = await stripe(
        this.env, key, 'POST', '/v1/billing_portal/configurations',
        [...params, ['name', ('belong. giving for ' + c.name).slice(0, 256)], ['metadata[belong_church]', c.slug]],
        `belong-portal-${c.slug}`
      );
    } else if (!ready) {
      config = await stripe(this.env, key, 'POST', '/v1/billing_portal/configurations/' + config.id, [...params, ['active', 'true']]);
    }
    const url = str(config?.login_page?.url, 500);
    this.#sql.exec("UPDATE church SET portal_config_id = ?, portal_url = ?, portal_note = '' WHERE id = 1", String(config.id), url);
  }

  async #provisionAll(key: string): Promise<{ ok: boolean; created: number; reused: number; error?: string; webhookNote?: string; portalNote?: string }> {
    const c = this.#church()!;
    let created = 0;
    let reused = 0;
    try {
      const known = await this.#listChurchProducts(key, c.slug);
      const knownIds = new Set(known.map((p) => String(p.id)));
      for (const f of this.#funds()) {
        const out = await this.#provisionFund(key, c, f, known);
        if (knownIds.has(out.product_id)) reused++;
        else created++;
      }
    } catch (e: any) {
      const error = e instanceof StripeError ? e.message : 'Stripe setup did not finish.';
      this.#sql.exec('UPDATE church SET provision_error = ? WHERE id = 1', error.slice(0, 300));
      return { ok: false, created, reused, error };
    }
    let webhookNote = '';
    try {
      await this.#ensureWebhook(key, c);
    } catch (e: any) {
      webhookNote = 'Stripe would not create the webhook (' + (e instanceof StripeError ? e.message : 'unknown error') + '). Gifts are still confirmed when donors return to the site.';
      this.#sql.exec('UPDATE church SET webhook_note = ? WHERE id = 1', webhookNote.slice(0, 300));
    }
    let portalNote = '';
    try {
      await this.#ensurePortal(key, this.#church()!);
    } catch (e: any) {
      portalNote = 'Stripe would not set up the page where donors cancel monthly gifts (' + (e instanceof StripeError ? e.message : 'unknown error') + '). Staff can still cancel monthly gifts from the Gifts list.';
      this.#sql.exec('UPDATE church SET portal_note = ? WHERE id = 1', portalNote.slice(0, 300));
    }
    this.#sql.exec("UPDATE church SET provisioned_at = ?, provision_error = '' WHERE id = 1", new Date().toISOString());
    return { ok: true, created, reused, webhookNote, portalNote };
  }

  async #saveFund(request: Request, c: ChurchRow, id: string | null): Promise<Response> {
    const body = await readJson(request);
    const existing = id ? this.#fund(id) : null;
    if (id && !existing) return json({ error: 'Fund not found.' }, 404);
    const kind = existing ? existing.kind : body.kind === 'trip' ? 'trip' : 'fund';
    const name = str(body.name, 100) || existing?.name || '';
    if (!name) return json({ error: kind === 'trip' ? 'Give the trip a title.' : 'Give the fund a name.' }, 400);
    if (!existing && Number(this.#sql.exec('SELECT COUNT(*) AS n FROM funds').toArray()[0].n) >= 60) return json({ error: 'That is the most funds one church can have.' }, 400);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const row = {
      name,
      description: has('description') ? str(body.description, 1000) : existing?.description ?? '',
      goal: has('goal') ? Math.min(cents(body.goal), 10_000_000_000) : Number(existing?.goal ?? 0),
      recurring: kind === 'trip' ? 0 : has('recurring') ? (body.recurring ? 1 : 0) : Number(existing?.recurring ?? 0),
      active: has('active') ? (body.active === false ? 0 : 1) : Number(existing?.active ?? 1),
      start_date: has('startDate') ? isoDate(body.startDate) : existing?.start_date ?? '',
      end_date: has('endDate') ? isoDate(body.endDate) : existing?.end_date ?? '',
      location: has('location') ? str(body.location, 120) : existing?.location ?? '',
      spots: has('spots') ? Math.min(Math.max(0, Math.round(Number(body.spots) || 0)), 10000) : Number(existing?.spots ?? 0),
      applications_open: has('applicationsOpen') ? (body.applicationsOpen ? 1 : 0) : Number(existing?.applications_open ?? (kind === 'trip' ? 1 : 0)),
    };
    if (row.start_date && row.end_date && row.end_date < row.start_date) return json({ error: 'The trip ends before it starts.' }, 400);
    let fundId = id as string;
    if (existing) {
      this.#sql.exec(
        'UPDATE funds SET name = ?, description = ?, goal = ?, recurring = ?, active = ?, start_date = ?, end_date = ?, location = ?, spots = ?, applications_open = ? WHERE id = ?',
        row.name, row.description, row.goal, row.recurring, row.active, row.start_date, row.end_date, row.location, row.spots, row.applications_open, fundId
      );
    } else {
      fundId = (kind === 'trip' ? 'trip-' : 'fund-') + slugify(name).slice(0, 24).replace(/-+$/, '') + '-' + shortId();
      const sort = Number(this.#sql.exec('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM funds').toArray()[0].n);
      this.#sql.exec(
        'INSERT INTO funds (id, kind, name, description, goal, recurring, active, sort, start_date, end_date, location, spots, applications_open, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        fundId, kind, row.name, row.description, row.goal, row.recurring, row.active, sort, row.start_date, row.end_date, row.location, row.spots, row.applications_open, new Date().toISOString()
      );
    }
    let stripeNote = '';
    const f = this.#fund(fundId)!;
    if (this.#mode(c) !== 'demo') {
      try {
        const key = await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug);
        if (f.active) await this.#provisionFund(key, c, f);
        else if (f.product_id) await stripe(this.env, key, 'POST', '/v1/products/' + f.product_id, [['active', 'false']]);
      } catch (e: any) {
        stripeNote = 'Saved, but Stripe was not updated: ' + (e instanceof StripeError ? e.message : 'unknown error') + ' Use "Re-run Stripe setup" to try again.';
      }
    }
    return json({ ...this.#adminOverview(this.#church()!), fundId, stripeNote });
  }

  #donations(c: ChurchRow): Response {
    const rows = this.#sql
      .exec('SELECT g.id, g.cause_id, f.name AS fund, g.amount, g.name, g.email, g.anonymous, g.status, g.cadence, g.created_at, g.session_id, g.canceled_at FROM gifts g LEFT JOIN funds f ON f.id = g.cause_id ORDER BY g.created_at DESC LIMIT 500')
      .toArray()
      .map((r: any) => ({
        id: r.id,
        fundId: r.cause_id,
        fund: r.fund || r.cause_id,
        amount: Number(r.amount),
        // Gifts recorded as anonymous before names became required have no name to show.
        name: Number(r.anonymous) ? '' : r.name,
        email: Number(r.anonymous) ? '' : r.email,
        anonymous: !!Number(r.anonymous),
        status: r.status,
        cadence: r.cadence || 'once',
        createdAt: r.created_at,
        canceled: !!r.canceled_at,
        canceledAt: r.canceled_at,
        // The first gift of a monthly gift, still active. Renewal rows are keyed by their invoice.
        cancelable: r.cadence === 'month' && !r.canceled_at && !String(r.session_id).startsWith('in_') && (r.status === 'completed' || r.status === 'demo'),
      }));
    return json({ currency: c.currency, donations: rows });
  }

  // Staff stop a monthly gift. With Stripe, the subscription is canceled there too.
  async #staffCancel(c: ChurchRow, id: string): Promise<Response> {
    const r = this.#sql.exec('SELECT * FROM gifts WHERE id = ?', id).toArray()[0] as unknown as GiftRow | undefined;
    if (!r) return json({ error: 'Gift not found.' }, 404);
    if (r.cadence !== 'month') return json({ error: 'Only a monthly gift can be canceled.' }, 400);
    if (!r.canceled_at && r.status !== 'demo') {
      if (r.status !== 'completed') return json({ error: 'This monthly gift has not started yet.' }, 400);
      if (!c.stripe_key) return json({ error: 'Connect Stripe to cancel this monthly gift.' }, 400);
      try {
        const key = await unseal(this.env, c.stripe_key, 'stripe-key:' + c.slug);
        let sub = r.subscription_id;
        if (!sub && r.session_id.startsWith('cs_')) sub = stripeId((await stripe(this.env, key, 'GET', '/v1/checkout/sessions/' + r.session_id)).subscription);
        if (!sub) return json({ error: 'Stripe has no monthly gift for this record.' }, 400);
        const out = await stripe(this.env, key, 'DELETE', '/v1/subscriptions/' + sub).catch((e) => {
          // Already canceled in Stripe is fine: just record it here.
          if (e instanceof StripeError && e.status === 404) return null;
          throw e;
        });
        if (out && out.metadata?.belong_church && out.metadata.belong_church !== c.slug) return json({ error: 'That monthly gift belongs to another church.' }, 400);
        this.#sql.exec('UPDATE gifts SET subscription_id = ? WHERE id = ?', sub, r.id);
      } catch (e: any) {
        return json({ error: e instanceof StripeError ? 'Stripe could not cancel it: ' + e.message : 'Stripe could not cancel it.' }, 502);
      }
    }
    this.#sql.exec("UPDATE gifts SET canceled_at = ? WHERE id = ? AND canceled_at = ''", new Date().toISOString(), r.id);
    return this.#donations(c);
  }

  #applications(): Response {
    const rows = this.#sql
      .exec('SELECT a.*, f.name AS trip FROM applications a LEFT JOIN funds f ON f.id = a.fund_id ORDER BY a.created_at DESC LIMIT 1000')
      .toArray()
      .map((r: any) => ({ id: r.id, tripId: r.fund_id, trip: r.trip || r.fund_id, name: r.name, email: r.email, phone: r.phone, message: r.message, status: r.status, note: r.note, createdAt: r.created_at }));
    return json({ applications: rows });
  }

  async #reviewApplication(request: Request, id: string): Promise<Response> {
    const body = await readJson(request);
    const row = this.#sql.exec('SELECT status, note FROM applications WHERE id = ?', id).toArray()[0];
    if (!row) return json({ error: 'Application not found.' }, 404);
    const status = ['new', 'accepted', 'waitlisted', 'declined'].includes(body.status) ? body.status : String(row.status);
    const note = Object.prototype.hasOwnProperty.call(body, 'note') ? str(body.note, 1000) : String(row.note);
    this.#sql.exec('UPDATE applications SET status = ?, note = ?, updated_at = ? WHERE id = ?', status, note, new Date().toISOString(), id);
    return this.#applications();
  }

  // ---------- Legacy single-church endpoints (served by the demo church) ----------

  #readRaw() {
    let row = this.#sql.exec('SELECT church_name, currency, presets, goal FROM config WHERE id = 1').toArray()[0];
    if (!row) {
      this.#sql.exec(
        "INSERT INTO config (id, church_name, currency, presets, goal, causes, price_map, webhook_secret) VALUES (1, 'Grace Community', 'usd', ?, ?, '[]', '{}', '')",
        JSON.stringify(DEMO_PRESETS),
        JSON.stringify({ id: 'general', title: 'Support the mission', amount: 250000 })
      );
      row = this.#sql.exec('SELECT church_name, currency, presets, goal FROM config WHERE id = 1').toArray()[0];
    }
    let presets: number[] = DEMO_PRESETS;
    let goal = { id: 'general', title: 'Support the mission', amount: 250000 };
    try {
      const p = JSON.parse(String(row.presets));
      if (Array.isArray(p)) presets = p.map((n: any) => cents(n)).filter(Boolean);
    } catch {
      /* default */
    }
    try {
      const g = JSON.parse(String(row.goal));
      goal = { id: String(g.id || 'general'), title: String(g.title || 'Goal'), amount: cents(g.amount) };
    } catch {
      /* default */
    }
    return { church_name: String(row.church_name), currency: String(row.currency), presets, goal };
  }

  #legacyConfig(): Response {
    const c = this.#church()!;
    const cfg = this.#readRaw();
    const pub = this.#publicChurch(c);
    return json({
      churchName: c.name,
      currency: c.currency,
      presets: pub.presets,
      goal: cfg.goal,
      raised: pub.totals.raised,
      causes: pub.funds.map((f) => ({ id: f.id, name: f.name, description: f.description })),
      mode: pub.mode === 'demo' ? 'demo' : 'live',
    });
  }

  // ---------- Router (the Worker rewrites paths to /c/... or /legacy/...) ----------

  async fetch(request: Request): Promise<Response> {
    this.#slug = request.headers.get('x-church-slug') || '';
    const p = new URL(request.url).pathname;
    const m = request.method;
    try {
      if (p === '/legacy/config' && m === 'GET') return this.#legacyConfig();
      if (p === '/legacy/gifts' && m === 'GET') {
        const pub = this.#publicChurch(this.#church()!);
        return json({ list: [], count: pub.totals.gifts, raised: pub.totals.raised });
      }
      if (p === '/legacy/checkout' && m === 'POST') return this.#checkout(request, { ...(await readJson(request)), fund: 'general' });
      if (p.startsWith('/legacy/confirm/') && m === 'GET') return this.#confirm(decodeURIComponent(p.slice('/legacy/confirm/'.length)));

      if (p === '/c' && m === 'GET') return this.#getChurch();
      if (p === '/c/checkout' && m === 'POST') return this.#checkout(request, await readJson(request));
      if (p.startsWith('/c/confirm/') && m === 'GET') return this.#confirm(decodeURIComponent(p.slice('/c/confirm/'.length)));
      let r = /^\/c\/trips\/([\w-]{1,60})\/apply$/.exec(p);
      if (r && m === 'POST') return this.#apply(request, r[1]);
      if (p === '/c/webhooks/stripe' && m === 'POST') return this.#webhook(request);
      if (p === '/c/portal' && m === 'POST') return this.#portal(request);
      r = /^\/c\/manage\/([^/]{1,120})(\/cancel)?$/.exec(p);
      if (r && ((m === 'GET' && !r[2]) || (m === 'POST' && r[2]))) return this.#manage(request, r[1], !!r[2]);
      if (p === '/c/admin/login' && m === 'POST') return this.#login(request);
      if (p === '/c/admin/logout' && m === 'POST') return this.#logout(request);

      if (p === '/c/admin' || p.startsWith('/c/admin/')) {
        const c = this.#church();
        if (!c) return json({ error: 'Church not found.' }, 404);
        if (!(await this.#isAdmin(request))) return json({ error: 'Please sign in as church staff.' }, 401);
        if (p === '/c/admin' && m === 'GET') return json(this.#adminOverview(c));
        // The church API Worker asks this to check a staff session for its own staff-only routes.
        if (p === '/c/admin/session' && m === 'GET') return json({ ok: true, slug: c.slug, demo: !!c.demo_locked });
        if (p === '/c/admin/settings' && m === 'PUT') return this.#saveSettings(request, c);
        if (p === '/c/admin/password' && m === 'POST') return this.#changePassword(request, c);
        if (p === '/c/admin/stripe' && m === 'POST') return this.#connectStripe(request, c);
        if (p === '/c/admin/stripe/sync' && m === 'POST') return this.#syncStripe(c);
        if (p === '/c/admin/stripe' && m === 'DELETE') return this.#disconnectStripe(c);
        if (p === '/c/admin/funds' && m === 'POST') return this.#saveFund(request, c, null);
        r = /^\/c\/admin\/funds\/([\w-]{1,60})$/.exec(p);
        if (r && m === 'PUT') return this.#saveFund(request, c, r[1]);
        if (p === '/c/admin/donations' && m === 'GET') return this.#donations(c);
        r = /^\/c\/admin\/donations\/([\w-]{1,60})\/cancel$/.exec(p);
        if (r && m === 'POST') return this.#staffCancel(c, r[1]);
        if (p === '/c/admin/applications' && m === 'GET') return this.#applications();
        r = /^\/c\/admin\/applications\/([\w-]{1,60})$/.exec(p);
        if (r && m === 'PUT') return this.#reviewApplication(request, r[1]);
      }
      return json({ error: 'Not found.' }, 404);
    } catch (err: any) {
      if (err instanceof BadRequest) return json({ error: err.message }, err.status);
      // Name and message only: never the request, which can carry a Stripe key.
      console.error('giving-do', err instanceof Error ? err.name + ': ' + err.message : 'error');
      return json({ error: 'Internal error.' }, 500);
    }
  }
}

// Owns church names and URL slugs, so two churches never share one.
export class GivingRegistry extends DurableObject<GivingEnv> {
  constructor(ctx: DurableObjectState, env: GivingEnv) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS churches (slug TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    sql.exec('CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)');
    sql.exec("INSERT OR IGNORE INTO churches (slug, name, city, created_at) VALUES (?, 'Grace Community', 'Springfield', '2026-09-01T00:00:00.000Z')", DEMO_SLUG);
  }

  #rateOk(k: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const row = sql.exec('SELECT window_start, count FROM rate WHERE k = ?', k).toArray()[0];
    if (!row || now - Number(row.window_start) >= windowMs) {
      sql.exec('INSERT OR REPLACE INTO rate (k, window_start, count) VALUES (?, ?, 1)', k, now);
      return true;
    }
    if (Number(row.count) >= max) return false;
    sql.exec('UPDATE rate SET count = count + 1 WHERE k = ?', k);
    return true;
  }

  async reserve(name: string, city: string, ip: string): Promise<{ slug?: string; error?: string }> {
    if (!this.#rateOk('signup:' + ip, 5, 3_600_000) || !this.#rateOk('signup-all', 200, 3_600_000)) return { error: 'Too many new churches from here. Please try again later.' };
    const base = slugify(name);
    // Slugs become subdomains later (<slug>.<BASE_DOMAIN>), so keep names a site needs for itself.
    const reserved = new Set(['admin', 'api', 'new', 'start', 'give', 'church', 'churches', 'demo', 'www', 'app', 'mail', 'setup', 'staff', 'static']);
    const sql = this.ctx.storage.sql;
    for (let i = 1; i < 50; i++) {
      const slug = i === 1 && !reserved.has(base) ? base : `${base}-${i}`;
      if (!SLUG_RE.test(slug)) continue;
      if (sql.exec('SELECT 1 FROM churches WHERE slug = ?', slug).toArray().length) continue;
      sql.exec('INSERT INTO churches (slug, name, city, created_at) VALUES (?, ?, ?, ?)', slug, name, city, new Date().toISOString());
      return { slug };
    }
    return { error: 'Could not find a free web address for that name. Try a slightly different name.' };
  }

  async release(slug: string): Promise<void> {
    if (slug !== DEMO_SLUG) this.ctx.storage.sql.exec('DELETE FROM churches WHERE slug = ?', slug);
  }

  async rename(slug: string, name: string, city: string): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE churches SET name = ?, city = ? WHERE slug = ?', name, city, slug);
  }

  async get(slug: string): Promise<{ slug: string; name: string; city: string } | null> {
    const r: any = this.ctx.storage.sql.exec('SELECT slug, name, city FROM churches WHERE slug = ?', slug).toArray()[0];
    return r ? { slug: String(r.slug), name: String(r.name), city: String(r.city) } : null;
  }

  async exists(slug: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('SELECT 1 FROM churches WHERE slug = ?', slug).toArray().length > 0;
  }

  // Every church, newest first. Only for the platform team's list (GET /api/platform/churches).
  async all(): Promise<{ slug: string; name: string; city: string; created_at: string }[]> {
    return this.ctx.storage.sql
      .exec('SELECT slug, name, city, created_at FROM churches ORDER BY created_at DESC, slug')
      .toArray()
      .map((r: any) => ({ slug: String(r.slug), name: String(r.name), city: String(r.city), created_at: String(r.created_at) }));
  }

  // Wrong platform keys, per IP, with the same limits as staff sign-in. Only failures count.
  async platformLocked(ip: string): Promise<boolean> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    return [['platform:' + ip, 5, 60_000], ['platform-hour:' + ip, 30, 3_600_000]].some(([k, max, windowMs]) => {
      const row = sql.exec('SELECT window_start, count FROM rate WHERE k = ?', k).toArray()[0];
      return !!row && now - Number(row.window_start) < Number(windowMs) && Number(row.count) >= Number(max);
    });
  }

  async platformFailed(ip: string): Promise<void> {
    this.#rateOk('platform:' + ip, 5, 60_000);
    this.#rateOk('platform-hour:' + ip, 30, 3_600_000);
  }
}

function withCors(response: Response, env: GivingEnv, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', frontendOrigin(request, env));
  headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('access-control-allow-headers', 'Content-Type, Authorization');
  headers.set('access-control-max-age', '600');
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function forward(env: GivingEnv, request: Request, doName: string, slug: string, path: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;
  const req = new Request(url.toString(), request);
  req.headers.set('x-church-slug', slug);
  return env.GIVING.getByName(doName).fetch(req);
}

async function signup(request: Request, env: GivingEnv): Promise<Response> {
  let body: any;
  try {
    body = await readJson(request);
  } catch (e: any) {
    return json({ error: e.message }, 400);
  }
  const name = str(body.name, 80);
  const city = str(body.city, 80);
  const currency = CURRENCIES.includes(body.currency) ? body.currency : 'usd';
  const password = typeof body.password === 'string' ? body.password : '';
  if (name.length < 3) return json({ error: 'Add your church name.' }, 400);
  if (password.length < 10 || password.length > 200) return json({ error: 'Choose a staff password of at least 10 characters.' }, 400);
  const registry = env.GIVING_REGISTRY.getByName('registry');
  const reserved = await registry.reserve(name, city, request.headers.get('cf-connecting-ip') || 'anon');
  if (!reserved.slug) return json({ error: reserved.error || 'Could not create the church.' }, 429);
  const out = await env.GIVING.getByName('church:' + reserved.slug).init(reserved.slug, name, city, currency, password);
  if (!out.token) {
    await registry.release(reserved.slug);
    return json({ error: out.error || 'Could not create the church.' }, 409);
  }
  return json({ slug: reserved.slug, name, token: out.token }, 201);
}

// Every church, for the platform team only (the #/platform page). Churches never see this list.
// Off (404) until the PLATFORM_ADMIN_KEY secret is set; then it needs Authorization: Bearer <key>.
async function platformChurches(request: Request, env: GivingEnv): Promise<Response> {
  const secret = String(env.PLATFORM_ADMIN_KEY || '');
  if (!secret) return json({ error: 'Not found.' }, 404);
  const m = /^Bearer\s+(\S{1,300})$/.exec(request.headers.get('authorization') || '');
  if (!m) return json({ error: 'Enter the platform key.' }, 401);
  const registry = env.GIVING_REGISTRY.getByName('registry');
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  if (await registry.platformLocked(ip)) return json({ error: 'Too many wrong keys. Wait a minute and try again.' }, 429);
  // Compare digests, so neither the length nor the content of the key leaks via timing.
  if (!ctEqual(await sha256(m[1]), await sha256(secret))) {
    await registry.platformFailed(ip);
    return json({ error: 'That platform key is not right.' }, 401);
  }
  const rows = await registry.all();
  const out: { slug: string; name: string; city: string; createdAt: string; demo: boolean; giving: PlatformGiving | null }[] = [];
  // A few churches at a time, so a long list does not open every Durable Object at once.
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const giving = await Promise.all(
      batch.map((r) => env.GIVING.getByName(r.slug === DEMO_SLUG ? 'main' : 'church:' + r.slug).platformSummary(r.slug).catch(() => null))
    );
    batch.forEach((r, j) => out.push({ slug: r.slug, name: r.name, city: r.city, createdAt: r.created_at, demo: r.slug === DEMO_SLUG, giving: giving[j] }));
  }
  return json({ churches: out });
}

async function route(request: Request, env: GivingEnv): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;
  if (p === '/api/health' && m === 'GET') return json({ ok: true, churches: true, ts: new Date().toISOString() });

  // The original single-church API, kept for the home page and older builds. It is the demo church.
  if (p === '/api/config' && m === 'GET') return forward(env, request, 'main', DEMO_SLUG, '/legacy/config');
  if (p === '/api/gifts' && m === 'GET') return forward(env, request, 'main', DEMO_SLUG, '/legacy/gifts');
  if (p === '/api/checkout' && m === 'POST') return forward(env, request, 'main', DEMO_SLUG, '/legacy/checkout');
  if (p.startsWith('/api/confirm/') && m === 'GET') return forward(env, request, 'main', DEMO_SLUG, '/legacy/confirm/' + p.slice('/api/confirm/'.length));

  // Churches do not see each other: each one is reached by its own link or subdomain, so there is no
  // public list or search. Older builds still ask for a list, so this answers with only the public
  // demo church, whatever the query.
  if (p === '/api/churches' && m === 'GET') {
    const demo = await env.GIVING_REGISTRY.getByName('registry').get(DEMO_SLUG);
    return json({ churches: demo ? [demo] : [] });
  }
  if (p === '/api/churches' && m === 'POST') return signup(request, env);
  if (p === '/api/platform/churches' && m === 'GET') return platformChurches(request, env);
  // One church's public listing (name and city), straight from the registry. The church API uses it to
  // check that a church exists before it opens that church's database.
  const listing = /^\/api\/directory\/([^/]+)$/.exec(p);
  if (listing && m === 'GET') {
    const found = SLUG_RE.test(listing[1]) ? await env.GIVING_REGISTRY.getByName('registry').get(listing[1]) : null;
    return found ? json(found) : json({ error: 'Church not found.' }, 404);
  }

  const r = /^\/api\/churches\/([^/]+)(\/.*)?$/.exec(p);
  if (r) {
    const slug = r[1];
    if (!SLUG_RE.test(slug)) return json({ error: 'Church not found.' }, 404);
    if (slug !== DEMO_SLUG && !(await env.GIVING_REGISTRY.getByName('registry').exists(slug))) return json({ error: 'Church not found.' }, 404);
    return forward(env, request, slug === DEMO_SLUG ? 'main' : 'church:' + slug, slug, '/c' + (r[2] || ''));
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request: Request, env: GivingEnv): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), env, request);
    return withCors(await route(request, env), env, request);
  },
};
