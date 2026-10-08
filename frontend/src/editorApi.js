// The site editor's API (GET/PUT/DELETE/POST /api/church/editor...): staff only, so every call sends this tab's
// staff session for the church. It goes straight to the church API, never through a site preview.
import { STAFF_SESSION_INVALID, apiUrl } from './api.js';
import { clearRejectedStaffToken, getStaffToken } from './church.js';

export async function editorApi(slug, path = '', { method = 'GET', body, keepalive = false } = {}) {
  const token = getStaffToken(slug);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(apiUrl('/church/editor' + path, slug), {
    method, headers, ...(keepalive ? { keepalive } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Only the API's "this session was rejected" signal signs staff out, as in api().
    if (response.status === 401 && data.code === STAFF_SESSION_INVALID) clearRejectedStaffToken(slug, token);
    const fallback = response.status === 401 ? 'Please sign in as church staff.'
      : response.status === 429 ? 'Too many requests. Please wait a few minutes and try again.'
        : `Request failed (${response.status}). Please try again.`;
    throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : fallback), { status: response.status, op: data.op || null });
  }
  return data;
}

export const loadEditor = slug => editorApi(slug);
// A page that is closing can still send up to 64 KB (fetch keepalive); a larger draft goes as a usual request.
export const KEEPALIVE_BYTES = 60 * 1024;
export const fitsKeepalive = body => new TextEncoder().encode(JSON.stringify(body)).byteLength <= KEEPALIVE_BYTES;

/** Save the draft. With `keepalive` (the page is closing) it is sent so it finishes after the page is gone, when it
 *  fits; the returned promise says whether it went that way (`.keepalive`). */
export function saveDraft(slug, version, ops, { keepalive = false } = {}) {
  const body = { version, ops };
  const kept = keepalive && fitsKeepalive(body);
  return Object.assign(editorApi(slug, '/draft', { method: 'PUT', body, keepalive: kept }), { keepalive: kept });
}
export const discardDraft = slug => editorApi(slug, '/draft', { method: 'DELETE' });
export const askTekton = (slug, request, viewing, version) => editorApi(slug, '/ask', { method: 'POST', body: { request, viewing, version } });
export const publishDraft = (slug, version) => editorApi(slug, '/publish', { method: 'POST', body: { version } });
export const restorePrevious = slug => editorApi(slug, '/restore', { method: 'POST', body: {} });
