import { apiHeaders, apiUrl, gapi } from './api.js';
import { DEMO_CHURCH, setStaffToken } from './church.js';

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof body.detail === 'string' ? body.detail : body.error || `Request failed (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// Bare public routes work even when this browser last visited a missing church. No credentials needed.
export const draftApi = (path = '', options = {}) => request(apiUrl('/builder/drafts' + path, DEMO_CHURCH), {
  ...options, headers: { 'Content-Type': 'application/json' },
});

export async function createFromDraft(draftId, account, created, onCreated) {
  let church = created;
  if (!church) {
    try { church = await gapi('/api/churches', { method: 'POST', body: JSON.stringify(account) }); }
    catch (err) { if (err.status === 403) err.registrationClosed = true; throw err; }
    setStaffToken(church.slug, church.token, { verified: true });
    // Retain the target before apply: a failed apply must never cause another signup.
    onCreated({ slug: church.slug, draftId, token: church.token });
  }
  const headers = await apiHeaders(church.slug, { 'Content-Type': 'application/json' });
  // The fresh response also works when this browser cannot use sessionStorage.
  if (church.token) headers.Authorization = 'Bearer ' + church.token;
  return request(apiUrl('/builder/drafts/' + encodeURIComponent(draftId) + '/apply', church.slug), {
    method: 'POST', headers,
  });
}
