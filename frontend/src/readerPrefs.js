// Sermon Notes reading preferences (text size and timestamps), kept in localStorage,
// plus small formatting helpers for the sermon picker.

/** Transcript text sizes in px, smallest to largest. The default is a step up from body text. */
export const TEXT_SIZES = [17, 19, 21, 24, 27];
export const DEFAULT_PREFS = Object.freeze({ size: 1, timestamps: true });
export const PREFS_KEY = 'sermon-reader-prefs';

/** A valid index into TEXT_SIZES; anything that isn't an integer falls back to the default. */
export function clampSize(index) {
  const n = Number.isInteger(index) ? index : DEFAULT_PREFS.size;
  return Math.min(TEXT_SIZES.length - 1, Math.max(0, n));
}

/** The size index after pressing A+ (delta 1) or A- (delta -1), stopping at either end. */
export const stepSize = (index, delta) => clampSize(clampSize(index) + delta);
export const textSizePx = index => TEXT_SIZES[clampSize(index)];
export const canStep = (index, delta) => stepSize(index, delta) !== clampSize(index);

/** Saved prefs, or the defaults when storage is empty, unreadable or holds junk. */
export function readPrefs(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(PREFS_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_PREFS };
    return {
      size: clampSize(saved.size),
      timestamps: typeof saved.timestamps === 'boolean' ? saved.timestamps : DEFAULT_PREFS.timestamps,
    };
  } catch { return { ...DEFAULT_PREFS }; }
}

/** Saves prefs; false when storage refuses (private mode, quota). */
export function writePrefs(storage, prefs) {
  try {
    storage.setItem(PREFS_KEY, JSON.stringify({ size: clampSize(prefs.size), timestamps: prefs.timestamps !== false }));
    return true;
  } catch { return false; }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "Oct 5, 2026" from an ISO date, a "YYYY-MM-DD HH:MM:SS" timestamp or epoch ms; '' when unknown. */
export function formatNoteDate(value, timeZone) {
  if (value === null || value === undefined || value === '') return '';
  let date;
  const day = typeof value === 'string' && DATE_ONLY.exec(value.trim());
  if (day) {
    // A bare date is a calendar day, not midnight UTC, so it never shifts a day.
    date = new Date(Date.UTC(+day[1], day[2] - 1, +day[3]));
    timeZone = 'UTC';
  } else {
    date = new Date(typeof value === 'string' ? value.trim().replace(' ', 'T') : value);
  }
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

const STATUS = { queued: 'Queued', processing: 'Transcribing', failed: 'Failed', ready: 'Ready' };
export const statusLabel = status => STATUS[status] || String(status || '');

/** The sermon to show: the one in the route, else the newest ready one, else the newest. */
export function pickCurrent(notes, selectedId) {
  if (selectedId) return notes.find(n => n.id === selectedId) || null;
  return notes.find(n => n.status === 'ready') || notes[0] || null;
}

/** The sermons someone may pick: staff see every one with its status (to retry or delete a failed one);
 * everyone else sees only the ones ready to read. */
export const visibleNotes = (notes, staff) => (staff ? notes : notes.filter(n => n.status === 'ready'));

// Words in a sermon title that say nothing about its topic.
const TITLE_FILLER = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|morning|evening|service|sermon|message|test|part|week|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b|\d{4}-\d{2}-\d{2}/gi;

/** The Ask box's example question: about the sermon's own title when it names a topic, else a generic one. */
export function askPlaceholder(title) {
  const topic = String(title || '').replace(TITLE_FILLER, ' ').replace(/^[\s,.:;#\-–]+|[\s,.:;#\-–]+$/g, '').replace(/\s+/g, ' ').trim();
  return /[a-z]{3}/i.test(topic) && topic.length <= 60 ? `What was said about ${topic}?` : 'What was the main point of this sermon?';
}
