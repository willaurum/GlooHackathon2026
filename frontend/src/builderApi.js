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

/** Where a draft's church.json or site.json downloads from (built from the draft as it is now). */
export const draftFileUrl = (draftId, name) => apiUrl('/builder/drafts/' + encodeURIComponent(draftId) + '/' + name + '.json', DEMO_CHURCH);

export const itemApi = (draftId, body) => draftApi('/' + encodeURIComponent(draftId) + '/items', { method: 'POST', body: JSON.stringify(body) });

export const partApi = (draftId, body) => draftApi('/' + encodeURIComponent(draftId) + '/parts', { method: 'POST', body: JSON.stringify(body) });

export const draftPageApi = (draftId, pageId) => draftApi('/' + encodeURIComponent(draftId) + '/pages/' + encodeURIComponent(pageId));

/** A change asked in plain words ("Put service times above ministries"): { draft, reply, changes, method }. */
export const editApi = (draftId, request) => draftApi('/' + encodeURIComponent(draftId) + '/edits', { method: 'POST', body: JSON.stringify({ request }) });

export const undoEditApi = draftId => draftApi('/' + encodeURIComponent(draftId) + '/edits/undo', { method: 'POST' });

/** Import the upcoming events of a calendar Tekton found on the church's site (only after the church says yes),
 * or leave it out. Tekton reads the feed it found itself; the page never sends an address. */
export const calendarApi = (draftId, calendarId, action) => draftApi('/' + encodeURIComponent(draftId) + '/calendars/'
  + encodeURIComponent(calendarId) + '/' + (action === 'import' ? 'import' : 'decline'), { method: 'POST' });

/** "Add it anyway": something the fact check removed, added back by the church (marked as added by the church). */
export const removedApi = (draftId, removedId) => draftApi('/' + encodeURIComponent(draftId) + '/removed/'
  + encodeURIComponent(removedId) + '/add', { method: 'POST' });

/** The pastor confirms (or takes back) the statement of faith Tekton kept word for word. */
export const beliefsApi = (draftId, confirmed) => draftApi('/' + encodeURIComponent(draftId) + '/beliefs', { method: 'POST', body: JSON.stringify({ confirmed }) });

export async function downloadSiteFiles(draftId) {
  const { files } = await draftApi('/' + encodeURIComponent(draftId) + '/files');
  const name = files['church.json']?.info?.name || 'church';
  const url = URL.createObjectURL(new Blob([JSON.stringify(files, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'church') + '-site-files.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
    // Creating a church needs an invite code (TEKTON_INVITE_CODES on the giving API); a wrong one is inviteRequired.
    try { church = await gapi('/api/churches', { method: 'POST', body: JSON.stringify(account) }); }
    catch (err) {
      if (err.status === 403) {
        err.inviteRequired = !!err.body?.inviteRequired;
        err.registrationClosed = !err.inviteRequired;
      }
      throw err;
    }
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

export async function createFromJson(files) {
  if (!files.length || files.length > 5 || files.reduce((n, file) => n + file.size, 0) > 10 * 1024 * 1024) {
    throw new Error('Choose up to five site JSON files, at most 10 MB of uploads.');
  }
  const parsed = [];
  for (const file of files) {
    try { parsed.push(JSON.parse(await file.text())); }
    catch { throw new Error(file.name + ' is not valid JSON.'); }
  }
  let content;
  const names = ['church.json', 'ministries.json', 'events.json', 'builder.json', 'regions.json', 'site.json'];
  if (files.length === 1 && !names.includes(files[0].name)) content = parsed[0];
  else {
    content = {};
    for (const [i, file] of files.entries()) {
      if (!names.includes(file.name) || Object.hasOwn(content, file.name)) {
        throw new Error('Choose unique church.json and site.json files, legacy seed files, or one combined site-files JSON.');
      }
      content[file.name] = parsed[i];
    }
  }
  const body = JSON.stringify(content, (_, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Site files contain a number that is too large.');
    return value;
  });
  if (new Blob([body]).size > 2 * 1024 * 1024) throw new Error('Site files must be 2 MB or smaller in total.');
  return draftApi('/json', { method: 'POST', body });
}
