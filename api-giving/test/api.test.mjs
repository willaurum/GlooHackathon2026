// End-to-end API checks with no real Stripe account:
//   node test/fake-stripe.mjs &
//   cp .dev.vars.example .dev.vars   (fill in STRIPE_KEY_ENCRYPTION_KEY)
//   npx wrangler dev --port 8799 &
//   node test/api.test.mjs
// Rate limits are per IP per window, so give it ten minutes between full runs.
// Other ports: set API, STRIPE and ORIGIN (and PORT for the fake Stripe), matching .dev.vars.
// Platform list: set PLATFORM_KEY to the PLATFORM_ADMIN_KEY in .dev.vars. Without it, the Worker is
// expected to have no PLATFORM_ADMIN_KEY (the route is off). API_NO_PLATFORM can name a second
// `wrangler dev` without the secret, so one run checks both.
import { fileURLToPath } from 'node:url';
const API = process.env.API || 'http://localhost:8799';
const STRIPE = process.env.STRIPE || 'http://localhost:12111';
const ORIGIN = process.env.ORIGIN || 'http://localhost:5199';
// Read the demo credential from configuration; never copy its value into new tests.
const demoPassword = process.env.DEMO_PASSWORD || (await import('wrangler')).unstable_readConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) }).vars.ADMIN_KEY;
const KEY = 'sk_test_GOOD' + 'a'.repeat(24) + 'Z9x1';
let failures = 0;
const publicDumps = [];

function check(cond, label, extra) {
  if (cond) console.log('  ok  ', label);
  else { failures++; console.log('  FAIL', label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
async function call(method, path, body, token, ip = '10.0.0.' + Math.floor(Math.random() * 250)) {
  const headers = { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': ip };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!token && !path.includes('/admin')) publicDumps.push({ path, text });
  return { status: r.status, data, text };
}
const stripeLog = async () => (await fetch(STRIPE + '/__log')).json();

const suffix = Date.now().toString(36).slice(-4);
console.log('signup');
let r = await call('POST', '/api/churches', { name: 'Hope Chapel ' + suffix, city: 'Austin', currency: 'usd', password: 'short' });
check(r.status === 400, 'rejects short password', r.data);
r = await call('POST', '/api/churches', { name: 'Hope Chapel ' + suffix, city: 'Austin', currency: 'usd', password: 'correct horse battery' });
check(r.status === 201 && r.data.token && r.data.slug, 'creates church', r.data);
const slug = r.data.slug; let token = r.data.token;
const C = '/api/churches/' + slug;

r = await call('POST', '/api/churches', { name: 'Hope Chapel ' + suffix, city: 'Dallas', password: 'another password 1' });
check(r.status === 201 && r.data.slug !== slug, 'same name gets a different slug', r.data);
const slugB = r.data.slug; const tokenB = r.data.token;

console.log('churches cannot see each other');
for (const q of ['', '?q=Hope', '?q=' + suffix, '?q=Austin', '?q=a']) {
  r = await call('GET', '/api/churches' + q);
  const slugs = (r.data.churches || []).map(c => c.slug);
  check(r.status === 200 && slugs.length <= 1 && slugs.every(x => x === 'grace-community'), 'list ' + (q || 'with no query') + ' shows only the demo church', r.data);
}
r = await call('GET', '/api/directory/' + slug);
check(r.status === 200 && r.data.slug === slug, 'exact lookup by link still works', r.data);
r = await call('GET', C);
check(r.status === 200 && r.data.slug === slug, 'public church page by link still works');

console.log('auth');
r = await call('GET', C + '/admin');
check(r.status === 401, 'admin needs auth');
r = await call('GET', C + '/admin', undefined, tokenB);
check(r.status === 401, 'other church token rejected');
r = await call('GET', C + '/admin', undefined, 'gloo-donate-demo-not-a-token-xxxxxxxxx');
check(r.status === 401, 'demo ADMIN_KEY is not a session token');
r = await call('POST', C + '/admin/login', { password: 'wrong password!!' });
check(r.status === 401, 'wrong password rejected');
r = await call('POST', C + '/admin/login', { password: 'correct horse battery' });
check(r.status === 200 && r.data.token, 'login works');
token = r.data.token;
r = await call('GET', C + '/admin', undefined, token);
check(r.status === 200 && r.data.funds.length === 3 && r.data.stripe.mode === 'demo', 'admin overview, 3 default funds, demo mode', r.data);
r = await call('POST', '/api/churches/grace-community/admin/login', { password: demoPassword });
check(r.status === 200, 'demo church login with demo key');
const demoToken = r.data.token;
r = await call('POST', '/api/churches/grace-community/admin/stripe', { key: KEY }, demoToken);
check(r.status === 403, 'demo church cannot connect Stripe', r.data);
r = await call('GET', '/api/churches/no-such-church');
check(r.status === 404, 'unknown church 404');
r = await call('GET', '/api/churches/' + encodeURIComponent('../main'));
check(r.status === 404, 'bad slug 404');

console.log('stripe connect');
r = await call('POST', C + '/admin/stripe', { key: 'pk_test_123' }, token);
check(r.status === 400, 'publishable key rejected', r.data);
r = await call('POST', C + '/admin/stripe', { key: 'sk_test_BAD' + 'b'.repeat(24) }, token);
check(r.status === 400 && /did not accept/.test(r.data.error), 'invalid key rejected by Stripe check', r.data);
await fetch(STRIPE + '/__reset');
r = await call('POST', C + '/admin/stripe', { key: KEY }, token);
check(r.status === 200 && r.data.provision.ok, 'connect + provision', r.data.provision);
check(r.data.stripe.mode === 'test' && r.data.stripe.keyHint === 'sk_test_…Z9x1' && r.data.stripe.webhook, 'status: test mode, hint, webhook', r.data.stripe);
check(!r.text.includes(KEY) && !r.text.includes('GOOD'), 'connect response never echoes the key');
check(r.data.funds.every((f) => f.inStripe), 'every fund in Stripe');
let s = (await stripeLog()).accounts;
let acct = Object.values(s)[0];
check(acct.products === 3 && acct.prices === 4 * 3 + 4 && acct.hooks === 1, 'created 3 products, 16 prices, 1 webhook', { p: acct.products, pr: acct.prices, h: acct.hooks });
check(acct.hookList[0].url === API + '/api/churches/' + slug + '/webhooks/stripe', 'webhook URL per church', acct.hookList);
check(acct.hookList[0].enabled_events.includes('customer.subscription.deleted'), 'webhook hears canceled subscriptions', acct.hookList[0].enabled_events);
let portalCfg = acct.portalConfigs[0];
check(acct.portalConfigs.length === 1 && portalCfg.metadata.belong_church === slug, 'one customer portal configuration, tagged with the church', acct.portalConfigs);
check(portalCfg.features.subscription_cancel.enabled && portalCfg.features.subscription_cancel.mode === 'immediately' && portalCfg.login_page.enabled && portalCfg.login_page.url, 'portal lets donors cancel and has a login page', portalCfg);
check(r.data.stripe.portal === true && !r.data.stripe.portalNote, 'staff status shows the portal is ready', r.data.stripe);

r = await call('POST', C + '/admin/stripe', { key: KEY }, token);
s = (await stripeLog()).accounts; acct = Object.values(s)[0];
check(r.data.provision.ok && r.data.provision.reused === 3 && r.data.provision.created === 0, 'connect again reuses', r.data.provision);
check(acct.products === 3 && acct.prices === 16 && acct.hooks === 1, 'no duplicates after second connect', { p: acct.products, pr: acct.prices, h: acct.hooks });
check(acct.portalConfigs.length === 1 && acct.portalConfigs[0].id === portalCfg.id, 'portal configuration reused after second connect', acct.portalConfigs.map((x) => x.id));
r = await call('POST', C + '/admin/stripe/sync', {}, token);
s = (await stripeLog()).accounts; acct = Object.values(s)[0];
check(r.data.provision.ok && acct.products === 3 && acct.prices === 16 && acct.hooks === 1, 'sync is idempotent too');
check(acct.portalConfigs.length === 1, 'sync does not add a portal configuration');
let before = (await stripeLog()).log.length;
await call('POST', C + '/admin/stripe/sync', {}, token);
let writes = (await stripeLog()).log.slice(before).filter((l) => l.method === 'POST' && l.path.startsWith('/v1/billing_portal/'));
check(writes.length === 0, 'a ready portal configuration is left alone on sync', writes);
// A webhook made by an older version lacks customer.subscription.deleted; sync adds it.
await fetch(STRIPE + '/__old_hooks');
r = await call('POST', C + '/admin/stripe/sync', {}, token);
s = (await stripeLog()).accounts; acct = Object.values(s)[0];
check(acct.hooks === 1 && acct.hookList[0].enabled_events.includes('customer.subscription.deleted'), 'sync upgrades an older webhook in place', acct.hookList);
r = await call('GET', C);
check(r.data.manage === 'portal' && r.data.portalUrl === portalCfg.login_page.url, 'public church shows the portal login page', { manage: r.data.manage, portalUrl: r.data.portalUrl });

console.log('funds and trips');
r = await call('POST', C + '/admin/funds', { kind: 'trip', name: 'Kenya water project', description: 'Wells for two villages.', goal: 1200000, startDate: '2027-02-01', endDate: '2027-02-10', location: 'Kisumu, Kenya', spots: 8, applicationsOpen: true }, token);
check(r.status === 200 && r.data.fundId.startsWith('trip-') && !r.data.stripeNote, 'trip created', r.data.stripeNote || r.data.error);
const tripId = r.data.fundId;
s = (await stripeLog()).accounts; acct = Object.values(s)[0];
check(acct.products === 4 && acct.prices === 20, 'trip added its own product + 4 prices', { p: acct.products, pr: acct.prices });
check(acct.productList.some((p) => p.metadata.belong_fund === tripId && p.name.startsWith('Kenya water project')), 'trip product tagged in metadata');
r = await call('POST', C + '/admin/funds', { kind: 'trip', name: 'Bad dates', startDate: '2027-03-01', endDate: '2027-02-01' }, token);
check(r.status === 400, 'end before start rejected');
r = await call('PUT', C + '/admin/funds/missions', { goal: 500000 }, token);
check(r.status === 200 && r.data.funds.find((f) => f.id === 'missions').goal === 500000, 'update fund goal');
r = await call('POST', C + '/admin/stripe/sync', {}, token);
s = (await stripeLog()).accounts; acct = Object.values(s)[0];
check(acct.products === 4 && acct.prices === 20 && acct.hooks === 1, 'sync after trip still no duplicates');

console.log('checkout');
// The site no longer asks for a name or email: Stripe Checkout does.
r = await call('POST', C + '/checkout', { fund: 'general', amount: 5000 });
check(r.status === 200 && r.data.url.startsWith(STRIPE + '/pay/cs_'), 'one-time preset checkout, no name or email needed', r.data);
const sess1 = r.data.url.split('/pay/')[1];
let log = (await stripeLog()).log.filter((l) => l.path === '/v1/checkout/sessions').pop();
check(log && log.idem.startsWith('belong-checkout-'), 'checkout uses an idempotency key');
let stripeSess = () => stripeLog().then((x) => Object.values(x.accounts)[0].sessionList);
let cs1 = (await stripeSess()).find((x) => x.id === sess1);
check(cs1.name_collection?.individual?.enabled && !cs1.customer_email, 'Checkout asks for the name (name_collection), and the site sends no email', cs1);
r = await call('POST', C + '/checkout', { fund: tripId, amount: 1234, anonymous: true, name: 'Old Page Name', email: 'oldpage@example.com' });
check(r.status === 200 && r.data.url.includes('/pay/cs_'), 'custom amount to a trip (name, email and anonymous from an old page ignored)');
const sess2 = r.data.url.split('/pay/')[1];
check(!(await stripeSess()).find((x) => x.id === sess2).customer_email, 'an old page email is not passed to Stripe');
r = await call('POST', C + '/checkout', { fund: 'tithes', amount: 10000, cadence: 'month' });
check(r.status === 200 && !r.data.manage, 'monthly tithe (preset recurring price), no demo manage link', r.data);
const sess3 = r.data.url.split('/pay/')[1];
r = await call('POST', C + '/checkout', { fund: 'tithes', amount: 4321, cadence: 'month' });
check(r.status === 200, 'monthly tithe custom amount (inline recurring)', r.data);
const sess4 = r.data.url.split('/pay/')[1];
r = await call('POST', C + '/checkout', { fund: 'general', amount: 10000, cadence: 'month' });
check(r.status === 200, 'monthly on non-recurring fund falls back to one-time', r.data);
r = await call('POST', C + '/checkout', { fund: 'general', amount: 50 });
check(r.status === 400, 'too small rejected');
r = await call('POST', C + '/checkout', { fund: 'nope', amount: 5000 });
check(r.status === 400, 'unknown fund rejected');
r = await call('GET', C + '/admin/donations', undefined, token);
check(r.data.donations.filter((d) => d.status === 'pending').every((d) => !d.name && !d.email), 'before payment a gift has no name or email yet', r.data.donations);

// Pay #1 with webhook, #2 without webhook (reconciled on return), #3 with webhook.
// The name and email are what the donor typed into Stripe Checkout.
const typed = (name, email) => '?name=' + encodeURIComponent(name) + '&email=' + encodeURIComponent(email);
let pay = await fetch(STRIPE + '/pay/' + sess1 + typed('Private Person', 'private@example.com'), { redirect: 'manual' });
check(pay.status === 302 && pay.headers.get('location').startsWith(ORIGIN + '/give?church=' + slug + '&session_id=' + sess1), 'success_url returns to /give with church + session', pay.headers.get('location'));
log = (await stripeLog()).log.filter((l) => l.webhook);
check(log.length && log[log.length - 1].status === 200, 'webhook delivered and verified', log);
r = await call('GET', C + '/confirm/' + sess1);
check(r.data.status === 'completed' && r.data.amount === 5000 && !r.text.includes('Private'), 'confirm after webhook, no donor name', r.data);
await fetch(STRIPE + '/pay/' + sess2 + typed('Trip Giver', 'tripgiver@example.com') + '&hook=0', { redirect: 'manual' });
r = await call('GET', C + '/confirm/' + sess2);
check(r.data.status === 'completed' && r.data.amount === 1234, 'confirm reconciles with Stripe when webhook is missing', r.data);
await fetch(STRIPE + '/pay/' + sess3 + typed('Monthly Tither', 'tither@example.com'), { redirect: 'manual' });
await fetch(STRIPE + '/pay/' + sess4 + typed('Second Tither', 'second@example.com') + '&hook=0', { redirect: 'manual' });

console.log('monthly gifts: customer portal');
r = await call('GET', C + '/confirm/' + sess3);
check(r.data.status === 'completed' && r.data.cadence === 'month' && r.data.manage === 'portal' && !r.data.canceled, 'confirm offers the portal for a monthly gift', r.data);
r = await call('GET', C + '/confirm/' + sess1);
check(r.data.manage === '', 'no manage option for a one-time gift', r.data);
const stripeSess3 = (await stripeLog()).accounts[Object.keys((await stripeLog()).accounts)[0]].sessionList.find((x) => x.id === sess3);
r = await call('POST', C + '/portal', { session: sess3 });
check(r.status === 200 && r.data.url && r.data.url.startsWith(STRIPE + '/portal/bps_'), 'portal session opens for a monthly gift', r.data);
const portalSessId = r.data.url && r.data.url.split('/portal/')[1];
s = (await stripeLog()).accounts; acct = Object.values(s)[0];
const ps = acct.portalSessions.find((x) => x.id === portalSessId);
check(ps && ps.customer === stripeSess3.customer && ps.configuration === portalCfg.id, "portal session is for that checkout's own customer, with the church's configuration", { ps, customer: stripeSess3.customer });
check(ps && ps.return_url === ORIGIN + '/#/give', 'portal returns to the Give page', ps);
r = await call('POST', C + '/portal', { session: sess1 });
check(r.status === 400, 'no portal for a one-time gift', r.data);
r = await call('POST', C + '/portal', { session: 'cs_test_doesnotexist' });
check(r.status === 404, 'no portal for an unknown session', r.data);
r = await call('POST', C + '/portal', { session: 'not-a-session' });
check(r.status === 404, 'no portal for a malformed session id', r.data);
r = await call('POST', '/api/churches/' + slugB + '/portal', { session: sess3 });
check(r.status === 404, "another church cannot open this church's portal session", r.data);
before = (await stripeLog()).accounts[Object.keys((await stripeLog()).accounts)[0]].portalSessions.length;
check(before === 1, 'only one portal session was created', before);

// The donor cancels inside the Stripe portal; the webhook marks the gift canceled.
await fetch(STRIPE + '/portal/' + portalSessId + '?cancel=1');
log = (await stripeLog()).log.filter((l) => l.webhook && l.type === 'customer.subscription.deleted');
check(log.length === 1 && log[0].status === 200, 'customer.subscription.deleted delivered and verified', log);
r = await call('GET', C + '/confirm/' + sess3);
check(r.data.canceled === true && r.data.manage === '', 'confirm shows the monthly gift as canceled', r.data);

// Forged webhook
let fake = await fetch(API + C + '/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 't=' + Math.floor(Date.now() / 1000) + ',v1=deadbeef' }, body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_forged', metadata: { belong_church: slug }, payment_status: 'paid', amount_total: 99999999 } } }) });
check(fake.status === 400, 'forged webhook rejected');

console.log('public view');
r = await call('GET', C);
const general = r.data.funds.find((f) => f.id === 'general');
const trip = r.data.trips.find((t) => t.id === tripId);
check(r.data.mode === 'test', 'public mode test');
check(general.raised === 5000 && general.gifts === 1, 'general raised counts completed only', general);
check(trip.raised === 1234 && trip.gifts === 1 && trip.spots === 8, 'trip progress', trip);
check(r.data.totals.raised === 5000 + 1234 + 10000, 'totals', r.data.totals);

console.log('applications');
r = await call('POST', C + '/trips/' + tripId + '/apply', { name: 'Applicant One', email: 'app1@example.com', phone: '555-0100', message: 'I am a nurse.' });
check(r.status === 200, 'apply');
r = await call('POST', C + '/trips/' + tripId + '/apply', { name: 'No Email' });
check(r.status === 400, 'apply needs email');
r = await call('POST', C + '/trips/general/apply', { name: 'X', email: 'x@example.com' });
check(r.status === 404, 'cannot apply to a non-trip fund');
r = await call('GET', C + '/admin/applications', undefined, token);
check(r.data.applications.length === 1 && r.data.applications[0].name === 'Applicant One', 'admin sees application');
const appId = r.data.applications[0].id;
r = await call('PUT', C + '/admin/applications/' + appId, { status: 'accepted', note: 'Great fit' }, token);
check(r.data.applications[0].status === 'accepted' && r.data.applications[0].note === 'Great fit', 'review application');
r = await call('GET', C);
check(r.data.trips.find((t) => t.id === tripId).filled === 1, 'accepted count shows publicly (count only)');
r = await call('GET', '/api/churches/' + slugB + '/admin/applications', undefined, tokenB);
check(r.status === 200 && r.data.applications.length === 0, 'church B sees none of church A applications');
r = await call('PUT', C + '/admin/funds/' + tripId, { applicationsOpen: false }, token);
r = await call('POST', C + '/trips/' + tripId + '/apply', { name: 'Late', email: 'late@example.com' });
check(r.status === 400, 'closed trip rejects applications');

console.log('donations (staff only)');
r = await call('GET', C + '/admin/donations', undefined, token);
check(r.status === 200 && r.data.donations.some((d) => d.name === 'Private Person' && d.email === 'private@example.com'), 'staff see donor identity');
check(r.data.donations.filter((d) => d.status === 'completed').every((d) => d.name && d.email && !d.anonymous), 'staff see the Stripe name and email on every paid gift', r.data.donations.map((d) => [d.name, d.email, d.status]));
check(r.data.donations.some((d) => d.name === 'Trip Giver' && d.email === 'tripgiver@example.com' && d.fundId === tripId), 'confirm on return saves the Stripe name and email when the webhook is late');
check(!r.text.includes('Old Page Name') && !r.text.includes('oldpage@'), 'a name or email sent by an old page is not stored');
const tither = r.data.donations.find((d) => d.name === 'Monthly Tither');
check(tither && tither.canceled && tither.canceledAt && !tither.cancelable, 'staff see the portal-canceled monthly gift as canceled', tither);
const oneTime = r.data.donations.find((d) => d.name === 'Private Person');
r = await call('POST', C + '/admin/donations/' + oneTime.id + '/cancel', {}, token);
check(r.status === 400, 'staff cannot cancel a one-time gift', r.data);
r = await call('POST', C + '/admin/donations/' + tither.id + '/cancel', {});
check(r.status === 401, 'staff cancel needs auth');

console.log('staff cancel a live monthly gift');
r = await call('GET', C + '/confirm/' + sess4);
check(r.data.status === 'completed' && r.data.manage === 'portal', 'second monthly gift confirmed on return', r.data);
r = await call('GET', C + '/admin/donations', undefined, token);
const second = r.data.donations.find((d) => d.name === 'Second Tither');
check(second && second.cancelable && !second.canceled, 'active monthly gift can be canceled by staff', second);
r = await call('POST', C + '/admin/donations/' + second.id + '/cancel', {}, token);
check(r.status === 200 && r.data.donations.find((d) => d.id === second.id).canceled, 'staff cancel marks it canceled', r.data);
s = (await stripeLog()).accounts; acct = Object.values(s)[0];
const stripeSess4 = acct.sessionList.find((x) => x.id === sess4);
check(acct.subscriptions.find((x) => x.id === stripeSess4.subscription)?.status === 'canceled', 'staff cancel cancels the Stripe subscription', acct.subscriptions);
r = await call('POST', C + '/admin/donations/' + second.id + '/cancel', {}, token);
check(r.status === 200, 'canceling twice is harmless', r.data);
r = await call('POST', C + '/portal', { session: sess4 });
check(r.status === 200, 'portal still opens after canceling (to see history)', r.data);
r = await call('GET', C + '/admin/donations');
check(r.status === 401, 'donations need auth');
r = await call('GET', '/api/churches/' + slugB + '/admin/donations', undefined, tokenB);
check(r.data.donations.length === 0, 'church B sees none of church A gifts');

console.log('restricted key without webhook permission');
r = await call('POST', '/api/churches/' + slugB + '/admin/stripe', { key: 'rk_test_NOHOOK' + 'c'.repeat(20) }, tokenB);
check(r.status === 200 && r.data.provision.ok && r.data.provision.webhookNote, 'provisions products, notes webhook problem', r.data.provision);
check(r.data.stripe.mode === 'test' && !r.data.stripe.webhook && r.data.stripe.keyHint.startsWith('rk_test_'), 'restricted key status');

console.log('disconnect');
r = await call('DELETE', '/api/churches/' + slugB + '/admin/stripe', undefined, tokenB);
check(r.status === 200 && !r.data.stripe.connected && r.data.stripe.mode === 'demo', 'disconnect returns to demo');

console.log('older Stripe API version without name_collection');
r = await call('POST', '/api/churches/' + slugB + '/admin/stripe', { key: 'sk_test_GOODOLDAPI' + 'd'.repeat(20) }, tokenB);
check(r.status === 200 && r.data.provision.ok, 'church B connects a key on an older API version', r.data.provision);
r = await call('POST', '/api/churches/' + slugB + '/checkout', { fund: 'general', amount: 2500 });
check(r.status === 200 && r.data.url.includes('/pay/cs_'), 'checkout still starts', r.data);
const sessOld = r.data.url.split('/pay/')[1];
const oldSess = Object.values((await stripeLog()).accounts).flatMap((a) => a.sessionList).find((x) => x.id === sessOld);
check(oldSess && !oldSess.name_collection && oldSess.billing_address_collection === 'required', 'falls back to the billing address form, which asks for the name', oldSess);
await fetch(STRIPE + '/pay/' + sessOld + '?name=' + encodeURIComponent('Address Giver') + '&email=address@example.com', { redirect: 'manual' });
r = await call('GET', '/api/churches/' + slugB + '/admin/donations', undefined, tokenB);
check(r.data.donations.some((d) => d.name === 'Address Giver' && d.email === 'address@example.com' && d.status === 'completed'), 'name and email saved from the billing address form', r.data.donations);

console.log('sitewide: directory and staff session check');
r = await call('GET', '/api/directory/' + slug);
check(r.status === 200 && r.data.slug === slug && r.data.name.startsWith('Hope Chapel') && r.data.city === 'Austin' && !r.text.includes('password'), 'directory lists a church', r.data);
r = await call('GET', '/api/directory/grace-community');
check(r.status === 200 && r.data.name === 'Grace Community', 'directory lists the demo church', r.data);
r = await call('GET', '/api/directory/no-such-church');
check(r.status === 404, 'directory 404 for an unknown church');
r = await call('GET', C + '/admin/session', undefined, token);
check(r.status === 200 && r.data.ok && r.data.slug === slug, 'own staff session is valid', r.data);
r = await call('GET', C + '/admin/session', undefined, tokenB);
check(r.status === 401, 'another church session is not valid here');
r = await call('GET', C + '/admin/session');
check(r.status === 401, 'no session, no staff');
r = await call('GET', '/api/churches/grace-community/admin/session', undefined, token);
check(r.status === 401, 'a new church session is not valid for the demo church');

console.log('platform list (the platform team only)');
const PLATFORM_KEY = process.env.PLATFORM_KEY || '';
async function platform(base, key, ip = '10.1.0.' + Math.floor(Math.random() * 250)) {
  const headers = { origin: ORIGIN, 'cf-connecting-ip': ip };
  if (key) headers.authorization = 'Bearer ' + key;
  const res = await fetch(base + '/api/platform/churches', { headers });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}
for (const base of [process.env.API_NO_PLATFORM, PLATFORM_KEY ? '' : API].filter(Boolean)) {
  r = await platform(base, 'any-key-at-all-1234567890');
  check(r.status === 404, 'without PLATFORM_ADMIN_KEY the platform list is off (404) at ' + base, r.data);
  r = await platform(base);
  check(r.status === 404, 'without PLATFORM_ADMIN_KEY, no key is a 404 too', r.data);
}
if (PLATFORM_KEY) {
  r = await platform(API);
  check(r.status === 401 && !r.data.churches, 'no key, no list', r.data);
  r = await platform(API, PLATFORM_KEY + 'x');
  check(r.status === 401 && !r.data.churches, 'wrong key 401', r.data);
  r = await platform(API, PLATFORM_KEY.slice(0, -1));
  check(r.status === 401 && !r.data.churches, 'a shorter key 401', r.data);
  r = await platform(API, tokenB);
  check(r.status === 401 && !r.data.churches, 'a church staff session is not the platform key', r.data);
  r = await platform(API, 'gloo-donate-demo');
  check(r.status === 401, 'the demo ADMIN_KEY is not the platform key', r.data);
  r = await platform(API, PLATFORM_KEY);
  const all = r.data.churches || [];
  const bySlug = Object.fromEntries(all.map((c) => [c.slug, c]));
  check(r.status === 200 && bySlug[slug] && bySlug[slugB] && bySlug['grace-community'], 'right key lists every church, including new ones', all.map((c) => c.slug));
  const a = bySlug[slug] || {};
  const pubA = (await call('GET', C)).data;
  check(a.name === pubA.name && a.city === 'Austin' && !a.demo && /^\d{4}-\d{2}-\d{2}T/.test(a.createdAt), 'church A: name, city, created date, not the demo', a);
  check(a.giving && a.giving.mode === 'test' && a.giving.currency === 'usd' && a.giving.funds === 3 && a.giving.trips === 1, 'church A: test mode, 3 funds, 1 trip', a.giving);
  check(a.giving && a.giving.gifts === pubA.totals.gifts && a.giving.raised === pubA.totals.raised && a.giving.gifts > 0, 'church A: gift count and total match its public totals', { platform: a.giving, public: pubA.totals });
  check(a.giving && a.giving.setup.stripe && a.giving.setup.trip && a.giving.setup.done, 'church A: staff setup done', a.giving && a.giving.setup);
  const b = bySlug[slugB] || {};
  check(b.city === 'Dallas' && b.giving && b.giving.mode === 'test' && b.giving.trips === 0 && !b.giving.setup.trip && !b.giving.setup.done, 'church B: no trip yet, so setup is not done', b);
  const demoRow = bySlug['grace-community'] || {};
  check(demoRow.demo === true && demoRow.name === 'Grace Community' && demoRow.giving && demoRow.giving.mode === 'demo', 'the demo church is flagged as the demo, in demo mode', demoRow);
  check(all.every((c) => Object.keys(c).sort().join() === 'city,createdAt,demo,giving,name,slug'), 'each church has only slug, name, city, createdAt, demo and giving', all.map((c) => Object.keys(c)));
  check(all.every((c) => !c.giving || Object.keys(c.giving).sort().join() === 'currency,funds,gifts,mode,raised,setup,trips'), 'giving is counts and mode only', all.map((c) => c.giving));
  const secretish = /GOOD|NOHOOK|sk_test_|rk_test_|sk_live_|whsec_|we_|Private Person|private@example|Monthly Tither|tither@|Applicant One|app1@|Trip Giver|tripgiver@|Second Tither|second@example|Address Giver|address@example|Demo donor|Demo Monthly|cus_|sub_|bpc_|bps_|pbkdf2|password|hash|hint|stripe_key|email|portal|webhook|acct_/i;
  check(!secretish.test(r.text), 'no password, hash, Stripe key or hint, webhook, portal or donor data in the list', r.text.slice(0, 600));
  // Wrong keys are rate limited per IP like staff sign-in; only wrong keys count.
  const ip = '10.2.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
  r = await platform(API, PLATFORM_KEY, ip);
  check(r.status === 200, 'a right key does not use up the limit', r.data);
  for (let i = 0; i < 5; i++) await platform(API, 'wrong-key-' + i, ip);
  r = await platform(API, 'wrong-key-6', ip);
  check(r.status === 429, 'the sixth wrong key in a minute is refused', r.data);
  r = await platform(API, PLATFORM_KEY, ip);
  check(r.status === 429 && !r.data.churches, 'that IP waits even with the right key', r.data);
  r = await platform(API, PLATFORM_KEY);
  check(r.status === 200 && r.data.churches.length === all.length, 'another IP still gets the list', r.data);
}
for (const q of ['', '?q=Hope', '?q=' + suffix]) {
  r = await call('GET', '/api/churches' + q);
  const slugs = (r.data.churches || []).map(c => c.slug);
  check(r.status === 200 && slugs.length <= 1 && slugs.every(x => x === 'grace-community'), 'public list ' + (q || 'with no query') + ' still shows only the demo church', r.data);
}

console.log('logout');
r = await call('POST', C + '/admin/logout', {}, token);
r = await call('GET', C + '/admin', undefined, token);
check(r.status === 401, 'token dead after logout');

console.log('legacy endpoints');
r = await call('GET', '/api/gifts');
check(Array.isArray(r.data.list) && r.data.list.length === 0 && typeof r.data.count === 'number', 'legacy /api/gifts no longer lists donors', r.data);
r = await call('GET', '/api/config');
check(r.data.churchName && r.data.goal, 'legacy /api/config still works');
r = await call('POST', '/api/checkout', { amount: 5000, anonymous: true });
check(r.status === 200 && r.data.demo, 'legacy checkout works without a name or email', r.data);

console.log('demo church: monthly gift managed on the website');
const DEMO = '/api/churches/grace-community';
r = await call('GET', DEMO);
check(r.data.mode === 'demo' && r.data.manage === 'link' && r.data.portalUrl === '', 'demo church manages gifts by private link', { mode: r.data.mode, manage: r.data.manage });
r = await call('POST', DEMO + '/checkout', { fund: 'general', amount: 5000 });
check(r.status === 200 && r.data.demo && !r.data.manage, 'demo one-time gift has no manage link', r.data);
r = await call('POST', DEMO + '/checkout', { fund: 'tithes', amount: 5000, cadence: 'month', name: 'Demo Monthly', email: 'demo-monthly@example.com' });
const demoGiftId = r.data.id;
check(r.status === 200 && r.data.demo && /^grace-community\.[\w-]{40,}$/.test(r.data.manage || ''), 'demo monthly gift returns a private manage link', r.data);
const demoSession = new URL(r.data.url).searchParams.get('session_id');
const demoRaw = r.data.manage.split('.')[1];
r = await call('GET', DEMO + '/confirm/' + demoSession);
check(r.data.status === 'demo' && r.data.cadence === 'month' && r.data.manage === 'link' && !r.data.canceled, 'demo confirm offers manage', r.data);
r = await call('GET', DEMO + '/manage/' + demoRaw);
check(r.status === 200 && r.data.amount === 5000 && r.data.cadence === 'month' && r.data.fund && !r.data.canceled && r.data.demo, 'manage link shows the gift', r.data);
check(!r.text.includes('Demo Monthly') && !r.text.includes('demo-monthly@'), 'manage link never shows name or email');
r = await call('GET', DEMO + '/manage/' + demoRaw.slice(0, -2) + 'xx');
check(r.status === 404, 'wrong token rejected', r.data);
r = await call('GET', C + '/manage/' + demoRaw);
check(r.status === 404, "token does not work for another church", r.data);
r = await call('POST', DEMO + '/manage/' + demoRaw + '/cancel', {});
check(r.status === 200 && r.data.canceled && r.data.canceledAt, 'donor cancels the demo monthly gift', r.data);
r = await call('POST', DEMO + '/manage/' + demoRaw + '/cancel', {});
check(r.status === 200 && r.data.canceled, 'canceling again is harmless');
r = await call('GET', DEMO + '/confirm/' + demoSession);
check(r.data.canceled && r.data.manage === '', 'demo confirm shows canceled', r.data);
r = await call('GET', DEMO + '/admin/donations', undefined, demoToken);
const demoGift = r.data.donations.find((d) => d.id === demoGiftId);
check(demoGift && demoGift.name === 'Demo donor' && demoGift.email === '' && demoGift.canceled && !demoGift.cancelable, 'demo gift is recorded as "Demo donor" (no Stripe to ask), canceled status shown', demoGift);
check(!r.text.includes('Demo Monthly') && !r.text.includes('demo-monthly@'), 'demo ignores a name or email sent by an old page');
r = await call('POST', DEMO + '/checkout', { fund: 'tithes', amount: 2500, cadence: 'month' });
const demoGift2Id = r.data.id;
r = await call('GET', DEMO + '/admin/donations', undefined, demoToken);
const demoGift2 = r.data.donations.find((d) => d.id === demoGift2Id);
check(demoGift2 && demoGift2.cancelable, 'new demo monthly gift is cancelable by staff', demoGift2);
r = await call('POST', DEMO + '/admin/donations/' + demoGift2.id + '/cancel', {}, demoToken);
check(r.status === 200 && r.data.donations.find((d) => d.id === demoGift2.id).canceled, 'demo staff cancel', r.data);

console.log('staff accounts');
// A church that signs up with an owner account.
r = await call('POST', '/api/churches', { name: 'Accounts Church ' + suffix, city: 'Austin', password: 'owner password 1', ownerName: 'Olive Owner', ownerEmail: 'Staff-Owner-' + suffix + '@Example.org' });
check(r.status === 201 && r.data.token, 'sign-up with an owner account', r.data);
const S = '/api/churches/' + r.data.slug;
const ownerEmail = 'staff-owner-' + suffix + '@example.org';
let ownerToken = r.data.token;
r = await call('GET', S + '/admin', undefined, ownerToken);
check(r.status === 200 && r.data.me.role === 'owner' && r.data.me.email === ownerEmail && !r.data.me.shared, 'sign-up session is the owner account (email stored lower-case)', r.data.me);
r = await call('POST', S + '/admin/login', { password: 'owner password 1' });
check(r.status === 401 && /email/.test(r.data.error), 'shared password stops working once accounts exist', r.data);
r = await call('POST', S + '/admin/login', { email: ownerEmail.toUpperCase(), password: 'owner password 1' });
check(r.status === 200 && r.data.me.role === 'owner', 'owner signs in with email (any case) and password', r.data);
r = await call('POST', S + '/admin/login', { email: ownerEmail, password: 'wrong password 1' });
check(r.status === 401, 'wrong account password rejected');
r = await call('POST', S + '/admin/login', { email: 'nobody-' + suffix + '@example.org', password: 'owner password 1' });
check(r.status === 401 && r.data.error === 'That email or password is not right.', 'unknown email gets the same answer as a wrong password', r.data);

// The owner adds a site admin.
const adminEmail = 'staff-admin-' + suffix + '@example.org';
r = await call('POST', S + '/admin/users', { name: 'Sam Siteadmin', email: adminEmail, role: 'site_admin', password: 'temporary pass 1' }, ownerToken);
check(r.status === 200 && r.data.users.length === 2 && r.data.canManage, 'owner adds a site admin', r.data);
const siteAdminId = r.data.users.find((u) => u.email === adminEmail)?.id;
r = await call('POST', S + '/admin/users', { name: 'Dup', email: adminEmail.toUpperCase(), role: 'site_admin', password: 'temporary pass 1' }, ownerToken);
check(r.status === 409, 'duplicate email rejected', r.data);
for (const [body, label] of [
  [{ name: 'X', email: 'x-' + suffix + '@example.org', role: 'site_admin', password: 'temporary pass 1' }, 'too-short name'],
  [{ name: 'Bad Email', email: 'not-an-email', role: 'site_admin', password: 'temporary pass 1' }, 'bad email'],
  [{ name: 'Bad Role', email: 'r-' + suffix + '@example.org', role: 'superuser', password: 'temporary pass 1' }, 'unknown role'],
  [{ name: 'Short Pass', email: 'p-' + suffix + '@example.org', role: 'site_admin', password: 'short' }, 'short temporary password'],
]) {
  r = await call('POST', S + '/admin/users', body, ownerToken);
  check(r.status === 400, 'rejects ' + label, r.data);
}
r = await call('POST', S + '/admin/login', { email: adminEmail, password: 'temporary pass 1' });
check(r.status === 200 && r.data.me.role === 'site_admin', 'site admin signs in', r.data);
const siteAdminToken = r.data.token;

// Site admins do everything except manage accounts.
r = await call('GET', S + '/admin', undefined, siteAdminToken);
check(r.status === 200 && r.data.me.role === 'site_admin', 'site admin opens the staff dashboard');
r = await call('PUT', S + '/admin/funds/missions', { goal: 250000 }, siteAdminToken);
check(r.status === 200, 'site admin edits a fund', r.data);
r = await call('GET', S + '/admin/session', undefined, siteAdminToken);
check(r.status === 200 && r.data.me.role === 'site_admin', 'session check reports the role', r.data);
r = await call('GET', S + '/admin/users', undefined, siteAdminToken);
check(r.status === 200 && r.data.users.length === 2 && !r.data.canManage, 'site admin sees the team but cannot manage it', r.data);
r = await call('POST', S + '/admin/users', { name: 'Sneaky Add', email: 'sneaky-' + suffix + '@example.org', role: 'owner', password: 'temporary pass 1' }, siteAdminToken);
check(r.status === 403, 'site admin cannot add accounts', r.data);
const ownerId = (await call('GET', S + '/admin/users', undefined, ownerToken)).data.users.find((u) => u.role === 'owner').id;
r = await call('DELETE', S + '/admin/users/' + ownerId, undefined, siteAdminToken);
check(r.status === 403, 'site admin cannot remove accounts', r.data);

// Guardrails for owners.
r = await call('DELETE', S + '/admin/users/' + ownerId, undefined, ownerToken);
check(r.status === 400, 'owner cannot remove their own account', r.data);
r = await call('POST', S + '/admin/users', { name: 'Second Owner', email: 'owner2-' + suffix + '@example.org', role: 'owner', password: 'temporary pass 2' }, ownerToken);
const owner2Id = r.data.users.find((u) => u.email === 'owner2-' + suffix + '@example.org').id;
r = await call('POST', S + '/admin/login', { email: 'owner2-' + suffix + '@example.org', password: 'temporary pass 2' });
const owner2Token = r.data.token;
r = await call('DELETE', S + '/admin/users/' + ownerId, undefined, owner2Token);
check(r.status === 200 && r.data.users.length === 2, 'another owner can remove the first owner', r.data);
r = await call('GET', S + '/admin', undefined, ownerToken);
check(r.status === 401, 'a removed account is signed out right away');
r = await call('DELETE', S + '/admin/users/' + owner2Id, undefined, owner2Token);
check(r.status === 400, 'the last owner cannot be removed (and not by themselves)', r.data);
r = await call('DELETE', S + '/admin/users/00000000-0000-0000-0000-000000000000', undefined, owner2Token);
check(r.status === 404, 'removing an unknown account is a 404', r.data);

// Each account changes its own password and signs out its other sessions.
r = await call('POST', S + '/admin/login', { email: adminEmail, password: 'temporary pass 1' });
const siteAdminToken2 = r.data.token;
r = await call('POST', S + '/admin/password', { current: 'temporary pass 1', next: 'my own password 1' }, siteAdminToken);
check(r.status === 200 && r.data.token, 'site admin changes their own password', r.data);
const siteAdminToken3 = r.data.token;
r = await call('GET', S + '/admin', undefined, siteAdminToken2);
check(r.status === 401, "the account's other sessions are signed out");
r = await call('GET', S + '/admin', undefined, owner2Token);
check(r.status === 200, "other people's sessions stay signed in");
r = await call('GET', S + '/admin', undefined, siteAdminToken3);
check(r.status === 200 && r.data.me.role === 'site_admin', 'the new session keeps the role');
r = await call('POST', S + '/admin/login', { email: adminEmail, password: 'my own password 1' });
check(r.status === 200, 'new password works');
r = await call('DELETE', S + '/admin/users/' + siteAdminId, undefined, owner2Token);
check(r.status === 200 && r.data.users.length === 1, 'owner removes the site admin', r.data);
r = await call('GET', S + '/admin', undefined, siteAdminToken3);
check(r.status === 401, 'removed site admin is signed out right away');

// A church on the shared password moves to accounts: the first account must be an owner.
r = await call('POST', '/api/churches', { name: 'Shared Church ' + suffix, city: 'Austin', password: 'shared password 1' });
const L = '/api/churches/' + r.data.slug;
const sharedToken = r.data.token;
r = await call('GET', L + '/admin', undefined, sharedToken);
check(r.status === 200 && r.data.me.shared && r.data.me.role === 'owner', 'the shared password acts as owner', r.data.me);
r = await call('POST', L + '/admin/users', { name: 'Not First', email: 'nf-' + suffix + '@example.org', role: 'site_admin', password: 'temporary pass 1' }, sharedToken);
check(r.status === 400, 'the first account must be an owner', r.data);
r = await call('POST', L + '/admin/users', { name: 'Fran First', email: 'first-' + suffix + '@example.org', role: 'owner', password: 'first owner pass 1' }, sharedToken);
check(r.status === 200 && r.data.users.length === 1, 'shared-password owner creates the first owner account', r.data);
r = await call('POST', L + '/admin/login', { password: 'shared password 1' });
check(r.status === 401, 'after that the shared password no longer signs in', r.data);
r = await call('POST', L + '/admin/login', { email: 'first-' + suffix + '@example.org', password: 'first owner pass 1' });
check(r.status === 200 && r.data.me.role === 'owner', 'the new owner signs in with email', r.data);

// The demo church always keeps its ADMIN_KEY login, so the team never loses it.
r = await call('POST', '/api/churches/grace-community/admin/login', { password: demoPassword });
check(r.status === 200 && r.data.me.role === 'owner', 'demo church ADMIN_KEY still signs in as owner', r.data);
r = await call('POST', S + '/admin/login', { password: demoPassword });
check(r.status === 401, 'ADMIN_KEY does not open other churches', r.data);

console.log('leak scan of every public response');
const leaks = publicDumps.filter((d) => /GOOD|NOHOOK|sk_test_|rk_test_|whsec_|Private Person|private@example|Monthly Tither|tither@|Applicant One|app1@|Alice|Bob Donor|Trip Giver|tripgiver@|Second Tither|second@example|Demo Monthly|demo-monthly@|Demo Once|demo-once@|Card Holder|Address Giver|address@example|Old Page Name|oldpage@|staff-owner-|staff-admin-|Olive Owner|Sam Siteadmin|cus_|sub_|bpc_|pbkdf2|password_hash|stripe_key/.test(d.text));
check(leaks.length === 0, 'no key, secret, donor or applicant data in ' + publicDumps.length + ' public responses', leaks.map((l) => l.path + ' ' + l.text.slice(0, 200)));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
