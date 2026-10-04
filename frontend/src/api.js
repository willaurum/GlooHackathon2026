// API origin; empty means same-origin /api (Vite proxy, nginx).
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';
// The giving API is its own Worker (api-giving/); the page calls it cross-origin.
const GIVING_API = import.meta.env.VITE_GIVING_API_BASE ?? 'https://gloo-hackathon2026-api-donate-giving.jaronwilson2025.workers.dev';
const KEY_STORAGE = 'pastor-notes-api-key';

// The API key is typed in by the user and kept for this browser tab only. It is never built into the bundle.
export const getApiKey = () => sessionStorage.getItem(KEY_STORAGE) ?? '';
export const setApiKey = key => (key ? sessionStorage.setItem(KEY_STORAGE, key) : sessionStorage.removeItem(KEY_STORAGE));

export async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (getApiKey()) headers['X-API-Key'] = getApiKey();
  const response = await fetch(API_BASE + '/api' + path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Enter a valid API key on the Sermon Notes page.');
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
