// A link to the page a fact came from that opens scrolled to the quote and highlights it: a URL text fragment,
// https://example.org/page#:~:text=prefix-,start,end,-suffix (https://wicg.github.io/scroll-to-text-fragment/).
// Chrome, Edge, Safari and Firefox 131+ follow it; older browsers just open the page.
import { safeHref } from './site.js';

const LONG = 80;
const EDGE_WORDS = 5;

/** One part of a text directive: percent-encoded, with the characters the directive itself uses (- , &) too. */
export function fragmentPart(text) {
  return encodeURIComponent(text).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
}

const words = text => String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/** The address of `url` scrolled to `quote`, or the plain address when there is no quote. `prefix` and `suffix`
 *  (a few words just before and after the quote on the page) pick the right place when the same words appear twice.
 *  A long or multi-line quote is matched by its first and last few words, since exact long matches are fragile. */
export function sourceLink(url, quote, { prefix = '', suffix = '' } = {}) {
  const href = safeHref(url);
  if (!href) return '';
  const base = href.split('#')[0];
  const text = words(quote);
  if (!text.length) return base;
  const flat = text.join(' ');
  const long = flat.length > LONG || /\n/.test(String(quote));
  const target = long && text.length > EDGE_WORDS * 2
    ? fragmentPart(text.slice(0, EDGE_WORDS).join(' ')) + ',' + fragmentPart(text.slice(-EDGE_WORDS).join(' '))
    : fragmentPart(flat);
  // Context stays on the line next to the quote: browsers do not always match it across a block boundary, and
  // context that does not match stops the link from scrolling at all.
  const lines = text => String(text || '').split('\n').filter(line => line.trim());
  const before = words(lines(prefix).at(-1)).slice(-3).join(' '), after = words(lines(suffix)[0]).slice(0, 3).join(' ');
  return base + '#:~:text=' + (before ? fragmentPart(before) + '-,' : '') + target + (after ? ',-' + fragmentPart(after) : '');
}

const nameKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Where a fact on a Tekton preview came from (the draft's provenance, backend builder_edit.provenance):
 *  { field } for a detail like 'services', { list, name } for an entry like a ministry. */
export function factSources(provenance, { field, list, name } = {}) {
  if (!provenance) return [];
  if (field) return provenance.info?.[field] || [];
  return provenance.items?.[list]?.[nameKey(name)] || [];
}

/** The link for one piece of evidence ({ url, quote, prefix, suffix }). */
export const evidenceLink = item => sourceLink(item?.url, item?.quote, { prefix: item?.prefix, suffix: item?.suffix });
