// The template's fixed wording a church may reword in the site editor (site.copy). The same catalog is
// backend/app/site_copy.json; siteCopy.test.js keeps the two identical.
import CATALOG from './data/siteCopy.json' with { type: 'json' };

export { CATALOG };

/** The church's wording for a copy key, or the template default, with {name} as the church name. */
export function copyText(site, key, name = '') {
  const entry = CATALOG[key];
  if (!entry) return '';
  const own = site?.copy?.[key];
  const text = typeof own === 'string' && own ? own : entry.default;
  return text.replaceAll('{name}', name || 'our church');
}
