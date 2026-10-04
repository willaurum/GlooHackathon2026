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
  return { usfm, human };
}

const WEB = { abbreviation: 'WEB', title: 'World English Bible', copyright: 'Public domain' };
const cache = new Map();

/** The passage from YouVersion through our API, or the public-domain World English Bible when YouVersion isn't set up. */
export function fetchVerse(ref) {
  if (!cache.has(ref.usfm)) {
    const lookup = api('/verse?usfm=' + encodeURIComponent(ref.usfm)).catch(async () => {
      const response = await fetch(`https://bible-api.com/${encodeURIComponent(ref.human)}?translation=web`);
      if (!response.ok) throw new Error('Could not load this passage.');
      const body = await response.json();
      return { reference: body.reference, text: String(body.text || '').replace(/\s+/g, ' ').trim(), version: WEB, link: `https://www.bible.com/bible/206/${ref.usfm}.WEB`, source: 'web' };
    });
    cache.set(ref.usfm, lookup);
    lookup.catch(() => cache.delete(ref.usfm));
  }
  return cache.get(ref.usfm);
}
