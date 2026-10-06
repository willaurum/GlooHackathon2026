// Which church the site is showing. Every page and API call uses the church picked here.
//
// In order:
//   1. a church subdomain, <slug>.<VITE_BASE_DOMAIN>, when the build sets VITE_BASE_DOMAIN
//   2. a link that names the church, #/c/<slug>/serve (or the older giving link #/give/c/<slug>)
//   3. the church this browser picked last
//   4. the demo church, Grace Community
// Routes without a church (#/serve) keep working: they use whichever church this picks.

export const DEMO_CHURCH = 'grace-community';
export const DEMO_INFO = { slug: DEMO_CHURCH, name: 'Grace Community', city: 'Springfield' };
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SAVED = 'belong-church';
// The Give page kept its own choice before the whole site did; read it once so nobody loses theirs.
const OLD_SAVED = 'belong-give-church';

export const BASE_DOMAIN = String(import.meta.env?.VITE_BASE_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
export const isSlug = value => typeof value === 'string' && SLUG.test(value);

/** The church a host names, when it is <slug>.<base>. */
export function slugFromHost(host, base = BASE_DOMAIN) {
  const name = String(host || '').toLowerCase().split(':')[0];
  if (!base || !name.endsWith('.' + base)) return null;
  const label = name.slice(0, -base.length - 1);
  return isSlug(label) ? label : null;
}

/** Split a location hash into the church it names (if any) and the page route. */
export function splitHash(hash) {
  const path = String(hash || '').replace(/^#\/?/, '');
  const prefixed = /^c\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (prefixed) return isSlug(prefixed[1]) ? { slug: prefixed[1], route: prefixed[2] || '' } : { slug: null, route: '' };
  const giveLink = /^give\/c\/([^/]+)$/.exec(path);
  if (giveLink && isSlug(giveLink[1])) return { slug: giveLink[1], route: 'give' };
  return { slug: null, route: path };
}

/** { slug, source, route } for a location, the saved church and the base domain. */
export function resolveChurch({ host = '', hash = '', saved = '', base = BASE_DOMAIN } = {}) {
  const fromHash = splitHash(hash);
  const sub = slugFromHost(host, base);
  if (sub) return { slug: sub, source: 'subdomain', route: fromHash.route };
  if (fromHash.slug) return { slug: fromHash.slug, source: 'link', route: fromHash.route };
  if (isSlug(saved)) return { slug: saved, source: 'saved', route: fromHash.route };
  return { slug: DEMO_CHURCH, source: 'demo', route: fromHash.route };
}

/** The hash for a page of a church. On a church subdomain the church is already in the host. */
export function hashFor(slug, route = '', source = '') {
  if (source === 'subdomain' || slug === DEMO_CHURCH) return '#/' + route;
  return '#/c/' + slug + (route ? '/' + route : '/');
}

/** A full link to share, e.g. on a bulletin. */
export function shareLink(slug, route = '', { origin = globalThis.location?.origin || '', base = BASE_DOMAIN } = {}) {
  if (base) return 'https://' + slug + '.' + base + '/#/' + route;
  return origin + '/' + hashFor(slug, route);
}

export function savedChurch() {
  try { return localStorage.getItem(SAVED) || localStorage.getItem(OLD_SAVED) || ''; } catch { return ''; }
}
/** Drop the saved church when it turns out not to exist, so one bad link does not stick. */
export function forgetSavedChurch(slug) {
  try { if (localStorage.getItem(SAVED) === slug) localStorage.removeItem(SAVED); } catch { /* private mode */ }
}
export function saveChurch(slug) {
  try { localStorage.setItem(SAVED, slug); localStorage.removeItem(OLD_SAVED); } catch { /* private mode */ }
}

// Staff sessions (from the giving service sign-in) last for this browser tab only.
const staffKey = slug => 'belong-staff:' + slug;
// Memory only: restored browser tokens must be checked again; fresh server-issued tokens need no second login.
const verifiedTokens = new Map();
export const getVerifiedStaffToken = slug => verifiedTokens.get(slug) || '';
export function getStaffToken(slug) {
  try { return sessionStorage.getItem(staffKey(slug)) ?? ''; } catch { return ''; }
}
export function setStaffToken(slug, token, { verified = false } = {}) {
  verifiedTokens.delete(slug);
  try { token ? sessionStorage.setItem(staffKey(slug), token) : sessionStorage.removeItem(staffKey(slug)); } catch { /* private mode */ }
  if (verified && token && getStaffToken(slug) === token) verifiedTokens.set(slug, token);
  globalThis.dispatchEvent?.(new Event('belong-staff'));
}

// A password change revokes the old token on the server before the new one reaches us. Other requests
// rejected in between must not sign staff out (and remount the page), so rejections wait for it.
const rotations = new Map();
// Per church: sign-outs started, and sign-outs still waiting on the server. A password change must not install
// its replacement if a sign-out started while it ran, or is still in progress when it answers.
const signOuts = new Map(), signingOut = new Map();

/** Call when staff start signing out, before waiting on the server; call the returned function when it settles. */
export function noteStaffSignOut(slug) {
  signOuts.set(slug, (signOuts.get(slug) || 0) + 1);
  signingOut.set(slug, (signingOut.get(slug) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = signingOut.get(slug) - 1;
    left ? signingOut.set(slug, left) : signingOut.delete(slug);
  };
}

/** Forget a token the server rejected, unless it was already replaced or is being replaced right now. */
export function clearRejectedStaffToken(slug, token) {
  if (token && !rotations.get(slug) && getStaffToken(slug) === token) setStaffToken(slug, '');
}

/** Run a request that returns a replacement token ({ token }) and store it. `installed` is false when staff
 *  signed out (or in again) while it ran: the replacement then belongs to nobody and the caller should revoke it. */
export async function rotateStaffToken(slug, request) {
  const old = getStaffToken(slug), signOutsBefore = signOuts.get(slug) || 0;
  let rejected = false;
  rotations.set(slug, (rotations.get(slug) || 0) + 1);
  try {
    const res = await request();
    if (getStaffToken(slug) !== old || (signOuts.get(slug) || 0) !== signOutsBefore || signingOut.get(slug)) return { ...res, installed: false };
    setStaffToken(slug, res.token, { verified: true });
    return { ...res, installed: true };
  } catch (err) {
    rejected = err.status === 401;
    throw err;
  } finally {
    const left = rotations.get(slug) - 1;
    left ? rotations.set(slug, left) : rotations.delete(slug);
    // The change itself was refused because the session is gone: now it really is signed out.
    if (rejected) clearRejectedStaffToken(slug, old);
  }
}
