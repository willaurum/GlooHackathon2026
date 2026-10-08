// The site editor's API (GET/PUT/DELETE/POST /api/church/editor...): staff only, so every call sends this tab's
// staff session for the church. It goes straight to the church API, never through a site preview.
import { STAFF_SESSION_INVALID, apiUrl } from './api.js';
import { clearRejectedStaffToken, getStaffToken } from './church.js';

export async function editorApi(slug, path = '', { method = 'GET', body } = {}) {
  const token = getStaffToken(slug);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(apiUrl('/church/editor' + path, slug), {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
export const saveDraft = (slug, version, ops) => editorApi(slug, '/draft', { method: 'PUT', body: { version, ops } });
export const discardDraft = slug => editorApi(slug, '/draft', { method: 'DELETE' });
export const askTekton = (slug, request, viewing, version) => editorApi(slug, '/ask', { method: 'POST', body: { request, viewing, version } });
export const publishDraft = (slug, version) => editorApi(slug, '/publish', { method: 'POST', body: { version } });
export const restorePrevious = slug => editorApi(slug, '/restore', { method: 'POST', body: {} });
