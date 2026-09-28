// API origin; empty means same-origin /api (Vite proxy, nginx).
const API_BASE = import.meta.env.VITE_API_BASE ?? '';
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
    if (response.status === 401) throw new Error('Enter a valid API key on the Pastor Notes page.');
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status}). Please try again.`);
  }
  return response.status === 204 ? null : response.json();
}
