import { gapi } from './api.js';

// The built-in demo church. Its page also works against an older giving API
// that only has the single-church endpoints (/api/config, /api/checkout).
export const DEMO_CHURCH = 'grace-community';
const CHURCH_KEY = 'belong-give-church';
const staffKey = slug => 'belong-staff:' + slug;

export function getGiveChurch() {
  try { return localStorage.getItem(CHURCH_KEY) || DEMO_CHURCH; } catch { return DEMO_CHURCH; }
}
export function setGiveChurch(slug) {
  try { localStorage.setItem(CHURCH_KEY, slug); } catch { /* private mode */ }
}

// Staff sessions last for this browser tab only, like the Sermon Notes key.
export const getStaffToken = slug => sessionStorage.getItem(staffKey(slug)) ?? '';
export const setStaffToken = (slug, token) => (token ? sessionStorage.setItem(staffKey(slug), token) : sessionStorage.removeItem(staffKey(slug)));

export const churchApi = (slug, path = '', options = {}) => gapi('/api/churches/' + encodeURIComponent(slug) + path, options);

export async function staffApi(slug, path, options = {}) {
  try {
    return await churchApi(slug, '/admin' + path, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + getStaffToken(slug) } });
  } catch (err) {
    if (err.status === 401) setStaffToken(slug, '');
    throw err;
  }
}

let capabilities;
// Whether the giving API has church accounts yet (it is deployed separately from the site).
export function givingCapabilities() {
  capabilities ||= gapi('/api/health').then(h => ({ churches: !!h.churches })).catch(() => ({ churches: false }));
  return capabilities;
}

export async function loadChurch(slug) {
  try {
    return await churchApi(slug);
  } catch (err) {
    if (err.status === 404 && slug === DEMO_CHURCH && !(await givingCapabilities()).churches) return legacyChurch(await gapi('/api/config'));
    throw err;
  }
}

function legacyChurch(cfg) {
  const goal = cfg.goal || {};
  return {
    slug: DEMO_CHURCH, name: cfg.churchName || 'Grace Community', city: 'Springfield', currency: cfg.currency || 'usd',
    presets: cfg.presets?.length ? cfg.presets : [100, 5000, 10000, 15000], mode: cfg.mode === 'demo' ? 'demo' : 'live', legacy: true,
    funds: [{ id: 'general', kind: 'fund', name: goal.title || 'General giving', description: 'Support the day-to-day life and ministry of the church.', goal: goal.amount || 0, raised: cfg.raised || 0, gifts: null, recurring: false }],
    trips: [], totals: { raised: cfg.raised || 0, gifts: null },
  };
}

export async function startCheckout(church, gift) {
  const res = church.legacy
    ? await gapi('/api/checkout', { method: 'POST', body: JSON.stringify(gift) })
    : await churchApi(church.slug, '/checkout', { method: 'POST', body: JSON.stringify(gift) });
  if (res.manage) {
    try { saveManageLink(new URL(res.url).searchParams.get('session_id') || '', res.manage); } catch { /* keep going */ }
  }
  return res;
}

// Private links to manage a demo monthly gift, kept in this browser so the
// donor can find them again from "Manage or cancel a monthly gift".
const MANAGE_KEY = 'belong-monthly-gifts';
export function savedManageLinks() {
  try {
    const list = JSON.parse(localStorage.getItem(MANAGE_KEY) || '[]');
    return Array.isArray(list) ? list.filter(x => x && typeof x.token === 'string') : [];
  } catch { return []; }
}
export function saveManageLink(session, token) {
  try { localStorage.setItem(MANAGE_KEY, JSON.stringify([{ session, token, at: Date.now() }, ...savedManageLinks().filter(x => x.token !== token)].slice(0, 20))); }
  catch { /* private mode */ }
}
export const manageLinkFor = session => savedManageLinks().find(x => x.session === session)?.token || '';
// A manage token is "<church slug>.<secret>".
export function splitManageToken(token) {
  const m = /^([a-z0-9-]{1,40})\.([\w-]{20,100})$/.exec(token || '');
  return m ? { slug: m[1], secret: m[2] } : null;
}

export const percent = (raised, goal) => (goal ? Math.min(100, Math.round((raised / goal) * 100)) : 0);

export function tripDates(start, end) {
  const f = (s, opts) => new Date(s + 'T12:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
  if (!start) return '';
  if (!end || end === start) return f(start, { month: 'short', day: 'numeric', year: 'numeric' });
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return f(start, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }) + ' to ' + f(end, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function friendly(err) {
  if (!err) return '';
  if (err instanceof TypeError) return 'Could not reach the giving service. Check your connection and try again.';
  return err.message || 'Something went wrong. Please try again.';
}
