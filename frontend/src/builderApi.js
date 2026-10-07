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

export const createBlank = () => draftApi('/blank', { method: 'POST' });

export const itemApi = (draftId, body) => draftApi('/' + encodeURIComponent(draftId) + '/items', { method: 'POST', body: JSON.stringify(body) });

export const partApi = (draftId, body) => draftApi('/' + encodeURIComponent(draftId) + '/parts', { method: 'POST', body: JSON.stringify(body) });

export const draftPageApi = (draftId, pageId) => draftApi('/' + encodeURIComponent(draftId) + '/pages/' + encodeURIComponent(pageId));

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** A website import runs in the background: poll its draft until it is no longer 'importing'. Each poll is
 * passed to onUpdate. A few failed polls in a row (a dropped connection) are retried with a longer wait. */
export async function pollDraft(draftId, onUpdate, { signal, interval = 2000, retries = 3 } = {}) {
  let failures = 0;
  for (;;) {
    await sleep(failures ? interval * 2 ** failures : interval, signal);
    let draft;
    try { draft = await draftApi('/' + encodeURIComponent(draftId), { signal }); }
    catch (err) {
      if (err.name === 'AbortError' || err.status === 404 || ++failures > retries) throw err;
      continue;
    }
    failures = 0;
    onUpdate(draft);
    if (draft.status !== 'importing') return draft;
  }
}

export function createFromFiles(files) {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  return request(apiUrl('/builder/drafts/upload', DEMO_CHURCH), { method: 'POST', body });
}

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
