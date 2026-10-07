export const BUILDER_LABELS = {
  name: 'Church name', address: 'Street address', phone: 'Phone number', email: 'Email',
  services: 'Service times', office_hours: 'Office hours', about: 'About the church',
  first_visit: 'What to expect on a first visit',
};

export function builderValue(field, value) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
  if (field === 'phone' && /^\d{10}$/.test(value)) return `(${value.slice(0, 3)}) ${value.slice(3, 6)}-${value.slice(6)}`;
  if (field === 'services' && Array.isArray(value)) return value.map(service => {
    const match = /^(\d{2}):(\d{2})$/.exec(service.time);
    const hour = match ? Number(match[1]) : null;
    const time = match ? `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}` : service.time;
    return `${service.day} ${time}`;
  }).join(', ');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// An empty question list alone must never turn an unresolved conflict into a confirmed value.
export function canReviewBuilder(session) {
  return session?.status === 'review' && !session.questions?.length
    && Object.values(session.fields || {}).every(field => field.status === 'prefilled' || field.status === 'confirmed');
}

export function builderEvidence(session, field) {
  const candidates = session.fields[field]?.candidates || [];
  const claimIds = new Set(candidates.flatMap(candidate => candidate.claim_ids || []));
  const evidence = candidates.flatMap(candidate => candidate.evidence || []);
  for (const claim of session.claims || []) {
    if (claim.field !== field || (claimIds.size && !claimIds.has(claim.id))) continue;
    const source = session.sources?.find(item => item.id === claim.source_id);
    if (source) evidence.push({ ...source, source_id: source.id, quote: claim.quote });
  }
  return evidence.filter((item, i) => evidence.findIndex(other => other.source_id === item.source_id && other.url === item.url && other.quote === item.quote) === i);
}

export function builderPage(evidence) {
  if (evidence.title) return evidence.title;
  try { const url = new URL(evidence.url); return url.pathname === '/' ? url.hostname : url.pathname; }
  catch { return evidence.url || 'Website page'; }
}

// Lists the builder imports from a website, in review order. Fields match ITEM_FIELDS in backend/app/builder.py.
export const BUILDER_LISTS = [
  { key: 'events', label: 'Events', fields: [['name', 'Name'], ['date', 'Date (YYYY-MM-DD)'], ['time', 'Time'], ['when', 'When it repeats'], ['location', 'Where'], ['description', 'Description', true]] },
  { key: 'ministries', label: 'Ministries', fields: [['name', 'Name'], ['description', 'Description', true], ['when', 'When'], ['leader', 'Leader'], ['email', 'Email']] },
  { key: 'groups', label: 'Small groups', fields: [['name', 'Name'], ['description', 'Description', true], ['when', 'When'], ['where', 'Where'], ['audience', 'Who it is for']] },
  { key: 'staff', label: 'Staff and leaders', fields: [['name', 'Name'], ['role', 'Role'], ['email', 'Email'], ['phone', 'Phone'], ['bio', 'Bio', true]],
    note: 'These names and emails will be public on your site. People named on only one page start unchecked.' },
  { key: 'locations', label: 'Locations', fields: [['name', 'Name'], ['address', 'Address'], ['service_times', 'Service times']] },
  { key: 'sermons', label: 'Sermons', fields: [['title', 'Title'], ['date', 'Date (YYYY-MM-DD)'], ['speaker', 'Speaker'], ['series', 'Series'], ['scripture', 'Scripture'], ['url', 'Link']] },
];

function shortDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!match) return iso || '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

/** The title and one-line detail shown for an imported list entry. */
export function builderItem(list, value = {}) {
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  const title = value.name || value.title || 'Untitled';
  if (list === 'events') return { title, detail: join(value.date ? shortDate(value.date) : value.when, value.date && value.time, value.location) };
  if (list === 'staff') return { title, detail: join(value.role, value.email, value.phone) };
  if (list === 'sermons') return { title, detail: join(shortDate(value.date), value.speaker, value.series, value.scripture) };
  if (list === 'locations') return { title, detail: join(value.address, value.service_times) };
  return { title, detail: join(value.when, value.where, value.leader, value.audience) };
}

/** How many entries of each list will be created, for the review summary. */
export function builderListCounts(session) {
  return BUILDER_LISTS.map(list => {
    const entries = session?.collections?.[list.key] || [];
    return { ...list, total: entries.length, included: entries.filter(entry => entry.include).length };
  }).filter(list => list.total);
}

/** The status line while a website import runs in the background. */
export function builderImportProgress(session) {
  const progress = session?.progress || {};
  if (progress.stage === 'extracting') return `Read ${progress.pages_read} pages. Now finding your details, events, staff and more…`;
  if (progress.pages_read) return `Reading your website… ${progress.pages_read} of ${progress.pages_found} pages read so far.`;
  return 'Reading your website…';
}
