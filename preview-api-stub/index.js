// Preview API stub: an in-memory stand-in for the Belong FastAPI backends, so a
// static preview of any branch's frontend works without Postgres or an AI key.
// State lives in module scope, so it resets whenever the isolate cold-starts.
// That is fine for previews and keeps the stub free of bindings.

import { SEED } from './seed.js';

// ---------------------------------------------------------------------------
// Seed data (mirrors what each branch's db.initialize() inserts)
// ---------------------------------------------------------------------------

const clone = value => structuredClone(value);
const asList = value => (Array.isArray(value) ? value : []);

// Rows inserted with ON CONFLICT DO NOTHING: the first row for an id wins, and
// every list query orders by id.
function byId(rows) {
  const seen = new Map();
  for (const row of asList(rows)) {
    if (row && typeof row === 'object' && !seen.has(row.id)) seen.set(row.id, clone(row));
  }
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

const EVENT_FIELDS = ['id', 'title', 'category', 'date', 'time', 'location', 'ministry_name', 'description', 'ai_summary'];
const pickEvent = row => Object.fromEntries(EVENT_FIELDS.map(key => [key, row[key] ?? null]));

const church = SEED.church && typeof SEED.church === 'object' ? SEED.church : {};

const state = {
  ministries: byId(SEED.ministries),
  connections: [],
  items: [],
  churchInfo: church.info && typeof church.info === 'object' ? clone(church.info) : null,
  faqs: byId(church.faqs),
  churchEvents: byId(church.events),
  groups: byId(church.groups),
  requests: [],
  chatLog: [],
  visits: [],
  // Calendar events (ben-calandar-update's events.json), not church.json's events.
  events: byId(SEED.events).map(pickEvent),
  aiModel: 'preview-template',
  regions: byId(SEED.regions),
  news: byId(SEED.news),
  angles: [],
};

const ids = { connection: 1, item: 1, request: 1, visit: 1, angle: 1 };
const nextId = kind => ids[kind]++;
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

const fail = (status, detail) => { throw new HttpError(status, detail); };
// FastAPI returns a list of errors for 422s; one readable string is kinder to
// the frontends, which only display body.detail when it is a string.
const invalid = (loc, message) => fail(422, `${loc}: ${message}`);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

// ---------------------------------------------------------------------------
// Validation, loosely matching pydantic v2's lax mode
// ---------------------------------------------------------------------------

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireBody(body) {
  if (body === undefined) invalid('body', 'Field required');
  if (!isObject(body)) invalid('body', 'Input should be a valid dictionary or object');
  return body;
}

function checkLength(loc, value, { min, max }, unit) {
  if (min !== undefined && value.length < min) invalid(loc, `should have at least ${min} ${unit}${min === 1 ? '' : 's'}`);
  if (max !== undefined && value.length > max) invalid(loc, `should have at most ${max} ${unit}${max === 1 ? '' : 's'}`);
}

function str(obj, key, { loc = 'body', required = true, fallback, strip = false, nullable = false, ...limits } = {}) {
  const where = `${loc}.${key}`;
  let value = obj[key];
  if (value === undefined) {
    if (required) invalid(where, 'Field required');
    return fallback;
  }
  if (value === null && nullable) return null;
  if (typeof value !== 'string') invalid(where, 'Input should be a valid string');
  if (strip) value = value.trim();
  checkLength(where, value, limits, 'character');
  return value;
}

function toInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value);
  return null;
}

function int(obj, key, { loc = 'body', required = true, fallback, ge, le } = {}) {
  const where = `${loc}.${key}`;
  if (obj[key] === undefined) {
    if (required) invalid(where, 'Field required');
    return fallback;
  }
  const value = toInt(obj[key]);
  if (value === null) invalid(where, 'Input should be a valid integer');
  if (ge !== undefined && value < ge) invalid(where, `Input should be greater than or equal to ${ge}`);
  if (le !== undefined && value > le) invalid(where, `Input should be less than or equal to ${le}`);
  return value;
}

const TRUE_WORDS = ['true', 't', 'yes', 'y', 'on', '1'];
const FALSE_WORDS = ['false', 'f', 'no', 'n', 'off', '0'];

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.includes(word)) return true;
    if (FALSE_WORDS.includes(word)) return false;
  }
  return null;
}

function bool(obj, key, { loc = 'body', required = true, fallback } = {}) {
  const where = `${loc}.${key}`;
  if (obj[key] === undefined) {
    if (required) invalid(where, 'Field required');
    return fallback;
  }
  const value = toBool(obj[key]);
  if (value === null) invalid(where, 'Input should be a valid boolean');
  return value;
}

function literal(obj, key, choices, { loc = 'body', strip = false } = {}) {
  const where = `${loc}.${key}`;
  let value = obj[key];
  if (value === undefined) invalid(where, 'Field required');
  if (strip && typeof value === 'string') value = value.trim();
  if (!choices.includes(value)) invalid(where, `Input should be ${choices.map(c => `'${c}'`).join(', ')}`);
  return value;
}

function pathInt(params, key) {
  const value = toInt(params[key]);
  if (value === null) invalid(`path.${key}`, 'Input should be a valid integer');
  return value;
}

// ---------------------------------------------------------------------------
// Ministries, matching and connections (every branch)
// ---------------------------------------------------------------------------

const SKILLS = ['Hospitality', 'Teaching', 'Technology', 'Creativity', 'Music', 'Organization', 'Listening', 'Encouragement'];
const STYLES = ['Working with people', 'Behind the scenes', 'Hands-on service'];
const DAYS = ['Sunday mornings', 'Saturday mornings', 'Weekday evenings'];

const getMinistry = id => state.ministries.find(m => m.id === id) ?? null;

// Port of matching.rank: skill overlap, serving style, availability, then need.
function rank(ministries, skills, style = null, day = null, limit = 3) {
  const ranked = [];
  for (const ministry of ministries) {
    if (ministry.filled >= ministry.total) continue;
    const overlap = [...new Set(skills)].filter(s => asList(ministry.skills).includes(s)).sort();
    let score = overlap.length * 3 + (ministry.style === style ? 3 : 0) + (ministry.day === day ? 4 : 0);
    score += (ministry.total - ministry.filled) / ministry.total;
    ranked.push({ ...clone(ministry), overlap, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.id - b.id);
  return ranked.slice(0, limit);
}

function rulesMatch(body) {
  const name = str(body, 'name', { required: false, fallback: '', strip: true, max: 100 });
  const skills = body.skills === undefined ? [] : body.skills;
  if (!Array.isArray(skills)) invalid('body.skills', 'Input should be a valid list');
  if (skills.length > 8) invalid('body.skills', 'List should have at most 8 items after validation');
  skills.forEach((skill, i) => {
    if (!SKILLS.includes(typeof skill === 'string' ? skill.trim() : skill)) {
      invalid(`body.skills.${i}`, `Input should be ${SKILLS.map(s => `'${s}'`).join(', ')}`);
    }
  });
  const style = literal(body, 'style', STYLES, { strip: true });
  const day = literal(body, 'day', DAYS, { strip: true });
  const matches = rank(state.ministries, skills.map(s => s.trim()), style, day);
  return { name: name || 'this member', style, day, engine: 'rules', matches };
}

// will-scheduling-feature sends a free-text description and expects AI output
// ({summary, matches[{reason, considerations}]}). With no model available the
// real backend answers 503, so the preview uses keyword matching instead.
const DESCRIPTION_SKILLS = {
  Music: ['music', 'sing', 'guitar', 'band', 'piano', 'worship', 'drum', 'vocal'],
  Teaching: ['teach', 'kids', 'youth', 'children', 'mentor', 'lead a class'],
  Technology: ['tech', 'sound', 'video', 'camera', 'computer', 'lighting', 'stream'],
  Hospitality: ['greet', 'welcom', 'hospitality', 'coffee', 'host', 'new people'],
  Creativity: ['art', 'design', 'creative', 'photo', 'writ'],
  Organization: ['organiz', 'admin', 'plan', 'logistic', 'event'],
  Listening: ['listen', 'care', 'pray', 'support'],
  Encouragement: ['encourag', 'uplift', 'cheer'],
};
const DESCRIPTION_STYLES = {
  'Working with people': ['people', 'welcom', 'greet', 'families', 'talk', 'conversation', 'alongside a team'],
  'Behind the scenes': ['behind the scenes', 'quiet', 'background', 'tech', 'sound', 'video'],
  'Hands-on service': ['hands-on', 'hands on', 'build', 'cook', 'pack', 'outreach', 'practical', 'food'],
};
const DESCRIPTION_DAYS = {
  'Sunday mornings': ['sunday'],
  'Saturday mornings': ['saturday'],
  'Weekday evenings': ['weekday', 'evening', 'weeknight', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
};

// Day names stay capitalized ("Sunday mornings"); only "Weekday evenings" reads better lowercased mid-sentence.
const dayPhrase = day => (day.startsWith('Weekday') ? day.toLowerCase() : day);
const STYLE_PHRASES = {
  'Working with people': 'It is a people-facing team',
  'Behind the scenes': 'It is behind-the-scenes work',
  'Hands-on service': 'It is hands-on service',
};

function describedMatch(body) {
  const description = str(body, 'description', { strip: true, min: 1, max: 4000 });
  const available = state.ministries.filter(m => m.filled < m.total);
  if (!available.length) {
    return { engine: 'ai', summary: 'There are no open ministry opportunities right now. Please check back soon.', matches: [] };
  }
  const text = description.toLowerCase();
  const found = table => Object.keys(table).filter(key => table[key].some(word => text.includes(word)));
  const skills = found(DESCRIPTION_SKILLS);
  const style = found(DESCRIPTION_STYLES)[0] ?? null;
  const day = found(DESCRIPTION_DAYS)[0] ?? null;
  if (!skills.length && !style && !day) {
    return {
      engine: 'demo',
      summary: 'Preview mode uses simple keyword matching instead of AI. Tell us a little more: what you enjoy or are good at, '
        + 'whether you like working with people, behind the scenes, or hands-on, and when you are usually free.',
      matches: [],
    };
  }
  const matches = rank(available, skills, style, day).map(({ overlap, score, ...ministry }) => {
    const reason = [];
    if (overlap.length) reason.push(`You mentioned ${overlap.join(', ').toLowerCase()}, and this team relies on those gifts.`);
    if (style && ministry.style === style) reason.push(`${STYLE_PHRASES[style]}, which fits how you like to serve.`);
    if (!reason.length) reason.push(`${ministry.name} could be a good way to explore a new area of service.`);
    const schedule = !day
      ? `Confirm the schedule with the team: it usually serves on ${dayPhrase(ministry.day)}.`
      : ministry.day === day
        ? `It serves on ${dayPhrase(ministry.day)}, which you said works for you.`
        : `It serves on ${dayPhrase(ministry.day)}, so confirm that fits your availability.`;
    const considerations = [schedule, ministry.note].filter(Boolean).join(' ');
    return { ...ministry, reason: reason.join(' '), considerations };
  });
  const heard = [...skills.map(s => s.toLowerCase()), style && style.toLowerCase(), day && dayPhrase(day)].filter(Boolean);
  return {
    engine: 'demo',
    summary: `Preview mode uses simple keyword matching instead of AI. Based on what you shared (${heard.join(', ')}), `
      + `here ${matches.length === 1 ? 'is a place' : `are ${matches.length} places`} you could start.`,
    matches,
  };
}

function matches({ body }) {
  requireBody(body);
  // main, erik, ben and prayer-map send {skills, style, day}; will sends {description}.
  return json('description' in body && !('style' in body) ? describedMatch(body) : rulesMatch(body));
}

function listConnections() {
  return state.connections
    .filter(c => getMinistry(c.ministry_id))
    .map(c => ({ ...clone(getMinistry(c.ministry_id)), connection_id: c.connection_id, member: c.member }));
}

// ON CONFLICT (ministry_id, member): an existing pair keeps its connection_id.
function upsertConnection(ministryId, member) {
  let row = state.connections.find(c => c.ministry_id === ministryId && c.member === member);
  if (!row) {
    row = { connection_id: nextId('connection'), ministry_id: ministryId, member };
    state.connections.push(row);
  }
  return row;
}

function saveConnection({ body }) {
  requireBody(body);
  const ministryId = int(body, 'ministry_id', { ge: 0 });
  const member = str(body, 'member', { strip: true, min: 1, max: 100 });
  const ministry = getMinistry(ministryId);
  if (!ministry) fail(404, 'Ministry not found');
  const row = upsertConnection(ministryId, member);
  return json({ ...clone(ministry), connection_id: row.connection_id, member: row.member }, 201);
}

function removeConnection({ params }) {
  const id = pathInt(params, 'connection_id');
  const index = state.connections.findIndex(c => c.connection_id === id);
  if (index < 0) fail(404, 'Connection not found');
  state.connections.splice(index, 1);
  return noContent();
}

// ---------------------------------------------------------------------------
// Items (the template CRUD every branch still carries)
// ---------------------------------------------------------------------------

function addItem({ body }) {
  requireBody(body);
  const title = str(body, 'title').trim();
  if (!title) fail(400, 'title is required');
  const item = { id: nextId('item'), title, done: false };
  state.items.push(item);
  return json(item, 201);
}

function patchItem({ params, body }) {
  const id = pathInt(params, 'item_id');
  requireBody(body);
  const done = bool(body, 'done');
  const item = state.items.find(i => i.id === id);
  if (!item) fail(404, 'no such item');
  item.done = done;
  return json(item);
}

function deleteItem({ params }) {
  const id = pathInt(params, 'item_id');
  const index = state.items.findIndex(i => i.id === id);
  if (index < 0) fail(404, 'no such item');
  state.items.splice(index, 1);
  return noContent();
}

// ---------------------------------------------------------------------------
// Church info and first-time guest visits (erik-guests-maps)
// ---------------------------------------------------------------------------

const churchInfo = () => state.churchInfo ?? { services: [] };

function churchPayload() {
  return json({ info: clone(churchInfo()), faqs: clone(state.faqs), events: clone(state.churchEvents) });
}

const STAFF_VISIT_FIELDS = ['visit_id', 'name', 'contact', 'service', 'party_size', 'kids', 'wants_host', 'status', 'host', 'created_at', 'arrived_at'];
const staffVisit = visit => Object.fromEntries(STAFF_VISIT_FIELDS.map(key => [key, visit[key]]));

// Same shape as secrets.token_urlsafe(16): 16 random bytes, base64url, no padding.
function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createVisit({ body }) {
  requireBody(body);
  const name = str(body, 'name', { strip: true, min: 1, max: 100 });
  const contact = str(body, 'contact', { required: false, fallback: '', strip: true, max: 200 });
  const service = str(body, 'service', { strip: true });
  const partySize = int(body, 'party_size', { ge: 1, le: 20 });
  const kids = str(body, 'kids', { required: false, fallback: '', strip: true, max: 200 });
  const wantsHost = bool(body, 'wants_host', { required: false, fallback: true });
  const services = new Set(asList(churchInfo().services).map(s => `${s.day} ${s.time}`));
  if (!services.has(service)) fail(400, 'Unknown service time');
  const visit = {
    visit_id: nextId('visit'), token: newToken(), name, contact, service, party_size: partySize, kids,
    wants_host: wantsHost, status: 'planned', host: '', created_at: nowIso(), arrived_at: null,
  };
  state.visits.push(visit);
  return json(clone(visit), 201);
}

const visitByToken = token => state.visits.find(v => v.token === token) ?? null;

function getVisit({ params }) {
  const visit = visitByToken(params.token);
  if (!visit) fail(404, 'Visit not found');
  return json(clone(visit));
}

function arriveVisit({ params }) {
  const visit = visitByToken(params.token);
  if (!visit) fail(404, 'Visit not found');
  if (visit.status !== 'planned') fail(409, 'This visit already checked in');
  visit.status = 'arrived';
  visit.arrived_at = nowIso();
  return json(clone(visit));
}

function visitQueue() {
  // ISO timestamps sort as strings; the id breaks ties within one millisecond.
  const waiting = state.visits
    .filter(v => v.status === 'arrived' || v.status === 'on_the_way')
    .sort((a, b) => (a.arrived_at === null) - (b.arrived_at === null)
      || (a.arrived_at ?? '').localeCompare(b.arrived_at ?? '')
      || a.created_at.localeCompare(b.created_at) || a.visit_id - b.visit_id);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const planned = state.visits
    .filter(v => v.status === 'planned' && v.created_at > weekAgo)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.visit_id - a.visit_id)
    .slice(0, 20);
  return json({ waiting: waiting.map(staffVisit), planned: planned.map(staffVisit) });
}

function claimVisit({ params, body }) {
  const id = pathInt(params, 'visit_id');
  requireBody(body);
  const host = str(body, 'host', { strip: true, min: 1, max: 60 });
  const visit = state.visits.find(v => v.visit_id === id && v.status === 'arrived');
  if (!visit) fail(409, 'This guest is not waiting to be claimed');
  visit.status = 'on_the_way';
  visit.host = host;
  return json(staffVisit(visit));
}

function metVisit({ params }) {
  const id = pathInt(params, 'visit_id');
  const visit = state.visits.find(v => v.visit_id === id && (v.status === 'arrived' || v.status === 'on_the_way'));
  if (!visit) fail(409, 'This guest cannot be marked met right now');
  visit.status = 'met';
  return json(staffVisit(visit));
}

// ---------------------------------------------------------------------------
// Staff requests filed by the chat agent (erik-guests-maps, will-scheduling-feature)
// ---------------------------------------------------------------------------

function createRequest(kind, name, contact = '', details = '', ministryId = null) {
  const row = {
    request_id: nextId('request'), kind, ministry_id: ministryId, name, contact, details,
    status: 'pending', created_at: nowIso(),
  };
  state.requests.push(row);
  return clone(row);
}

function listRequests() {
  const rows = [...state.requests].sort((a, b) => b.request_id - a.request_id);
  return json(rows.map(r => ({ ...clone(r), ministry_name: getMinistry(r.ministry_id)?.name ?? null })));
}

function updateRequest({ params, body }) {
  const id = pathInt(params, 'request_id');
  requireBody(body);
  const status = literal(body, 'status', ['approved', 'declined']);
  const row = state.requests.find(r => r.request_id === id);
  if (!row) fail(404, 'Request not found');
  row.status = status;
  // Approving a connection request also adds it to saved connections.
  if (status === 'approved' && row.kind === 'connection' && getMinistry(row.ministry_id)) {
    upsertConnection(row.ministry_id, row.name);
  }
  return json(clone(row));
}

// ---------------------------------------------------------------------------
// Chat: a port of chat.py's no-key demo mode (will-scheduling-feature's
// version, a superset of erik's). No external model is ever called.
// ---------------------------------------------------------------------------

function logChat(sessionId, kind, data) {
  state.chatLog.push({ session_id: sessionId, kind, data: clone(data), created_at: nowIso() });
}

const looksLikeContact = value => value.includes('@') || value.replace(/\D/g, '').length >= 7;

function summarizeMinistry(m) {
  const keys = ['id', 'name', 'category', 'description', 'skills', 'style', 'day', 'head', 'email', 'note'];
  return { ...Object.fromEntries(keys.map(key => [key, clone(m[key])])), open_spots: m.total - m.filled };
}

function searchMinistries(skills, style, day) {
  skills = asList(skills).filter(s => SKILLS.includes(s));
  if (!skills.length && !style && !day) return { ministries: state.ministries.map(summarizeMinistry) };
  const ranked = rank(state.ministries, skills, STYLES.includes(style) ? style : null, DAYS.includes(day) ? day : null);
  return { matches: ranked.map(m => ({ ...summarizeMinistry(m), matching_skills: m.overlap })) };
}

function requestConnectionTool(ministryId, name, contact, note = '') {
  name = name.trim();
  contact = contact.trim();
  const ministry = getMinistry(ministryId);
  if (!ministry) return { error: `No ministry has id ${ministryId}. Call search_ministries to get valid ids.` };
  if (!name) return { error: "The person's name is missing. Ask them for it." };
  if (!looksLikeContact(contact)) return { error: 'Contact must be an email address or phone number. Ask the person for one.' };
  if (ministry.filled >= ministry.total) return { error: `${ministry.name} has no open spots right now. Suggest another ministry.` };
  const pending = state.requests.some(r => r.kind === 'connection' && r.ministry_id === ministryId
    && r.name.toLowerCase() === name.toLowerCase() && r.status === 'pending');
  if (pending) return { status: 'already_pending', message: `${name} already has a pending request for ${ministry.name}.` };
  const row = createRequest('connection', name, contact, note.trim(), ministryId);
  return {
    request_id: row.request_id, status: 'pending_staff_review', ministry: ministry.name,
    message: 'Saved in the church workspace for staff review. No notification or introduction has been sent.',
  };
}

function handOffTool(reason, summary, name = '', contact = '') {
  if (!['pastoral_care', 'prayer', 'crisis', 'other'].includes(reason)) {
    return { error: 'reason must be one of pastoral_care, prayer, crisis, other.' };
  }
  if (!summary.trim()) return { error: 'Add a short summary of what the person needs.' };
  const row = createRequest(reason, name.trim() || 'Anonymous website visitor', contact.trim(), summary.trim());
  const { phone, email } = churchInfo();
  const office = [phone, email].filter(Boolean).join(', ');
  return {
    request_id: row.request_id, status: 'pending_staff_review',
    message: 'Saved in the church workspace for staff review; no notification has been sent.'
      + (office ? ` To contact the office directly: ${office}.` : ''),
  };
}

function callTool(name, args) {
  switch (name) {
    case 'get_church_info': return { church: clone(state.churchInfo), faqs: clone(state.faqs) };
    case 'list_events': return { events: clone(state.churchEvents) };
    case 'list_small_groups': return { groups: clone(state.groups) };
    case 'search_ministries': return searchMinistries(args.skills, args.style, args.day);
    case 'request_connection': return requestConnectionTool(args.ministry_id, args.name, args.contact, args.note ?? '');
    case 'hand_off_to_staff': return handOffTool(args.reason, args.summary, args.name ?? '', args.contact ?? '');
    default: return { error: `Unknown tool ${name}.` };
  }
}

const DEMO_MENU = 'I can help with upcoming events, small groups, ministries, or connecting you with the church team. What sounds good?';
const DEMO_ERROR = 'Sorry, something went wrong looking that up. Can you rephrase?';
const DEMO_CRISIS = "If you're in danger or thinking about harming yourself, please call or text 988 "
  + '(Suicide & Crisis Lifeline, US) right now, or call 911 in an emergency.';
const CRISIS_WORDS = ['suicid', 'kill myself', 'hurt myself', 'end my life', 'self-harm', 'want to die'];
// Checked in order; the first intent with a matching keyword wins.
const DEMO_INTENTS = [
  ['hand_off_to_staff', ['talk to', 'struggling', 'crisis', 'help me', 'worried', 'sad', 'prayer', 'pastoral care', 'grief']],
  ['list_small_groups', ['small group', 'groups', 'connect with people']],
  ['request_connection', ['connect me', 'sign me up', 'join', 'interested in joining']],
  ['get_church_info', ['service', 'services', 'service times', 'address', 'office hours', 'who are you', 'church info']],
  ['list_events', ['event', 'events', 'upcoming', 'schedule', "what's on"]],
  ['search_ministries', ['ministry', 'ministries', 'volunteer', 'serve', 'music', 'kids', 'youth', 'teach', 'worship', 'get involved', 'community outreach']],
  ['get_church_info', ['info', 'about', 'what is this', 'tell me']],
].map(([intent, words]) => [intent, words.map(word => new RegExp(
  // Word boundaries avoid matches such as 'sad' in a name or 'join' in 'adjoining'.
  `(?<![\\p{L}\\p{N}_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu'))]);
const CONNECTION_PROMPT = "To save a connection request, share the ministry's full name, your name "
  + "(say 'my name is ...'), and an email or phone number.";
const DEMO_SKILLS = {
  Music: ['music', 'sing', 'guitar', 'band', 'piano', 'worship'],
  Teaching: ['teach', 'kids', 'youth', 'children'],
  Technology: ['tech', 'sound', 'video', 'camera', 'computer'],
  Hospitality: ['greet', 'welcome', 'hospitality', 'coffee'],
  Creativity: ['art', 'design', 'creative', 'photo'],
  Organization: ['organiz', 'admin', 'plan'],
  Listening: ['listen'],
  Encouragement: ['encourag'],
};
const DEMO_DAYS = {
  'Sunday mornings': ['sunday'],
  'Saturday mornings': ['saturday'],
  'Weekday evenings': ['weekday', 'evening', 'weeknight', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
};

const demoIntent = text => DEMO_INTENTS.find(([, patterns]) => patterns.some(p => p.test(text)))?.[0] ?? null;

function demoTools(sessionId, actions) {
  const use = (tool, args = {}) => {
    const result = callTool(tool, args);
    logChat(sessionId, 'tool', { name: tool, arguments: args, result, provider: 'demo' });
    if ('request_id' in result) actions.push({ tool, request_id: result.request_id, status: result.status });
    return result;
  };
  return {
    get_church_info: () => use('get_church_info'),
    list_events: () => use('list_events').events,
    list_small_groups: () => use('list_small_groups').groups,
    search_ministries: query => {
      const text = query.toLowerCase();
      const skills = Object.keys(DEMO_SKILLS).filter(skill => DEMO_SKILLS[skill].some(w => text.includes(w)));
      const day = Object.keys(DEMO_DAYS).find(d => DEMO_DAYS[d].some(w => text.includes(w))) ?? null;
      const result = use('search_ministries', { skills, day });
      return result.matches ?? result.ministries ?? [];
    },
    hand_off_to_staff: reason => {
      const lower = reason.toLowerCase();
      const kind = CRISIS_WORDS.some(w => lower.includes(w)) ? 'crisis' : lower.includes('prayer') ? 'prayer' : 'pastoral_care';
      return use('hand_off_to_staff', { reason: kind, summary: reason.slice(0, 500) });
    },
    request_connection: details => {
      const text = details.toLowerCase();
      const ministry = state.ministries.find(m => typeof m.name === 'string' && text.includes(m.name.toLowerCase()));
      const contact = details.match(/[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{6,}\d/);
      const given = details.match(/(?:my name is|i'm|i am)\s+([^\n,.!?;@]+)/i);
      const givenName = given ? given[1].trim().split(/\s+(?:and|email|phone|contact|you can)\b/i)[0].trim() : '';
      if (!ministry || !contact || !givenName) return { message: CONNECTION_PROMPT };
      return use('request_connection', { ministry_id: ministry.id, name: givenName, contact: contact[0], note: details.slice(0, 500) });
    },
  };
}

function describe(item) {
  const detail = 'open_spots' in item
    ? `${item.day}, ${item.open_spots} open spots`
    : ['when', 'where'].map(key => item[key]).filter(Boolean).join(', ');
  return `• ${item.name || item.title}` + (detail ? `: ${detail}` : '');
}

function formatDemoResult(result) {
  if (Array.isArray(result)) {
    if (!result.length) return "I couldn't find anything for that right now.";
    return `Here are ${result.length} results:\n` + result.map(describe).join('\n');
  }
  if ('church' in result) {
    const info = result.church; // Throws (caught as DEMO_ERROR) when church.json was not seeded, like the backend.
    const services = info.services.map(s => `${s.day} ${s.time}`).join(', ');
    return `${info.name} is at ${info.address}. Services are ${services}. `
      + `You can reach the office at ${info.phone} or ${info.email} (${info.office_hours}).`;
  }
  if ('error' in result) return result.error;
  return result.message ?? DEMO_MENU;
}

function demoReply(message, tools, history) {
  try {
    const text = message.toLowerCase();
    // Safety first: crisis language always gets 988/911 and a staff hand-off.
    if (CRISIS_WORDS.some(w => text.includes(w))) {
      let saved = false;
      try { saved = 'request_id' in tools.hand_off_to_staff(message); } catch { saved = false; }
      return DEMO_CRISIS + (saved ? ' Your request was saved for staff review; no notification was sent.'
        : " I couldn't save your request for staff review.");
    }
    if (['cancel', 'never mind', 'nevermind', 'no thanks'].includes(text.replace(/^[ .!]+|[ .!]+$/g, ''))) {
      return 'Okay, I will not save a connection request. ' + DEMO_MENU;
    }
    let intent = demoIntent(text);
    let details = message;
    // Continue only an unfinished connection flow, stopping at a topic change or completed request.
    const last = history[history.length - 1];
    if (last && last.role === 'assistant' && last.content === CONNECTION_PROMPT
      && [null, 'request_connection', 'search_ministries'].includes(intent)) {
      intent = 'request_connection';
      const fragments = [message];
      for (const previous of [...history].reverse()) {
        if (previous.role === 'assistant' && previous.content !== CONNECTION_PROMPT) break;
        if (previous.role === 'user') fragments.push(previous.content);
      }
      details = fragments.reverse().join('\n');
    }
    if (intent === null) return DEMO_MENU;
    const result = intent === 'search_ministries' || intent === 'hand_off_to_staff' ? tools[intent](message)
      : intent === 'request_connection' ? tools[intent](details)
        : tools[intent]();
    let reply = formatDemoResult(result);
    const filed = !Array.isArray(result) && 'request_id' in result;
    if (intent === 'search_ministries' && result.length) {
      reply += "\nTo request a connection, say 'connect me' with the ministry's full name, your name, and an email or phone number.";
    }
    if (intent === 'hand_off_to_staff' && filed) reply = `I'm sorry you're going through that. ${reply}`;
    if (intent === 'request_connection' && filed) {
      reply = `Thanks! Your connection request for ${result.ministry} is saved for staff review. No notification or introduction has been sent.`;
    }
    return reply;
  } catch {
    return DEMO_ERROR;
  }
}

function chatStatus() {
  return json({ configured: false, providers: [] });
}

function chatTurn({ body }) {
  requireBody(body);
  const sessionId = str(body, 'session_id', { min: 1, max: 64 });
  const raw = body.messages;
  if (raw === undefined) invalid('body.messages', 'Field required');
  if (!Array.isArray(raw)) invalid('body.messages', 'Input should be a valid list');
  if (raw.length < 1) invalid('body.messages', 'List should have at least 1 item after validation');
  if (raw.length > 40) invalid('body.messages', 'List should have at most 40 items after validation');
  let messages = raw.map((m, i) => {
    if (!isObject(m)) invalid(`body.messages.${i}`, 'Input should be a valid dictionary or object');
    const loc = `body.messages.${i}`;
    return { role: literal(m, 'role', ['user', 'assistant'], { loc }), content: str(m, 'content', { loc, min: 1, max: 2000 }) };
  });
  if (messages[messages.length - 1].role !== 'user') fail(400, 'The last message must come from the user');
  // Keep recent history, starting on a user turn, exactly as main.py trims it.
  messages = messages.slice(-20);
  while (messages[0].role !== 'user') messages.shift();

  const latest = messages[messages.length - 1];
  logChat(sessionId, 'user', latest);
  const actions = [];
  const reply = demoReply(latest.content, demoTools(sessionId, actions), messages.slice(0, -1));
  logChat(sessionId, 'assistant', { content: reply, provider: 'demo' });
  return json({ reply, configured: false, actions, provider: 'demo' });
}

function chatLog({ params }) {
  return json(state.chatLog
    .filter(row => row.session_id === params.session_id)
    .map(({ kind, data, created_at }) => ({ kind, data: clone(data), created_at })));
}

// ---------------------------------------------------------------------------
// Calendar events and AI summaries (ben-calandar-update)
// ---------------------------------------------------------------------------

const sortedEvents = () => [...state.events]
  .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time)) || a.id - b.id);

const getEvent = id => state.events.find(e => e.id === id) ?? null;

function eventById({ params }) {
  const event = getEvent(pathInt(params, 'event_id'));
  if (!event) fail(404, 'Event not found');
  return json(clone(event));
}

function createEvent({ body }) {
  requireBody(body);
  const title = str(body, 'title', { strip: true, min: 1, max: 200 });
  const category = str(body, 'category', { strip: true, min: 1, max: 100 });
  const date = str(body, 'date', { strip: true, min: 10, max: 10 });
  const time = str(body, 'time', { strip: true, min: 1, max: 100 });
  const location = str(body, 'location', { strip: true, min: 1, max: 200 });
  const description = str(body, 'description', { strip: true, min: 1 });
  const ministryName = str(body, 'ministry_name', { strip: true, required: false, fallback: null, nullable: true });
  // Postgres rejects an impossible DATE; surface that as a validation error instead of a 500.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    invalid('body.date', 'Input should be a valid date in the format YYYY-MM-DD');
  }
  const id = state.events.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  const event = { id, title, category, date, time, location, ministry_name: ministryName, description, ai_summary: null };
  state.events.push(event);
  return json(clone(event), 201);
}

// Deterministic stand-in for the model's "warm, inviting 2-sentence bulletin summary".
function templateSummary(event) {
  const when = /^\d{4}-\d{2}-\d{2}$/.test(event.date)
    ? new Date(`${event.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : event.date;
  const first = String(event.description ?? '').trim().match(/^.*?[.!?](?=\s|$)/)?.[0] ?? String(event.description ?? '').trim();
  const invite = `Join us for ${event.title} on ${when}, ${event.time}, at ${event.location}.`;
  return [invite, first || 'Everyone is welcome, so bring a friend.'].join(' ');
}

function summarizeEvent({ params }) {
  const event = getEvent(pathInt(params, 'event_id'));
  if (!event) fail(404, 'Event not found');
  event.ai_summary = templateSummary(event);
  return json(clone(event));
}

function summarizeAll({ body, query }) {
  let onlyMissing;
  if (body === undefined || body === null) {
    onlyMissing = bool(Object.fromEntries(query), 'only_missing', { loc: 'query', required: false, fallback: false });
  } else {
    if (!isObject(body)) invalid('body', 'Input should be a valid dictionary or object');
    str(body, 'model', { required: false, nullable: true });
    onlyMissing = bool(body, 'only_missing', { required: false, fallback: false });
  }
  let targets = sortedEvents();
  if (onlyMissing) targets = targets.filter(e => !e.ai_summary);
  for (const event of targets) event.ai_summary = templateSummary(event);
  return json({ updated: targets.length, errors: [], events: clone(sortedEvents()), only_missing: onlyMissing });
}

// Reported as connected so the Calendar's summary buttons are enabled; the
// "model" is the local template above, never a network call.
function aiStatus() {
  return json({
    connected: true,
    base_url: 'preview-stub',
    default_model: state.aiModel,
    available_models: ['preview-template'],
  });
}

function setAiModel({ body }) {
  requireBody(body);
  state.aiModel = str(body, 'model', { min: 1, max: 100 }).trim();
  return json({ default_model: state.aiModel });
}

// ---------------------------------------------------------------------------
// Prayer map (feature/prayer-map); a port of ai.py's template synthesizer
// ---------------------------------------------------------------------------

const ANGLES = ['safety', 'provision', 'gospel access', 'endurance', 'local relationships'];
const ANGLE_FRAMES = {
  safety: 'physical safety and the practical hazards of the terrain and season',
  provision: 'provision — the material needs of the team and the people they serve',
  'gospel access': 'open doors for the gospel and the relationships forming around it',
  endurance: 'endurance and the toll steady, unglamorous work takes on the team',
  'local relationships': 'the local partnerships and relationships the work depends on',
};

function nextAngle(seen) {
  const fresh = ANGLES.find(angle => !seen.includes(angle));
  // All angles exhausted: cycle back in rather than dead-ending the button.
  return fresh ?? ANGLES[seen.length % ANGLES.length];
}

// textwrap.shorten: collapse whitespace, then keep whole words that fit with the placeholder.
function shorten(text, width, placeholder = '...') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const joined = words.join(' ');
  if (joined.length <= width) return joined;
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length + placeholder.length > width) break;
    line = candidate;
  }
  return line ? line + placeholder : placeholder.trim();
}

function prayerPoints(angle, region, newsItems) {
  const { country, codename } = region;
  const headlines = newsItems.slice(0, 2).map(n => n.headline);
  const points = {
    safety: [
      `Pray for ${codename}'s physical safety as they travel ${country}'s terrain, especially where recent conditions have made routes harder or slower.`,
      `Pray for wisdom in timing travel and outreach around the season's risks in ${country}.`,
    ],
    provision: [
      `Pray for the material needs ${codename} has named directly: capacity, funding, or supplies stretched thin by current demand.`,
      `Pray for provision for the families and partners ${codename} serves in ${country}, particularly where local conditions have tightened resources.`,
    ],
    'gospel access': [
      `Pray for the specific openness ${codename} has described in their community in ${country} — that curiosity would deepen into lasting faith.`,
      `Pray for courage and clarity as ${codename} responds to invitations to share more.`,
    ],
    endurance: [
      `Pray for the team's endurance — ${codename} has described real fatigue alongside real fruit this season.`,
      `Pray for rest and encouragement for the team members carrying the heaviest load in ${country} right now.`,
    ],
    'local relationships': [
      `Pray for the local partners and leaders ${codename} depends on in ${country}, that trust would keep deepening.`,
      `Pray for the emerging local leaders ${codename} has mentioned, that they would be equipped to carry this work forward.`,
    ],
  }[angle];
  if (headlines.length) points.push("Pray in light of what's happening regionally right now: " + headlines.join('; ') + '.');
  return points;
}

function synthesize(region, newsItems, angle) {
  const parts = [
    `${region.codename} has been serving in ${region.country} since ${region.since}, focused on ${String(region.field_of_ministry).toLowerCase()}.`,
    shorten(region.testimony ?? '', 220),
  ];
  if (newsItems.length) parts.push(`Recent regional news adds context: "${newsItems[0].headline}".`);
  parts.push(`This angle looks specifically at ${ANGLE_FRAMES[angle]}.`);
  return { summary: parts.join(' '), prayer_points: prayerPoints(angle, region, newsItems) };
}

function regionFor(params) {
  const region = state.regions.find(r => r.id === pathInt(params, 'region_id'));
  if (!region) fail(404, 'Region not found');
  return region;
}

function angleHistory({ params }) {
  const region = regionFor(params);
  return json(clone(state.angles.filter(a => a.region_id === region.id)));
}

function generateAngle({ params }) {
  const region = regionFor(params);
  const newsItems = state.news.filter(n => n.country_code === region.country_code);
  const seen = [...new Set(state.angles.filter(a => a.region_id === region.id).map(a => a.angle))];
  const angle = nextAngle(seen);
  const { summary, prayer_points } = synthesize(region, newsItems, angle);
  const row = {
    angle_id: nextId('angle'), region_id: region.id, angle, summary, prayer_points,
    source_news_ids: newsItems.map(n => n.id), created_at: nowIso(),
  };
  state.angles.push(row);
  return json(clone(row), 201);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = [
  ['GET', '/api/health', () => json({ ok: true })],
  ['GET', '/api/ministries', () => json(clone(state.ministries))],
  ['POST', '/api/matches', matches],
  ['GET', '/api/connections', () => json(listConnections())],
  ['POST', '/api/connections', saveConnection],
  ['DELETE', '/api/connections/:connection_id', removeConnection],
  ['GET', '/api/items', () => json(clone(state.items))],
  ['POST', '/api/items', addItem],
  ['PATCH', '/api/items/:item_id', patchItem],
  ['DELETE', '/api/items/:item_id', deleteItem],

  ['GET', '/api/church', churchPayload],
  ['POST', '/api/visits', createVisit],
  ['GET', '/api/visits', visitQueue],
  ['GET', '/api/visits/:token', getVisit],
  ['POST', '/api/visits/:token/arrive', arriveVisit],
  ['POST', '/api/visits/:visit_id/claim', claimVisit],
  ['POST', '/api/visits/:visit_id/met', metVisit],

  ['GET', '/api/chat/status', chatStatus],
  ['POST', '/api/chat', chatTurn],
  ['GET', '/api/chat/log/:session_id', chatLog],
  ['GET', '/api/requests', listRequests],
  ['PATCH', '/api/requests/:request_id', updateRequest],

  ['GET', '/api/events', () => json(clone(sortedEvents()))],
  ['POST', '/api/events', createEvent],
  ['POST', '/api/events/summarize-all', summarizeAll],
  ['GET', '/api/events/:event_id', eventById],
  ['POST', '/api/events/:event_id/summarize', summarizeEvent],
  ['GET', '/api/ai/status', aiStatus],
  ['GET', '/api/ollama/status', aiStatus],
  ['POST', '/api/ai/model', setAiModel],
  ['POST', '/api/ollama/model', setAiModel],

  ['GET', '/api/regions', () => json(clone(state.regions))],
  ['GET', '/api/news', () => json(clone(state.news))],
  ['GET', '/api/regions/:region_id/prayer-angles', angleHistory],
  ['POST', '/api/regions/:region_id/prayer-angles', generateAngle],
].map(([method, path, handler]) => {
  const keys = [];
  const pattern = path.replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; });
  return { method, regex: new RegExp(`^${pattern}$`), keys, handler };
});

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    fail(422, 'body: JSON decode error: the request body is not valid JSON');
  }
}

function safeDecode(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

async function handleApi(request, url) {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  let allowed = false;
  for (const route of ROUTES) {
    const match = route.regex.exec(path);
    if (!match) continue;
    if (route.method !== request.method) { allowed = true; continue; }
    const params = Object.fromEntries(route.keys.map((key, i) => [key, safeDecode(match[i + 1])]));
    const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readJson(request) : undefined;
    return route.handler({ params, body, query: url.searchParams, request });
  }
  return allowed ? json({ detail: 'Method Not Allowed' }, 405) : json({ detail: 'Not Found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, url);
    } catch (error) {
      if (error instanceof HttpError) return json({ detail: error.detail }, error.status);
      console.error('preview api stub error', error);
      return json({ detail: 'Internal Server Error' }, 500);
    }
  },
};
