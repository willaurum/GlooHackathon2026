// What Tekton imported from a church's own website, as the site uses it: links by kind (giving, livestream,
// sign-ups, social, app) and pages by type. Every address is checked again before it is used.
import { safeHref } from './site.js';

/** The church's links of one kind, safe addresses only, calls to action first, each address once. */
export function siteLinks(site, kind) {
  const seen = new Set();
  return (site?.links || [])
    .filter(link => link.kind === kind && safeHref(link.url))
    .sort((a, b) => Number(!!b.cta) - Number(!!a.cta))
    .filter(link => !seen.has(safeHref(link.url)) && seen.add(safeHref(link.url)))
    .map(link => ({ ...link, url: safeHref(link.url), label: link.provider || link.text || 'Open' }));
}

export const givingLink = site => siteLinks(site, 'giving')[0] || null;
export const livestreamLink = site => siteLinks(site, 'livestream')[0] || null;
// Registration and sign-up forms the church already uses (Church Center, Google Forms, SignUpGenius...).
export const signupLinks = site => siteLinks(site, 'form').map(link => ({ ...link, label: link.text || link.provider })).slice(0, 6);

/** Social accounts and apps for the footer, one per provider. */
export function footerLinks(site) {
  const providers = new Set();
  return [...siteLinks(site, 'social'), ...siteLinks(site, 'app')]
    .filter(link => !providers.has(link.label) && providers.add(link.label))
    .slice(0, 8);
}

const BELIEFS = /belie|doctrin|statement-of-faith|what-we-teach|our-faith|creed/i;

/** The imported page that holds the church's story ('about') or its statement of belief ('beliefs'), if any. */
export function pageOfType(pages, type) {
  const beliefs = page => BELIEFS.test(page.slug) || BELIEFS.test(page.title || '');
  return (pages || []).find(page => type === 'beliefs' ? beliefs(page) : page.page_type === type && !beliefs(page)) || null;
}

/** Events for "A good place to start": the demo church tags its own; an imported church's are all open to newcomers. */
export function nextSteps(events, demo) {
  const open = ['Newcomers', 'Everyone', 'Families'];
  return (events || []).filter(ev => !demo || open.includes(ev.audience)).slice(0, 3);
}

/** A page's section keys in the order the church asked Tekton for (site.layout, backend builder_edit.PAGES), then
 *  any the layout does not name in their usual order, without the ones it hides ('page:section'). */
export function orderedSections(layout, page, defaults) {
  const hidden = new Set((layout?.hidden || []).filter(h => h.startsWith(page + ':')).map(h => h.slice(page.length + 1)));
  const stored = (layout?.[page] || []).filter(key => defaults.includes(key));
  return [...new Set([...stored, ...defaults])].filter(key => !hidden.has(key));
}

/** Directions to a campus or address in Google Maps. */
export const directionsHref = place => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`;
