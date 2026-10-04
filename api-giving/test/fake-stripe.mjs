// Minimal fake of the Stripe REST API endpoints the giving Worker uses.
// Keys: sk_test_* / sk_live_* starting with "sk_test_GOOD" or "sk_live_GOOD" are accepted,
// rk_test_NOHOOK... accepts everything except webhook endpoints (403), anything else is 401.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 12111);
const accounts = new Map(); // key -> state
const log = [];
const idem = new Map();
let seq = 0;
const id = (p) => `${p}_${(++seq).toString().padStart(6, '0')}${crypto.randomBytes(4).toString('hex')}`;

function state(key) {
  const acct = key.replace(/^(sk|rk)_/, '').slice(0, 14);
  if (!accounts.has(acct)) accounts.set(acct, { products: [], prices: [], hooks: [], sessions: [] });
  return accounts.get(acct);
}
function meta(params) {
  const m = {};
  for (const [k, v] of Object.entries(params)) {
    const r = /^metadata\[(.+)\]$/.exec(k);
    if (r) m[r[1]] = v;
  }
  return m;
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function err(res, status, message) {
  send(res, status, { error: { message, type: 'invalid_request_error' } });
}
function list(data, q) {
  let items = [...data].sort((a, b) => b.created - a.created || (b.id < a.id ? -1 : 1));
  if (q.starting_after) {
    const i = items.findIndex((x) => x.id === q.starting_after);
    items = items.slice(i + 1);
  }
  const limit = Number(q.limit || 10);
  return { object: 'list', data: items.slice(0, limit), has_more: items.length > limit };
}

async function deliver(s, sess, type) {
  for (const h of s.hooks) {
    if (!h.enabled_events.includes(type)) continue;
    const payload = JSON.stringify({ id: id('evt'), type, data: { object: sess } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', h.secret).update(`${t}.${payload}`).digest('hex');
    try {
      const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
      log.push({ webhook: h.url, type, status: r.status });
    } catch (e) {
      log.push({ webhook: h.url, type, error: String(e) });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const params = {};
  const multi = {};
  const src = req.method === 'GET' || req.method === 'DELETE' ? url.searchParams : new URLSearchParams(raw);
  for (const [k, v] of src) {
    params[k] = v;
    (multi[k] ||= []).push(v);
  }
  const p = url.pathname;

  if (p === '/__log') return send(res, 200, { log, accounts: Object.fromEntries([...accounts].map(([k, v]) => [k, { products: v.products.length, prices: v.prices.length, hooks: v.hooks.length, sessions: v.sessions.length, productList: v.products, priceList: v.prices, hookList: v.hooks.map((h) => ({ id: h.id, url: h.url })) }])) });
  if (p === '/__reset') { accounts.clear(); log.length = 0; idem.clear(); return send(res, 200, { ok: true }); }

  // Hosted checkout page stand-in: pay, fire the webhook, then return to success_url.
  let m = /^\/pay\/(cs_\w+)$/.exec(p);
  if (m) {
    for (const s of accounts.values()) {
      const sess = s.sessions.find((x) => x.id === m[1]);
      if (!sess) continue;
      if (url.searchParams.get('cancel')) { res.writeHead(302, { location: sess.cancel_url }); return res.end(); }
      sess.status = 'complete';
      sess.payment_status = 'paid';
      if (url.searchParams.get('hook') !== '0') await deliver(s, sess, 'checkout.session.completed');
      res.writeHead(302, { location: sess.success_url.replace('{CHECKOUT_SESSION_ID}', sess.id) });
      return res.end();
    }
    return err(res, 404, 'No such session');
  }

  const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const key = auth ? auth[1] : '';
  log.push({ method: req.method, path: p, idem: req.headers['idempotency-key'] || '', keyPrefix: key.slice(0, 12), params: Object.keys(params).length });
  const good = /^(sk|rk)_(test|live)_GOOD/.test(key) || /^rk_test_NOHOOK/.test(key);
  if (!good) return err(res, 401, `Invalid API Key provided: ${key.slice(0, 8)}****${key.slice(-4)}`);
  const s = state(key);
  const ik = req.headers['idempotency-key'];
  if (ik && req.method === 'POST') {
    const prior = idem.get(key + '|' + ik);
    if (prior) return send(res, 200, prior);
  }
  const done = (body) => { if (ik && req.method === 'POST') idem.set(key + '|' + ik, body); send(res, 200, body); };
  const now = Math.floor(Date.now() / 1000) + seq;

  if (p === '/v1/account' && req.method === 'GET') {
    if (key.startsWith('rk_')) return err(res, 403, 'The provided key does not have the required permissions.');
    return send(res, 200, { id: 'acct_mock', settings: { dashboard: { display_name: 'Mock Church Ministries' } } });
  }
  if (p === '/v1/products' && req.method === 'GET') return send(res, 200, list(s.products, params));
  if (p === '/v1/products' && req.method === 'POST') {
    if (!params.name) return err(res, 400, 'Missing required param: name.');
    const prod = { id: id('prod'), object: 'product', name: params.name, description: params.description || null, active: true, metadata: meta(params), created: now };
    s.products.push(prod);
    return done(prod);
  }
  m = /^\/v1\/products\/(prod_\w+)$/.exec(p);
  if (m) {
    const prod = s.products.find((x) => x.id === m[1]);
    if (!prod) return err(res, 404, 'No such product');
    if (req.method === 'POST') {
      if (params.name) prod.name = params.name;
      if (params.active) prod.active = params.active === 'true';
    }
    return send(res, 200, prod);
  }
  if (p === '/v1/prices' && req.method === 'GET') {
    let items = s.prices;
    if (multi['lookup_keys[]']) {
      if (multi['lookup_keys[]'].length > 10) return err(res, 400, 'Too many lookup_keys');
      items = items.filter((x) => multi['lookup_keys[]'].includes(x.lookup_key));
    }
    if (params.active) items = items.filter((x) => String(x.active) === params.active);
    return send(res, 200, list(items, params));
  }
  if (p === '/v1/prices' && req.method === 'POST') {
    const prod = s.products.find((x) => x.id === params.product);
    if (!prod) return err(res, 400, 'No such product: ' + params.product);
    if (!params.currency || !params.unit_amount) return err(res, 400, 'Missing currency or unit_amount');
    if (params.lookup_key) {
      const other = s.prices.find((x) => x.lookup_key === params.lookup_key);
      if (other) {
        if (params.transfer_lookup_key !== 'true') return err(res, 400, 'A price with this lookup_key already exists.');
        other.lookup_key = null;
      }
    }
    const price = { id: id('price'), object: 'price', product: prod.id, unit_amount: Number(params.unit_amount), currency: params.currency, lookup_key: params.lookup_key || null, nickname: params.nickname || null, active: true, recurring: params['recurring[interval]'] ? { interval: params['recurring[interval]'] } : null, metadata: meta(params), created: now };
    s.prices.push(price);
    return done(price);
  }
  if (p === '/v1/webhook_endpoints') {
    if (key.startsWith('rk_test_NOHOOK')) return err(res, 403, 'The provided key does not have access to webhook endpoints.');
    if (req.method === 'GET') return send(res, 200, list(s.hooks.map(({ secret, ...h }) => h), params));
    if (req.method === 'POST') {
      if (!/^https?:\/\//.test(params.url || '')) return err(res, 400, 'Invalid URL');
      const hook = { id: id('we'), object: 'webhook_endpoint', url: params.url, enabled_events: multi['enabled_events[]'] || [], metadata: meta(params), secret: 'whsec_' + crypto.randomBytes(16).toString('hex'), created: now };
      s.hooks.push(hook);
      return done(hook);
    }
  }
  m = /^\/v1\/webhook_endpoints\/(we_\w+)$/.exec(p);
  if (m && req.method === 'DELETE') {
    s.hooks = s.hooks.filter((h) => h.id !== m[1]);
    return send(res, 200, { id: m[1], deleted: true });
  }
  if (p === '/v1/checkout/sessions' && req.method === 'POST') {
    if (!params.success_url || !params.mode) return err(res, 400, 'Missing success_url or mode');
    const priceId = params['line_items[0][price]'];
    let amount;
    if (priceId) {
      const price = s.prices.find((x) => x.id === priceId);
      if (!price) return err(res, 400, 'No such price: ' + priceId);
      if (params.mode === 'subscription' && !price.recurring) return err(res, 400, 'Subscription mode needs a recurring price');
      if (params.mode === 'payment' && price.recurring) return err(res, 400, 'Payment mode cannot use a recurring price');
      amount = price.unit_amount;
    } else {
      amount = Number(params['line_items[0][price_data][unit_amount]']);
      const prodId = params['line_items[0][price_data][product]'];
      if (prodId && !s.products.find((x) => x.id === prodId)) return err(res, 400, 'No such product: ' + prodId);
      if (params.mode === 'subscription' && !params['line_items[0][price_data][recurring][interval]']) return err(res, 400, 'Subscription mode needs recurring');
    }
    const sid = id('cs_test');
    const sess = { id: sid, object: 'checkout.session', mode: params.mode, amount_total: amount, currency: params['line_items[0][price_data][currency]'] || 'usd', status: 'open', payment_status: 'unpaid', metadata: meta(params), success_url: params.success_url, cancel_url: params.cancel_url, url: `http://localhost:${PORT}/pay/${sid}`, line_price: priceId || null, submit_type: params.submit_type || null, created: now };
    s.sessions.push(sess);
    return done(sess);
  }
  m = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(p);
  if (m && req.method === 'GET') {
    const sess = s.sessions.find((x) => x.id === m[1]);
    return sess ? send(res, 200, sess) : err(res, 404, 'No such checkout session');
  }
  err(res, 404, 'Unrecognized request URL (' + req.method + ' ' + p + ')');
});
server.listen(PORT, () => console.log('fake stripe on', PORT));
