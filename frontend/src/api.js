import { DEMO_CHURCH, clearRejectedStaffToken, getStaffToken } from './church.js';

// API origin; empty means same-origin /api (Vite proxy, nginx).
export const API_BASE = import.meta.env?.VITE_API_BASE ?? '';
// The giving API is its own Worker (api-giving/); the page calls it cross-origin.
const GIVING_API = import.meta.env?.VITE_GIVING_API_BASE ?? 'https://gloo-hackathon2026-api-donate-giving.jaronwilson2025.workers.dev';
const KEY_STORAGE = 'pastor-notes-api-key';
// Matches STAFF_SESSION_INVALID in api/churches.ts.
export const STAFF_SESSION_INVALID = 'staff_session_invalid';

// The API key is typed in by the user and kept for this browser tab only. It is never built into the bundle.
// A site preview never reads or changes the real site's key.
export const getApiKey = () => (preview ? '' : sessionStorage.getItem(KEY_STORAGE) ?? '');
export const setApiKey = key => {
  if (preview) return;
  key ? sessionStorage.setItem(KEY_STORAGE, key) : sessionStorage.removeItem(KEY_STORAGE);
};

// The church every api() call is for. App sets it from church.js.
let church = DEMO_CHURCH;
export const setApiChurch = slug => { church = slug; };

let preview;
export const startApiPreview = snapshot => { preview = structuredClone(snapshot); };
export const stopApiPreview = () => { preview = null; };
const PREVIEW_ERROR = 'This is a preview. Create your church to use this.';

function previewResponse(path, options) {
  if ((options.method || 'GET').toUpperCase() !== 'GET') throw new Error(PREVIEW_ERROR);
  const key = path.split('?')[0].slice(1);
  if (['info', 'church', 'ministries', 'events'].includes(key)) return structuredClone(preview[key]);
  const page = /^church\/pages\/([a-z0-9-]+)$/.exec(key);
  if (page) {
    const found = (preview.pages || []).find(p => p.slug === page[1]);
    if (!found) throw Object.assign(new Error('Page not found'), { status: 404 });
    return structuredClone(found);
  }
  if (['connections', 'requests', 'regions', 'news', 'notes', 'blog', 'blog/categories'].includes(key)) return [];
  throw new Error(PREVIEW_ERROR);
}

// /api/churches/<slug>/... is that church. The bare /api/... is the demo church, which every
// API version understands, so the demo church keeps working against an older deploy.
export const apiUrl = (path, slug = church) => API_BASE + (slug === DEMO_CHURCH ? '/api' : '/api/churches/' + encodeURIComponent(slug)) + path;

let capabilities;
// Whether the church API serves more than the demo church yet (it is deployed separately from the site).
export function churchCapabilities() {
  if (preview) return Promise.resolve({ churches: true });
  // A failed check means "unavailable", not "demo church only": don't remember it, so the next call asks again.
  capabilities ||= fetch(API_BASE + '/api/health')
    .then(r => { if (!r.ok) throw new Error('health ' + r.status); return r.json(); })
    .then(h => ({ churches: !!h.churches }), () => { capabilities = null; return { churches: false, unavailable: true }; });
  return capabilities;
}

/** Report whether a service has church accounts once it is known, checking again every 5s while it is
 *  unreachable (rather than reporting "not yet"). Returns a cleanup for useEffect. */
export function whenCapabilitiesKnown(check, onKnown) {
  let retry, live = true;
  const run = () => check().then(c => {
    if (!live) return;
    if (c.unavailable) retry = setTimeout(run, 5000);
    else onKnown(c.churches);
  });
  run();
  return () => { live = false; clearTimeout(retry); };
}

/** Headers for a church API call: the Sermon Notes key and, once the API supports it, the staff session. */
export async function apiHeaders(slug = church, extra = {}) {
  if (preview) throw new Error(PREVIEW_ERROR);
  const headers = { ...extra };
  if (getApiKey()) headers['X-API-Key'] = getApiKey();
  // An older API does not allow this header cross-origin, so only send it once the API knows churches.
  if (getStaffToken(slug) && (await churchCapabilities()).churches) headers.Authorization = 'Bearer ' + getStaffToken(slug);
  return headers;
}

export async function api(path, options = {}) {
  if (preview) return previewResponse(path, options);
  const slug = church;
  const capabilities = slug === DEMO_CHURCH ? null : await churchCapabilities();
  if (capabilities && !capabilities.churches) {
    const error = new Error(capabilities.unavailable
      ? 'The church service is unavailable right now. Please try again.'
      : 'This part of the site opens once the updated church service is deployed.');
    error.status = capabilities.unavailable ? 503 : 'not-ready';
    throw error;
  }
  const headers = await apiHeaders(slug, { 'Content-Type': 'application/json', ...options.headers });
  const sentToken = headers.Authorization?.replace(/^Bearer /, '') || '';
  const response = await fetch(apiUrl(path, slug), { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      // Only the API's explicit "this session was rejected" signal drops the token: a 401 for a missing
      // API key (Sermon Notes, the AI model setting) must not sign valid staff out.
      if (body.code === STAFF_SESSION_INVALID) clearRejectedStaffToken(slug, sentToken);
      const error = new Error(typeof body.detail === 'string' ? body.detail : 'Please sign in as church staff.');
      error.status = 401;
      throw error;
    }
    const error = new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function gapi(path, options = {}) {
  if (preview) throw new Error(PREVIEW_ERROR);
  const res = await fetch(GIVING_API + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || `Request failed (${res.status}). Please try again.`);
    error.status = res.status;
    throw error;
  }
  return body;
}

export function fmt(minor, currency) {
  const sym = currency === 'usd' ? '$' : currency === 'gbp' ? '£' : currency === 'eur' ? '€' : (currency || '').toUpperCase() + ' ';
  const n = (minor / 100).toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(minor / 100) ? 0 : 2, maximumFractionDigits: 2 });
  return sym + n;
}
