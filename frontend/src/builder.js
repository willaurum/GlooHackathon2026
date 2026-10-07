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
