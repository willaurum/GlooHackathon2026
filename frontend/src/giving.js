import { gapi } from './api.js';
import { DEMO_CHURCH, getStaffToken, setStaffToken } from './church.js';

// The built-in demo church. Its page also works against an older giving API
// that only has the single-church endpoints (/api/config, /api/checkout).
// Which church is showing is decided for the whole site in church.js.
export { DEMO_CHURCH, getStaffToken, setStaffToken };

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

export function startCheckout(church, gift) {
  if (church.legacy) return gapi('/api/checkout', { method: 'POST', body: JSON.stringify(gift) });
  return churchApi(church.slug, '/checkout', { method: 'POST', body: JSON.stringify(gift) });
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
