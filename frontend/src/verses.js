import { api } from './api.js';

// USFM code, display name, then other ways a sermon label might name the book.
const BOOKS = [
  ['GEN', 'Genesis', 'gen', 'gn'], ['EXO', 'Exodus', 'exod', 'ex'], ['LEV', 'Leviticus', 'lev'], ['NUM', 'Numbers', 'num'],
  ['DEU', 'Deuteronomy', 'deut', 'dt'], ['JOS', 'Joshua', 'josh'], ['JDG', 'Judges', 'judg'], ['RUT', 'Ruth'],
  ['1SA', '1 Samuel', '1 sam'], ['2SA', '2 Samuel', '2 sam'], ['1KI', '1 Kings', '1 kgs'], ['2KI', '2 Kings', '2 kgs'],
  ['1CH', '1 Chronicles', '1 chron', '1 chr'], ['2CH', '2 Chronicles', '2 chron', '2 chr'], ['EZR', 'Ezra'], ['NEH', 'Nehemiah', 'neh'],
  ['EST', 'Esther', 'esth'], ['JOB', 'Job'], ['PSA', 'Psalms', 'psalm', 'ps', 'psa'], ['PRO', 'Proverbs', 'prov', 'prv'],
  ['ECC', 'Ecclesiastes', 'eccl', 'eccles', 'qoh'], ['SNG', 'Song of Songs', 'song of solomon', 'song', 'sos'],
  ['ISA', 'Isaiah', 'isa'], ['JER', 'Jeremiah', 'jer'], ['LAM', 'Lamentations', 'lam'], ['EZK', 'Ezekiel', 'ezek'],
  ['DAN', 'Daniel', 'dan'], ['HOS', 'Hosea', 'hos'], ['JOL', 'Joel'], ['AMO', 'Amos'], ['OBA', 'Obadiah', 'obad'],
  ['JON', 'Jonah'], ['MIC', 'Micah', 'mic'], ['NAM', 'Nahum', 'nah'], ['HAB', 'Habakkuk', 'hab'], ['ZEP', 'Zephaniah', 'zeph'],
  ['HAG', 'Haggai', 'hag'], ['ZEC', 'Zechariah', 'zech'], ['MAL', 'Malachi', 'mal'],
  ['MAT', 'Matthew', 'matt', 'mt'], ['MRK', 'Mark', 'mk', 'mrk'], ['LUK', 'Luke', 'lk'], ['JHN', 'John', 'jn', 'jhn'],
  ['ACT', 'Acts'], ['ROM', 'Romans', 'rom'], ['1CO', '1 Corinthians', '1 cor'], ['2CO', '2 Corinthians', '2 cor'],
  ['GAL', 'Galatians', 'gal'], ['EPH', 'Ephesians', 'eph'], ['PHP', 'Philippians', 'phil'], ['COL', 'Colossians', 'col'],
  ['1TH', '1 Thessalonians', '1 thess', '1 thes'], ['2TH', '2 Thessalonians', '2 thess', '2 thes'],
  ['1TI', '1 Timothy', '1 tim'], ['2TI', '2 Timothy', '2 tim'], ['TIT', 'Titus'], ['PHM', 'Philemon', 'philem', 'phlm'],
  ['HEB', 'Hebrews', 'heb'], ['JAS', 'James', 'jas'], ['1PE', '1 Peter', '1 pet'], ['2PE', '2 Peter', '2 pet'],
  ['1JN', '1 John', '1 jn'], ['2JN', '2 John', '2 jn'], ['3JN', '3 John', '3 jn'], ['JUD', 'Jude'], ['REV', 'Revelation', 'rev', 'revelations'],
];

const norm = s => s.toLowerCase().replace(/^(i{1,3})\s+/, m => ({ i: '1 ', ii: '2 ', iii: '3 ' })[m.trim()]).replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
const BY_NAME = new Map();
for (const [code, name, ...aliases] of BOOKS) for (const n of [name, ...aliases]) BY_NAME.set(norm(n), [code, name]);

// "Luke 10:30-37", "1 Cor. 13:4", "Psalm 23", "Rom 8:28, 31", "John 3:16-4:2".
const REF = /^\s*((?:[1-3]\s*|i{1,3}\s+))?([A-Za-z][A-Za-z. ]*?)\.?\s+(\d{1,3})(?:\s*:\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3})(?!\s*:))?)?/i;

/** Turns an annotation label into { usfm, human }, or null when it doesn't name a passage. */
export function parseReference(label) {
  const m = REF.exec(label || '');
  if (!m) return null;
  const book = BY_NAME.get(norm(`${m[1] ? m[1].trim() + ' ' : ''}${m[2]}`));
  if (!book) return null;
  const [code, name] = book;
  const [chapter, from, to] = [m[3], m[4], m[5]];
  const range = to && Number(to) > Number(from) ? to : null;
  const usfm = `${code}.${chapter}` + (from ? `.${from}` + (range ? `-${range}` : '') : '');
  const human = `${name} ${chapter}` + (from ? `:${from}` + (range ? `-${range}` : '') : '');
  return { usfm, human, code, name, chapter, verse: from || null };
}

// "31", "31-33" or "12:3" after a full reference, reusing its book (and chapter).
const MORE = /^\s*(?:(\d{1,3})\s*:\s*)?(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*$/;

function continuation(prev, text) {
  const m = MORE.exec(text);
  if (!m) return null;
  const { code, name } = prev;
  // "Psalm 23, 24" lists chapters; "Rom 8:28, 31" lists verses in the same chapter.
  const [chapter, from] = m[1] ? [m[1], m[2]] : prev.verse ? [prev.chapter, m[2]] : [m[2], null];
  const to = m[3] && Number(m[3]) > Number(m[2]) ? m[3] : null;
  const usfm = `${code}.${chapter}` + (from ? `.${from}` : '') + (to ? `-${to}` : '');
  const human = `${name} ${chapter}` + (from ? `:${from}` : '') + (to ? `-${to}` : '');
  return { usfm, human, code, name, chapter, verse: from };
}

/** Splits a label like "Psalm 103:8, Matthew 5:45" into text parts, each with its passage or null. */
export function referenceParts(label) {
  let prev = null;
  return String(label || '').split(/(\s*[;,]\s*|\s+and\s+)/i).map((text, i) => {
    if (i % 2 || !text.trim()) return { text, ref: null };
    const ref = parseReference(text) || (prev && continuation(prev, text));
    if (ref) prev = ref;
    return { text, ref: ref || null };
  }).filter(p => p.text);
}

// Public-domain translations bible-api.com serves, used when our API is unreachable. Ids match api/verse.ts.
const PUBLIC_DOMAIN = {
  web: { id: 'web', abbreviation: 'WEB', title: 'World English Bible', copyright: 'Public domain', bibleCom: '206' },
  kjv: { id: 'kjv', abbreviation: 'KJV', title: 'King James Version', copyright: 'Public domain', bibleCom: '1' },
};
export const BUILT_IN_VERSIONS = Object.freeze({
  default: 'web',
  versions: Object.values(PUBLIC_DOMAIN).map(({ bibleCom, ...v }) => ({ ...v, language: 'en', source: 'public-domain' })),
});

/** The select's label for a version. */
export const versionLabel = v => (v.title && v.abbreviation ? `${v.title} (${v.abbreviation})` : v.title || v.abbreviation || v.id);

/** Versions grouped for the select: the key's licensed ones, then public-domain ones (labeled as such). */
export function versionGroups(list) {
  const groups = [['YouVersion', list.versions.filter(v => v.source !== 'public-domain')], ['Public domain', list.versions.filter(v => v.source === 'public-domain')]];
  return groups.filter(([, versions]) => versions.length);
}

/** The id a reader picked if it is still offered, else the default. */
export const pickVersion = (list, saved) => (list.versions.some(v => v.id === saved) ? saved : list.default);

let versions = null;
/** The Bible versions this site can show, from /api/verse/versions, or the public-domain ones when that fails. */
export function fetchVersions() {
  versions ||= api('/verse/versions').then(
    body => (Array.isArray(body?.versions) && body.versions.length ? body : BUILT_IN_VERSIONS),
    () => { versions = null; return BUILT_IN_VERSIONS; },
  );
  return versions;
}

/** One cache entry per version and passage; '' is the API's default version. */
export const verseCacheKey = (usfm, version = '') => `${version || 'default'}|${usfm}`;
const cache = new Map();

/** The passage in `version` through our API (YouVersion), or public-domain text from bible-api.com when the API fails. */
export function fetchVerse(ref, version = '') {
  const key = verseCacheKey(ref.usfm, version);
  if (!cache.has(key)) {
    const query = '/verse?usfm=' + encodeURIComponent(ref.usfm) + (version ? '&version=' + encodeURIComponent(version) : '');
    const lookup = api(query).catch(async () => {
      const { bibleCom, ...shown } = PUBLIC_DOMAIN[version] || PUBLIC_DOMAIN.web;
      const response = await fetch(`https://bible-api.com/${encodeURIComponent(ref.human)}?translation=${shown.id}`);
      if (!response.ok) throw new Error('Could not load this passage.');
      const body = await response.json();
      return {
        reference: body.reference, text: String(body.text || '').replace(/\s+/g, ' ').trim(), version: shown,
        link: `https://www.bible.com/bible/${bibleCom}/${ref.usfm}.${shown.abbreviation}`, source: 'public-domain',
        requested: version, fallback: Boolean(version) && version !== shown.id,
      };
    });
    cache.set(key, lookup);
    lookup.catch(() => cache.delete(key));
  }
  return cache.get(key);
}
