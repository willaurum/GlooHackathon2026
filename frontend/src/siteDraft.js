// The site editor's draft: a list of checked operations on top of the church's live content. The server
// (backend site editor) validates, stores and publishes them; this file mirrors its rules so the editor can show
// every change at once. The server stays authoritative.
import { CATALOG, copyText } from './siteCopy.js';

export const MAX_OPS = 80;
export const OP_ID = /^[a-z0-9]{1,24}$/;
export const HTML_ERROR = 'Use plain text. HTML tags are not allowed.';
const HTML_TAG = /<\s*\/?\s*[a-z!][^>]*>/i;

// The Home and Plan your visit sections (backend builder_edit.PAGES), in their usual order.
export const SECTIONS = {
  home: { features: 'Serve, Sermon Notes and Give cards', about: 'Get to know us', ministries: 'Ministries',
    sermons: 'Recent sermons', service_times: 'Service times', leaders: 'For church leaders' },
  visit: { service_times: 'Service times', what_to_expect: 'What to expect', map: 'Where we meet',
    locations: 'Campuses', faqs: 'Questions people ask', next_steps: 'A good place to start',
    sign_up: 'Plan your visit form' },
};
export const PAGE_NAMES = { home: 'Home', visit: 'Plan your visit' };
// The parts of the site a church may hide (church_content.HIDEABLE_PAGES), with their names.
export const HIDEABLE_PAGES = { serve: 'Serve', 'serve/find': 'Find a place', notes: 'Sermon Notes', calendar: 'Calendar',
  give: 'Give', 'give/trips': 'Mission trips', prayer: 'Prayer map', 'guests/welcome': 'Welcome team',
  'about/beliefs': 'Beliefs', 'about/news': 'News', 'about/directory': 'Directory', 'about/connect': 'Connect' };

export const FONTS = ['Inter', 'Lato', 'Libre Baskerville', 'Lora', 'Merriweather', 'Montserrat', 'Nunito', 'Open Sans',
  'Playfair Display', 'Poppins', 'Raleway', 'Roboto', 'Source Sans 3', 'Source Serif 4', 'Work Sans', 'EB Garamond',
  'Fraunces', 'DM Serif Display'];
export const COLOR_TOKENS = ['primary', 'accent', 'background', 'text'];
export const FONT_TOKENS = ['heading_font', 'body_font'];
export const SCALES = { heading_scale: [0.8, 1.3], hero_scale: [0.7, 1.3] };
export const STYLE_LABELS = { primary: 'Main color', accent: 'Button color', background: 'Background color',
  text: 'Text color', heading_font: 'Heading font', body_font: 'Body font', heading_scale: 'Heading size',
  hero_scale: 'Headline size' };

// What Home shows while the church has no headline or text of its own (backend site_editor.INFO_DEFAULTS).
export const INFO_DEFAULTS = { tagline: 'A place to belong, grow and give.',
  about: 'Find where your gifts fit, catch up on Sunday’s message, and support the mission. All in one place.' };
const INFO_FIELDS = {
  tagline: { max: 160, label: 'Home: headline' },
  about: { max: 4000, multiline: true, label: 'Home: text under the headline' },
  first_visit: { max: 4000, multiline: true, label: 'Plan your visit: what to expect' },
};
const PAGE_FIELDS = { title: { max: 200, required: true }, heading: { max: 200 }, text: { max: 4000, multiline: true } };
const STAFF_FIELDS = { name: { max: 120, required: true }, role: { max: 120 }, bio: { max: 2000, multiline: true } };
const FAQ_FIELDS = { question: { max: 300, required: true }, answer: { max: 4000, required: true, multiline: true } };

/** Text as the server stores it: plain, one line or tidy paragraphs. Returns { value } or { error }. */
export function cleanText(value, { max = 4000, multiline = false, required = false } = {}) {
  if (typeof value !== 'string') return { error: 'Use plain text.' };
  // Control and format characters go (bidi controls, zero-width spaces and joiners: Unicode Cf), a tab becomes a
  // space, and line and paragraph separators are line breaks, which stay for multiline text.
  let text = value.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, '');
  if (multiline) {
    text = text.split('\n').map(line => line.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    text = text.replace(/\s+/g, ' ').trim();
  }
  if (HTML_TAG.test(text)) return { error: HTML_ERROR };
  if (text.length > max) return { error: `Keep this under ${max} characters.` };
  if (required && !text) return { error: 'This cannot be empty.' };
  return { value: text };
}

const byId = (list, id) => (Array.isArray(list) ? list : []).find(item => String(item?.id) === String(id));

/** What a set_text path names: { kind, ...where, field, max, multiline, required }, or null if no such path. */
export function parsePath(path) {
  if (typeof path !== 'string') return null;
  let m = /^info\.(tagline|about|first_visit)$/.exec(path);
  if (m) return { kind: 'info', field: m[1], ...INFO_FIELDS[m[1]] };
  m = /^copy\.(.+)$/.exec(path);
  if (m) {
    const entry = Object.hasOwn(CATALOG, m[1]) ? CATALOG[m[1]] : null;
    return entry ? { kind: 'copy', key: m[1], field: 'copy', max: entry.max, multiline: !!entry.multiline } : null;
  }
  m = /^pages\.([a-z0-9][a-z0-9-]{0,79})\.title$/.exec(path);
  if (m) return { kind: 'page', slug: m[1], field: 'title', ...PAGE_FIELDS.title };
  // Numbers are written the one way, without leading zeros (backend site_editor.TEXT_PATHS).
  m = /^pages\.([a-z0-9][a-z0-9-]{0,79})\.sections\.(0|[1-9][0-9]{0,2})\.(heading|text)$/.exec(path);
  if (m) return { kind: 'section', slug: m[1], index: Number(m[2]), field: m[3], ...PAGE_FIELDS[m[3]] };
  m = /^staff\.(0|[1-9][0-9]{0,8})\.(name|role|bio)$/.exec(path);
  if (m) return { kind: 'staff', id: m[1], field: m[2], ...STAFF_FIELDS[m[2]] };
  m = /^faqs\.(0|[1-9][0-9]{0,8})\.(question|answer)$/.exec(path);
  if (m) return { kind: 'faq', id: m[1], field: m[2], ...FAQ_FIELDS[m[2]] };
  return null;
}

// The object a path's field lives on, or null when it no longer exists (a page, person or question removed).
function holder(content, where) {
  if (where.kind === 'info') return content?.info || null;
  if (where.kind === 'page') return (content?.pages || []).find(p => p.slug === where.slug) || null;
  if (where.kind === 'section') return (content?.pages || []).find(p => p.slug === where.slug)?.sections?.[where.index] || null;
  if (where.kind === 'staff') return byId(content?.staff, where.id) || null;
  if (where.kind === 'faq') return byId(content?.faqs, where.id) || null;
  return null;
}

/** A path's current text: copy keys give the template default when not reworded. undefined if the target is gone. */
export function readPath(content, path) {
  const where = parsePath(path);
  if (!where) return undefined;
  if (where.kind === 'copy') return copyText(content?.site, where.key, content?.info?.name || '');
  const target = holder(content, where);
  if (!target) return undefined;
  const value = target[where.field];
  return typeof value === 'string' ? value : '';
}

// Colors (church_content.Theme and backend builder_theme): luminance, contrast, darkening.
const HEX = /^#[0-9a-f]{6}$/i;
function luminance(hex) {
  const channel = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const darken = (hex, amount) => '#' + [1, 3, 5].map(i => Math.max(0, Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount))).toString(16).padStart(2, '0')).join('');
/** A button color darkened just enough for white text on it; '' if it never gets there. */
export function readableOnWhite(hex) {
  for (let step = 0; step <= 10; step++) {
    const candidate = darken(hex, step * 0.08);
    if (contrast(candidate, '#ffffff') >= 3) return candidate;
  }
  return '';
}

const roundScale = value => Math.round(value * 20) / 20;
// The template's own text color (styles.css --text), checked against a background when the church has picked none.
const TEMPLATE_TEXT = '#3a4d44';
const mixHex = (hex, target, amount) => '#' + [1, 3, 5].map(i => {
  const a = parseInt(hex.slice(i, i + 2), 16), b = parseInt(target.slice(i, i + 2), 16);
  return Math.round(a + (b - a) * amount).toString(16).padStart(2, '0');
}).join('');

/** The closest color to `value` that keeps the page readable: a background lightened until it is light and the text
 *  reads on it, or a text color darkened (or lightened) until it reads on the background. '' if none. */
export function nearestReadable(token, value, theme = {}) {
  for (let step = 1; step <= 20; step++) {
    if (token === 'background') {
      const candidate = mixHex(value, '#ffffff', step * 0.05);
      if (luminance(candidate) >= 0.6 && contrast(HEX.test(theme.text || '') ? theme.text : TEMPLATE_TEXT, candidate) >= 4.5) return candidate;
    } else {
      const page = HEX.test(theme.background || '') ? theme.background : '#ffffff';
      const candidate = mixHex(value, luminance(page) >= 0.18 ? '#000000' : '#ffffff', step * 0.05);
      if (contrast(candidate, page) >= 4.5) return candidate;
    }
  }
  return '';
}

/** Check an op against the content it applies to. Returns { op } (cleaned, e.g. a darkened button color) or
 *  { error } in plain words, or { stale: true } when its target no longer exists. */
export function checkOp(content, op) {
  if (!op || typeof op !== 'object') return { error: 'That change is not one the editor can make.' };
  const kind = op.op;
  if (kind === 'set_text') {
    const where = parsePath(op.path);
    if (!where) return { error: 'That text cannot be changed here.' };
    if (where.kind !== 'copy' && readPath(content, op.path) === undefined) return { stale: true };
    const cleaned = cleanText(op.value, where);
    return cleaned.error ? cleaned : { op: { ...op, value: cleaned.value } };
  }
  if (kind === 'set_style') {
    const token = op.token;
    if (COLOR_TOKENS.includes(token)) {
      const value = typeof op.value === 'string' ? op.value.toLowerCase() : '';
      if (!value) return { op: { ...op, value: '' } };
      if (!HEX.test(value)) return { error: 'Pick a color.' };
      const theme = content?.site?.theme || {};
      if (token === 'primary' || token === 'accent') {
        const readable = readableOnWhite(value);
        if (!readable) return { error: 'That color is too light for buttons with white text. Try a darker shade.' };
        // Darkened to read: say so, rather than quietly showing another color.
        return { op: { ...op, value: readable }, ...(readable !== value
          ? { note: `That color is too light for buttons with white text, so it was darkened to ${readable}.` } : {}) };
      }
      // A background stays light and keeps the text readable; text reads on the background. A color that does not is
      // refused with the reason and the nearest one that does (backend site_editor._readable_page).
      const text = token === 'text' ? value : HEX.test(theme.text || '') ? theme.text : TEMPLATE_TEXT;
      const background = token === 'background' ? value : HEX.test(theme.background || '') ? theme.background : '#ffffff';
      const light = token !== 'background' || luminance(value) >= 0.6;
      if (!light || contrast(text, background) < 4.5) {
        const why = !light ? 'Your site keeps a light page background so text stays readable.'
          : token === 'text' ? 'That text color would be hard to read on your background.' : 'Your text would be hard to read on that background.';
        const suggest = nearestReadable(token, value, theme);
        return { error: suggest ? `${why} The nearest readable shade is ${suggest}.` : why, ...(suggest ? { suggest } : {}) };
      }
      return { op: { ...op, value } };
    }
    if (FONT_TOKENS.includes(token)) {
      const value = typeof op.value === 'string' ? op.value.trim() : '';
      if (value && !FONTS.includes(value) && value !== content?.site?.theme?.[token]) return { error: 'Pick one of the fonts in the list.' };
      return { op: { ...op, value } };
    }
    if (SCALES[token]) {
      const [low, high] = SCALES[token];
      if (typeof op.value !== 'number' || !Number.isFinite(op.value)) return { error: 'Pick a size.' };
      const value = roundScale(op.value);
      if (value < low - 1e-9 || value > high + 1e-9) return { error: `Pick a size from ${Math.round(low * 100)}% to ${Math.round(high * 100)}%.` };
      return { op: { ...op, value } };
    }
    return { error: 'That style cannot be changed here.' };
  }
  if (kind === 'move_section' || kind === 'hide_section' || kind === 'show_section') {
    const keys = SECTIONS[op.page];
    if (!keys || !Object.hasOwn(keys, op.section)) return { error: 'That section is not on Home or Plan your visit.' };
    if (kind !== 'move_section') return { op };
    const anchors = ['before', 'after', 'to'].filter(k => op[k] !== undefined);
    if (anchors.length !== 1) return { error: 'Say where the section goes.' };
    if (op.to !== undefined ? !['top', 'bottom'].includes(op.to) : !Object.hasOwn(keys, op.before ?? op.after) || (op.before ?? op.after) === op.section) {
      return { error: 'Say where the section goes.' };
    }
    return { op };
  }
  if (kind === 'hide_page' || kind === 'show_page') {
    return Object.hasOwn(HIDEABLE_PAGES, op.page) ? { op } : { error: 'That part of the site cannot be hidden.' };
  }
  return { error: 'That change is not one the editor can make.' };
}

// What two ops change, when a later one replaces an earlier one (the same text or style, or hiding or showing the
// same section or page). Moves add up.
const target = op => op.op === 'set_text' ? 'text:' + op.path : op.op === 'set_style' ? 'style:' + op.token
  : /^(hide|show)_section$/.test(op.op) ? `section:${op.page}:${op.section}` : /^(hide|show)_page$/.test(op.op) ? 'page:' + op.page : '';

/** A new op for a draft: an accepted one replaces an earlier accepted change to the same text, style, section or page
 *  and goes after the other accepted ones; Tekton's suggestions (pending) wait at the end and never replace anything. */
export function addOp(ops, op) {
  const key = target(op);
  if (op.pending) return [...ops, op];
  const kept = ops.filter(o => o.pending || !key || target(o) !== key);
  const accepted = kept.filter(o => !o.pending), pending = kept.filter(o => o.pending);
  return [...accepted, op, ...pending];
}

export const removeOp = (ops, id) => ops.filter(o => o.id !== id);

/** Accept one of Tekton's suggestions: it becomes an accepted change like one staff made. */
export function acceptOp(ops, id) {
  const found = ops.find(o => o.id === id && o.pending);
  if (!found) return ops;
  const { pending, ...accepted } = found;
  return addOp(removeOp(ops, id), { ...accepted, pending: false });
}

const sameText = (content, published, path) => readPath(content, path) === readPath(published, path);
function sameStyle(content, published, token) {
  if (SCALES[token]) return (content?.site?.style?.[token] ?? 1) === (published?.site?.style?.[token] ?? 1);
  return (content?.site?.theme?.[token] || '') === (published?.site?.theme?.[token] || '');
}

/** The draft without accepted ops that change nothing: hiding then showing a section, moving it back, or text and
 *  styles put back to what is live all cancel out (backend site_editor.settle). Suggestions stay until answered. */
export function settle(published, ops) {
  const live = published || {};
  const { content } = applyOps(live, ops, { pending: false });
  const layout = cleanLayout(content.site?.layout), before = cleanLayout(live.site?.layout);
  const unchanged = op => {
    if (op.op === 'set_text') return readPath(content, op.path) !== undefined && sameText(content, live, op.path);
    if (op.op === 'set_style') return sameStyle(content, live, op.token);
    if (op.op === 'hide_section' || op.op === 'show_section') {
      const tag = op.page + ':' + op.section;
      return layout.hidden.includes(tag) === before.hidden.includes(tag);
    }
    if (op.op === 'hide_page' || op.op === 'show_page') return layout.hidden_pages.includes(op.page) === before.hidden_pages.includes(op.page);
    if (op.op === 'move_section') return (layout[op.page] || []).join() === (before[op.page] || []).join();
    return false;
  };
  return (ops || []).filter(op => op.pending || !unchanged(op));
}

/** Every known section once, stored order first; hidden ones as 'page:section' (backend builder_edit.clean_layout),
 *  keeping the hidden site pages. */
export function cleanLayout(layout) {
  layout = layout && typeof layout === 'object' ? layout : {};
  const out = {};
  for (const [page, keys] of Object.entries(SECTIONS)) {
    const order = [...new Set(Array.isArray(layout[page]) ? layout[page] : [])].filter(k => Object.hasOwn(keys, k));
    out[page] = [...order, ...Object.keys(keys).filter(k => !order.includes(k))];
  }
  out.hidden = [...new Set((layout.hidden || []).filter(h => {
    if (typeof h !== 'string') return false;
    const [page, section] = [h.split(':')[0], h.slice(h.indexOf(':') + 1)];
    return SECTIONS[page] && Object.hasOwn(SECTIONS[page], section);
  }))].sort();
  out.hidden_pages = Array.isArray(layout.hidden_pages) ? [...layout.hidden_pages] : [];
  return out;
}

function applyOne(content, op) {
  if (op.op === 'set_text') {
    const where = parsePath(op.path);
    if (where.kind === 'copy') {
      const site = content.site ||= {};
      const copy = { ...(site.copy || {}) };
      if (op.value) copy[where.key] = op.value; else delete copy[where.key];
      site.copy = copy;
      return;
    }
    holder(content, where)[where.field] = op.value;
    return;
  }
  const site = content.site ||= {};
  if (op.op === 'set_style') {
    if (SCALES[op.token]) {
      const style = { ...(site.style || {}) };
      if (op.value === 1) delete style[op.token]; else style[op.token] = op.value;
      site.style = style;
    } else {
      site.theme = { ...(site.theme || {}), [op.token]: op.value };
    }
    return;
  }
  const layout = cleanLayout(site.layout);
  if (op.op === 'hide_page' || op.op === 'show_page') {
    const hidden = layout.hidden_pages.filter(k => k !== op.page);
    layout.hidden_pages = op.op === 'hide_page' ? [...hidden, op.page] : hidden;
  } else {
    const tag = op.page + ':' + op.section;
    if (op.op === 'hide_section') layout.hidden = [...new Set([...layout.hidden, tag])].sort();
    else if (op.op === 'show_section') layout.hidden = layout.hidden.filter(h => h !== tag);
    else {
      const order = layout[op.page].filter(k => k !== op.section);
      if (op.to === 'top') order.unshift(op.section);
      else if (op.to === 'bottom') order.push(op.section);
      else order.splice(order.indexOf(op.before ?? op.after) + (op.after !== undefined ? 1 : 0), 0, op.section);
      layout[op.page] = order;
    }
  }
  site.layout = layout;
}

/** The content with a draft on top: accepted ops in order, then (with pending: true) Tekton's suggestions.
 *  An op whose target is gone, or that no longer checks out, is skipped and listed in `stale`. */
export function applyOps(published, ops, { pending = true } = {}) {
  const content = structuredClone(published || {});
  const stale = [];
  const ordered = [...(ops || []).filter(o => !o.pending), ...(pending ? (ops || []).filter(o => o.pending) : [])];
  for (const op of ordered) {
    const checked = checkOp(content, op);
    if (!checked.op) { stale.push(op.id); continue; }
    applyOne(content, checked.op);
  }
  return { content, stale };
}

const percent = value => Math.round((typeof value === 'number' ? value : 1) * 100) + '%';
const sectionName = (page, section) => `"${SECTIONS[page]?.[section] || section}" on ${PAGE_NAMES[page] || page}`;
function position(content, page, section) {
  const order = cleanLayout(content?.site?.layout)[page] || [];
  return `Position ${order.indexOf(section) + 1} of ${order.length}`;
}
const sectionHidden = (content, page, section) => cleanLayout(content?.site?.layout).hidden.includes(page + ':' + section);

/** Plain words for the part of the site a set_text path changes, e.g. "Home: bottom section heading". */
export function pathLabel(content, path) {
  const where = parsePath(path);
  if (!where) return 'Text';
  if (where.kind === 'info') return where.label;
  if (where.kind === 'copy') return CATALOG[where.key].label;
  if (where.kind === 'page' || where.kind === 'section') {
    const title = (content?.pages || []).find(p => p.slug === where.slug)?.title || where.slug;
    return where.kind === 'page' ? `Page "${title}": title` : `Page "${title}": section ${where.index + 1} ${where.field === 'heading' ? 'heading' : 'text'}`;
  }
  if (where.kind === 'staff') return `Directory: ${byId(content?.staff, where.id)?.name || 'a staff member'}, ${where.field === 'bio' ? 'about' : where.field}`;
  const question = byId(content?.faqs, where.id)?.question;
  return `Questions people ask: ${question ? `"${question}"` : 'a question'}, ${where.field}`;
}

function styleValue(content, token) {
  if (SCALES[token]) return percent(content?.site?.style?.[token]);
  return content?.site?.theme?.[token] || 'Default';
}

/** One line per op for the review list: { id, label, before, after, pending, stale, source, ... }. Text and style
 *  changes compare with the live site; moves and hides compare with the draft just before them. */
export function describeChanges(published, ops) {
  const live = published || {};
  let content = structuredClone(live);
  const ordered = [...(ops || []).filter(o => !o.pending), ...(ops || []).filter(o => o.pending)];
  const byOp = new Map();
  for (const op of ordered) {
    const checked = checkOp(content, op);
    const stale = !checked.op;
    const base = { id: op.id, op: op.op, source: op.source || 'staff', pending: !!op.pending, stale };
    let change;
    if (op.op === 'set_text') {
      // What a visitor sees: a copy key's or Home's default while the field is empty.
      const where = parsePath(op.path);
      const fallback = where?.kind === 'info' ? INFO_DEFAULTS[where.field] || '' : '';
      const before = readPath(live, op.path) || fallback;
      const after = where?.kind === 'copy' && !op.value ? CATALOG[where.key].default.replaceAll('{name}', live.info?.name || 'our church') : op.value || fallback;
      change = { ...base, label: pathLabel(live, op.path), before: before ?? '', after: typeof after === 'string' ? after : '', path: op.path };
    } else if (op.op === 'set_style') {
      const value = checked.op?.value ?? op.value;
      change = { ...base, label: STYLE_LABELS[op.token] || 'Style', token: op.token, before: styleValue(live, op.token),
        after: SCALES[op.token] ? percent(value) : value || 'Default' };
    } else if (op.op === 'move_section') {
      const before = position(content, op.page, op.section);
      const next = structuredClone(content);
      if (!stale) applyOne(next, checked.op);
      change = { ...base, label: 'Moved ' + sectionName(op.page, op.section), page: op.page, section: op.section, before, after: position(next, op.page, op.section) };
    } else if (op.op === 'hide_section' || op.op === 'show_section') {
      change = { ...base, label: sectionName(op.page, op.section), page: op.page, section: op.section,
        before: sectionHidden(content, op.page, op.section) ? 'Hidden' : 'Shown', after: op.op === 'hide_section' ? 'Hidden' : 'Shown' };
    } else if (op.op === 'hide_page' || op.op === 'show_page') {
      const hidden = cleanLayout(content?.site?.layout).hidden_pages.includes(op.page);
      change = { ...base, label: (HIDEABLE_PAGES[op.page] || op.page) + ' page', page: op.page, before: hidden ? 'Hidden' : 'Shown', after: op.op === 'hide_page' ? 'Hidden' : 'Shown' };
    } else {
      change = { ...base, label: 'Change', before: '', after: '' };
    }
    if (!stale) applyOne(content, checked.op);
    byOp.set(op, change);
  }
  return (ops || []).map(op => byOp.get(op));
}

// Fields the public calendar shows (backend db.EVENT_COLUMNS).
const EVENT_COLUMNS = ['title', 'category', 'date', 'time', 'location', 'ministry_name', 'description', 'ai_summary'];

/** The public site responses for content (backend church_content.public_site), for startApiPreview. */
export function publicSite(content) {
  const info = content?.info || {};
  const site = content?.site && Object.keys(content.site).length
    ? { ...content.site, assets: (content.site.assets || []).filter(a => a.rights) } : null;
  const pages = content?.pages || [];
  const coverage = m => !Array.isArray(m.shifts) ? m : { ...m,
    filled: m.shifts.reduce((n, s) => n + (s.filled || 0), 0), total: m.shifts.reduce((n, s) => n + (s.total || 0), 0) };
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return {
    info,
    church: { info, faqs: content?.faqs || [], events: content?.events || [], groups: content?.groups || [],
      staff: content?.staff || [], locations: content?.locations || [], sermons: content?.sermons || [], site,
      pages: pages.map(p => ({ id: p.id, slug: p.slug, title: p.title, page_type: p.page_type || '', source_url: p.source_url || '' })) },
    ministries: [...(content?.ministries || [])].sort((a, b) => compare(a.id, b.id)).map(coverage),
    events: [...(content?.calendar || [])]
      .sort((a, b) => compare(a.date || '', b.date || '') || compare(a.time || '', b.time || ''))
      .map(e => Object.fromEntries(['id', ...EVENT_COLUMNS].map(key => [key, e[key] ?? null]))),
    pages,
  };
}

/** CSS custom properties for site.style; only sizes within bounds. */
export function styleVariables(style) {
  const vars = {};
  for (const [token, name] of [['heading_scale', '--heading-scale'], ['hero_scale', '--hero-scale']]) {
    const value = style?.[token], [low, high] = SCALES[token];
    if (typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high) vars[name] = String(value);
  }
  return vars;
}

/** A new op id (^[a-z0-9]{1,24}$). */
export function newOpId() {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-6);
}
