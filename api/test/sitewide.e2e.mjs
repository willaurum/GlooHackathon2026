// End-to-end checks of churches across both APIs, against a running local stack:
//   api-giving: node test/local-worker.mjs (port 8803; internal fixtures only)
//   api:        a church API on API (default http://localhost:8789) that can reach the giving Worker
//   Set GIVING=http://127.0.0.1:8803 and FIXTURE_API=http://127.0.0.1:8803/__fixtures/churches.
//   node api/test/sitewide.e2e.mjs
// Uses made-up churches only. Public church signup is disabled.
const API = process.env.API || 'http://localhost:8789';
const GIVING = process.env.GIVING || 'http://localhost:8799';
let failures = 0;
const check = (cond, label, extra) => {
  if (cond) console.log('  ok  ', label);
  else { failures++; console.log('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
};
const ip = () => '10.1.0.' + Math.floor(Math.random() * 250);
async function call(base, method, path, body, token) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip() };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const suffix = Date.now().toString(36).slice(-4);
async function fixtureChurch(name) {
  const url = process.env.FIXTURE_API;
  if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Set FIXTURE_API to the localhost-only internal church fixture endpoint.');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, city: 'Testville', password: 'a long staff password' }) });
  const data = await response.json();
  if (response.status !== 201) throw new Error('church fixture failed: ' + JSON.stringify(data));
  return data;
}

console.log('public signup disabled; initialize two internal church fixtures');
const registration = await call(GIVING, 'POST', '/api/churches', { name: 'Forbidden signup' });
check(registration.status === 403, 'public church signup stays disabled');
const a = await fixtureChurch('Hope Chapel ' + suffix);
const b = await fixtureChurch('River Church ' + suffix);
const A = '/api/churches/' + a.slug, B = '/api/churches/' + b.slug;

console.log('the demo church and the default');
let r = await call(API, 'GET', '/api/health');
check(r.data.churches === true, 'health says churches', r.data);
r = await call(API, 'GET', '/api/info');
check(r.data.name === 'Grace Community Church', 'no church is Grace Community', r.data.name);
r = await call(API, 'GET', '/api/churches/grace-community/info');
check(r.data.name === 'Grace Community Church', 'prefix works for the demo church too');
r = await call(API, 'GET', '/api/churches/no-such-church-' + suffix + '/info');
check(r.status === 404, 'unknown church 404');

console.log('a new church starts empty');
r = await call(API, 'GET', A + '/info');
check(r.status === 200 && r.data.name === a.name && r.data.services.length === 0, 'new church info has its name', r.data);
r = await call(API, 'GET', A + '/ministries');
check(Array.isArray(r.data) && r.data.length === 0, 'no ministries yet');

console.log('staff-only writes');
const content = { info: { name: a.name, city: 'Testville', address: '1 Example Street', services: [{ day: 'Sunday', time: '10:00am', note: 'Main service' }] },
  faqs: [{ question: 'Where do I park?', answer: 'Behind the building.' }], ministries: [{ name: 'Greeters', description: 'Say hello at the door.' }] };
r = await call(API, 'PUT', A + '/church/content', content);
check(r.status === 401, 'content import needs staff');
r = await call(API, 'PUT', A + '/church/content', content, b.token);
check(r.status === 401, 'another church staff cannot import');
r = await call(API, 'PUT', A + '/church/content', content, a.token);
check(r.status === 200 && r.data.info.address === '1 Example Street' && r.data.ministries.length === 1, 'own staff can import', r.data);
r = await call(API, 'GET', A + '/church/content');
check(r.status === 401, 'content export needs staff');
r = await call(API, 'PUT', '/api/church/content', content, a.token);
check(r.status === 401, 'a new church session cannot change the demo church');
r = await call(API, 'GET', '/api/info');
check(r.data.name === 'Grace Community Church', 'demo church unchanged');

console.log('guests and the welcome team');
r = await call(API, 'POST', A + '/visits', { name: 'Sam Example', contact: 'sam@example.org', service: 'Sunday 10:00am', party_size: 2 });
check(r.status === 201 && r.data.token, 'a guest signs up (public)', r.data);
const visit = r.data;
r = await call(API, 'POST', A + '/visits/' + visit.token + '/arrive');
check(r.status === 200 && r.data.status === 'arrived', 'guest taps I am here');
r = await call(API, 'GET', A + '/visits');
check(r.status === 401, 'welcome team queue needs staff on a real church');
r = await call(API, 'GET', A + '/visits', undefined, b.token);
check(r.status === 401, 'another church staff cannot see the queue');
r = await call(API, 'GET', A + '/visits', undefined, a.token);
check(r.status === 200 && r.data.waiting.length === 1 && !JSON.stringify(r.data).includes(visit.token), 'own staff see the queue, no tokens');
r = await call(API, 'POST', A + '/visits/' + visit.visit_id + '/claim', { host: 'Greeter' });
check(r.status === 401, 'claiming needs staff');
r = await call(API, 'GET', B + '/visits/' + visit.token);
check(r.status === 404, 'a guest token does not work on another church');
r = await call(API, 'GET', '/api/visits/' + visit.token);
check(r.status === 404, 'nor on the demo church');
r = await call(API, 'GET', B + '/visits', undefined, b.token);
check(r.status === 200 && r.data.waiting.length === 0, 'church B queue is empty');
r = await call(API, 'GET', '/api/visits');
check(r.status === 401, 'the demo church queue also requires staff');

console.log('requests, connections, notes');
r = await call(API, 'GET', A + '/requests');
check(r.status === 401, 'requests need staff');
r = await call(API, 'GET', A + '/requests', undefined, a.token);
check(r.status === 200 && Array.isArray(r.data), 'own staff read requests');
r = await call(API, 'GET', A + '/notes');
check(r.status === 401, 'sermon notes need staff or the API key');
r = await call(API, 'GET', A + '/notes', undefined, a.token);
check(r.status === 200 && r.data.length === 0, 'own staff read sermon notes');
r = await call(API, 'GET', B + '/notes', undefined, a.token);
check(r.status === 401, 'not another church notes');
r = await call(API, 'POST', A + '/chat', { session_id: 'e2e-' + suffix, messages: [{ role: 'user', content: 'When are services?' }] });
check(r.status === 200 && r.data.reply.includes('10:00am'), 'the chat answers from this church', r.data.reply);

console.log('named staff accounts across both APIs');
const adminA = '/api/churches/' + a.slug + '/admin';
r = await call(GIVING, 'POST', adminA + '/users', { name: 'Example Owner', email: 'owner@example.org', role: 'owner', password: 'fixture owner password' }, a.token);
check(r.status === 200 && r.data.users?.some(user => user.role === 'owner'), 'shared session creates the first Owner account', r.data);
r = await call(GIVING, 'POST', adminA + '/login', { email: 'owner@example.org', password: 'fixture owner password' });
const ownerToken = r.data.token;
check(r.status === 200 && ownerToken, 'named Owner signs in');
r = await call(GIVING, 'POST', adminA + '/users', { name: 'Example Site Admin', email: 'admin@example.org', role: 'site_admin', password: 'fixture admin password' }, ownerToken);
const adminId = r.data.users?.find(user => user.email === 'admin@example.org')?.id;
check(r.status === 200 && adminId, 'Owner adds a Site admin', r.data);
r = await call(GIVING, 'POST', adminA + '/login', { email: 'admin@example.org', password: 'fixture admin password' });
const siteToken = r.data.token;
check(r.status === 200 && siteToken, 'Site admin signs in');
r = await call(API, 'PUT', A + '/church/content', content, siteToken);
check(r.status === 200, 'Site admin edits church content through the church Worker', r.data);
r = await call(API, 'GET', A + '/visits', undefined, siteToken);
check(r.status === 200 && r.data.waiting.length === 1, 'Site admin reads the welcome queue');
r = await call(API, 'POST', A + '/visits/' + visit.visit_id + '/claim', { host: 'Example Greeter' }, siteToken);
check(r.status === 200 && r.data.status === 'on_the_way', 'Site admin claims an arrival', r.data);
r = await call(API, 'POST', A + '/visits/' + visit.visit_id + '/met', undefined, siteToken);
check(r.status === 200 && r.data.status === 'met', 'Site admin completes the guest handoff', r.data);
r = await call(GIVING, 'POST', adminA + '/users', { name: 'Forbidden Staff', email: 'forbidden@example.org', role: 'owner', password: 'fixture forbidden password' }, siteToken);
check(r.status === 403, 'Site admin cannot add users');
r = await call(GIVING, 'DELETE', adminA + '/users/' + adminId, undefined, ownerToken);
check(r.status === 200, 'Owner removes the Site admin', r.data);
r = await call(API, 'GET', A + '/visits', undefined, siteToken);
check(r.status === 401 && r.data.code === 'staff_session_invalid', 'removed Site admin loses church Worker access immediately');

console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
process.exit(failures ? 1 : 0);
