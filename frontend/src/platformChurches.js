// The platform team's list of every church (#/platform). Churches never see this list:
// it needs the PLATFORM_ADMIN_KEY secret of the giving Worker, typed in once per browser tab.

const KEY = 'belong-platform-key';

export function getPlatformKey() {
  try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; }
}
export function setPlatformKey(key) {
  try { key ? sessionStorage.setItem(KEY, key) : sessionStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** Churches whose name, city or slug contain every word of the query. */
export function filterChurches(churches, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return churches;
  return churches.filter(c => {
    const text = [c.name, c.city, c.slug].join(' ').toLowerCase();
    return words.every(w => text.includes(w));
  });
}

/** A link to a page of any church, which also makes it this browser's church. */
export function churchLink(slug, route = '', { base = '' } = {}) {
  if (base) return 'https://' + slug + '.' + base + '/#/' + route;
  // Always name the church, even the demo one, so the saved church does not win.
  return '#/c/' + slug + '/' + route;
}

export const MODE_LABELS = { demo: 'Demo giving', test: 'Stripe test', live: 'Stripe live' };
