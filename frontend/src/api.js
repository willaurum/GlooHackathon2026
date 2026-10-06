import { DEMO_CHURCH, getStaffToken, setStaffToken } from './church.js';

// API origin; empty means same-origin /api (Vite proxy, nginx).
export const API_BASE = import.meta.env?.VITE_API_BASE ?? '';
// The giving API is its own Worker (api-giving/); the page calls it cross-origin.
const GIVING_API = import.meta.env?.VITE_GIVING_API_BASE ?? 'https://gloo-hackathon2026-api-donate-giving.jaronwilson2025.workers.dev';
const KEY_STORAGE = 'pastor-notes-api-key';

// The API key is typed in by the user and kept for this browser tab only. It is never built into the bundle.
export const getApiKey = () => sessionStorage.getItem(KEY_STORAGE) ?? '';
export const setApiKey = key => (key ? sessionStorage.setItem(KEY_STORAGE, key) : sessionStorage.removeItem(KEY_STORAGE));

// The church every api() call is for. App sets it from church.js.
let church = DEMO_CHURCH;
export const setApiChurch = slug => { church = slug; };

// /api/churches/<slug>/... is that church. The bare /api/... is the demo church, which every
// API version understands, so the demo church keeps working against an older deploy.
export const apiUrl = (path, slug = church) => API_BASE + (slug === DEMO_CHURCH ? '/api' : '/api/churches/' + encodeURIComponent(slug)) + path;

let capabilities;
// Whether the church API serves more than the demo church yet (it is deployed separately from the site).
export function churchCapabilities() {
  capabilities ||= fetch(API_BASE + '/api/health').then(r => r.json()).then(h => ({ churches: !!h.churches })).catch(() => ({ churches: false }));
  return capabilities;
}

/** Headers for a church API call: the Sermon Notes key and, once the API supports it, the staff session. */
export async function apiHeaders(slug = church, extra = {}) {
  const headers = { ...extra };
  if (getApiKey()) headers['X-API-Key'] = getApiKey();
  // An older API does not allow this header cross-origin, so only send it once the API knows churches.
  if (getStaffToken(slug) && (await churchCapabilities()).churches) headers.Authorization = 'Bearer ' + getStaffToken(slug);
  return headers;
}

export async function api(path, options = {}) {
  const slug = church;
  if (slug !== DEMO_CHURCH && !(await churchCapabilities()).churches) {
    const error = new Error('This part of the site opens once the updated church service is deployed.');
    error.status = 'not-ready';
    throw error;
  }
  const headers = await apiHeaders(slug, { 'Content-Type': 'application/json', ...options.headers });
  const sentToken = headers.Authorization?.replace(/^Bearer /, '') || '';
  const response = await fetch(apiUrl(path, slug), { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      if (body.detail === 'Please sign in as church staff.' && sentToken && getStaffToken(slug) === sentToken) setStaffToken(slug, '');
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
