// End-to-end checks of churches across both APIs, against a running local stack:
//   api-giving: npx wrangler dev --port 8799   (see api-giving/test/api.test.mjs)
//   api:        a church API on API (default http://localhost:8789) that can reach the giving Worker
//   node api/test/sitewide.e2e.mjs
// Uses made-up churches only. Sign-ups are rate limited per IP, so give it a few minutes between runs.
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
async function signUp(name) {
  const r = await call(GIVING, 'POST', '/api/churches', { name, city: 'Testville', password: 'a long staff password' });
  if (r.status !== 201) throw new Error('sign-up failed: ' + JSON.stringify(r.data));
  return r.data;
}

console.log('sign up two churches');
const a = await signUp('Hope Chapel ' + suffix);
const b = await signUp('River Church ' + suffix);
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
r = await call(API, 'POST', A + '/visits', { name: 'Sam Example', contact: 'sam@example.com', service: 'Sunday 10:00am', party_size: 2 });
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

console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
process.exit(failures ? 1 : 0);
