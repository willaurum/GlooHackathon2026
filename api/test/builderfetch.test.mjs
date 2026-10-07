// The builder fetch bridge (api/builderfetch.ts). Run: node --test api/test/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILDER_FETCH_HOST, builderFetchBridge, builderFetchEnvVars, checkDns, checkUrl, isCalendarFeed, privateIp } from '../builderfetch.ts';

const ask = (url, kind = 'page', path = '/fetch', method = 'POST') =>
  new Request(`http://${BUILDER_FETCH_HOST}${path}`, { method, body: method === 'POST' ? JSON.stringify({ url, kind }) : undefined });

/** A fake internet: DNS-over-HTTPS answers from `dns`, pages from `pages` (url -> Response factory). */
function internet(dns, pages) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const q = new URL(url).searchParams;
      const records = (dns[q.get('name')] || []).filter((ip) => (q.get('type') === 'A') === !ip.includes(':'));
      return Response.json({ Status: 0, Answer: records.map((data) => ({ type: data.includes(':') ? 28 : 1, data })) });
    }
    const page = pages[url];
    if (!page) return new Response('missing', { status: 404 });
    return page();
  };
  return { fetcher, calls, fetched: () => calls.filter((c) => !c.url.startsWith('https://cloudflare-dns.com')).map((c) => c.url) };
}

const html = (body, headers = {}) => () => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

test('the container is pointed at the bridge host', () => {
  assert.deepEqual(builderFetchEnvVars(), { BUILDER_FETCH_URL: 'http://builder-fetch' });
});

test('private, loopback, link-local, metadata and reserved addresses are private', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.5', '198.18.0.1', '::', '::1', '[::1]', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1', 'ff02::1', 'not-an-ip'])
    assert.equal(privateIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e'])
    assert.equal(privateIp(ip), false, ip);
});

test('only plain http(s) URLs to public names pass the shape check', () => {
  for (const url of ['https://grace.example.org/', 'http://hope-chapel.church/about?x=1', 'https://grace.org:443/']) assert.ok(checkUrl(url) instanceof URL, url);
  for (const url of ['ftp://grace.org/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'https://user:pw@grace.org/', 42, 'https://' + 'a'.repeat(2000) + '.org'])
    assert.match(checkUrl(url), /starting with http/, String(url).slice(0, 40));
  for (const url of ['http://localhost/', 'http://LOCALHOST./', 'http://intranet/', 'http://printer.local/', 'http://metadata.google.internal/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'https://grace.org:8443/',
    'http://router.home.arpa/'])
    assert.match(checkUrl(url), /private network/, url);
});

test('a name that resolves to a private address is refused, as is one that does not resolve', async () => {
  const { fetcher } = internet({ 'grace.org': ['93.184.216.34', '2606:4700::1'], 'rebind.org': ['93.184.216.34', '10.0.0.7'], 'six.org': ['fd00::1'] }, {});
  assert.equal(await checkDns('grace.org', fetcher), null);
  assert.match(await checkDns('rebind.org', fetcher), /private network/);
  assert.match(await checkDns('six.org', fetcher), /private network/);
  assert.match(await checkDns('nowhere.org', fetcher), /could not be found/);
  assert.match(await checkDns('grace.org', async () => { throw new Error('offline'); }), /could not be found/);
});

test('a public page is fetched with its final URL and content type', async () => {
  const net = internet({ 'grace.org': ['93.184.216.34'] }, { 'https://grace.org/': html('<title>Grace</title>') });
  const res = await builderFetchBridge(ask('https://grace.org/'), net.fetcher);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<title>Grace</title>');
  assert.equal(res.headers.get('X-Final-Url'), 'https://grace.org/');
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const page = net.calls.find((c) => c.url === 'https://grace.org/');
  assert.equal(page.init.redirect, 'manual');
  assert.ok(page.init.signal);
});

test('every redirect is checked before it is followed', async () => {
  const net = internet({ 'grace.org': ['93.184.216.34'], 'www.grace.org': ['93.184.216.35'] }, {
    'https://grace.org/': () => new Response(null, { status: 301, headers: { Location: 'https://www.grace.org/home' } }),
    'https://www.grace.org/home': html('<p>Home</p>'),
    'https://grace.org/evil': () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } }),
    'https://grace.org/loop': () => new Response(null, { status: 302, headers: { Location: '/loop' } }),
  });
  const ok = await builderFetchBridge(ask('https://grace.org/'), net.fetcher);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('X-Final-Url'), 'https://www.grace.org/home');

  const evil = await builderFetchBridge(ask('https://grace.org/evil'), net.fetcher);
  assert.equal(evil.status, 403);
  assert.match((await evil.json()).detail, /private network/);
  assert.ok(!net.fetched().some((u) => u.includes('169.254')));

  const loop = await builderFetchBridge(ask('https://grace.org/loop'), net.fetcher);
  assert.equal(loop.status, 502);
  assert.match((await loop.json()).detail, /too many times/);
});

test('refused addresses never reach fetch; the status tells the backend it was a refusal', async () => {
  const net = internet({ 'inside.org': ['192.168.0.10'] }, {});
  for (const [url, status] of [['http://localhost:8000/', 403], ['https://inside.org/', 403], ['ftp://grace.org/', 400], ['https://nowhere.org/', 400]]) {
    const res = await builderFetchBridge(ask(url), net.fetcher);
    assert.equal(res.status, status, url);
    assert.equal(typeof (await res.json()).detail, 'string');
  }
  assert.deepEqual(net.fetched(), []);
});

test('pages are cut at 1 MB; images over 4 MB and wrong content types are refused', async () => {
  const big = 'x'.repeat(1_200_000);
  const net = internet({ 'grace.org': ['93.184.216.34'] }, {
    'https://grace.org/big': html(big),
    'https://grace.org/huge.png': () => new Response(new Uint8Array(4_100_000), { headers: { 'Content-Type': 'image/png' } }),
    'https://grace.org/a.png': () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }),
    'https://grace.org/file.zip': () => new Response('PK', { headers: { 'Content-Type': 'application/zip' } }),
    'https://grace.org/gone': () => new Response('no', { status: 500 }),
  });
  const page = await builderFetchBridge(ask('https://grace.org/big'), net.fetcher);
  assert.equal(page.status, 200);
  assert.equal((await page.arrayBuffer()).byteLength, 1_000_000);
  assert.equal((await builderFetchBridge(ask('https://grace.org/huge.png', 'image'), net.fetcher)).status, 413);
  const image = await builderFetchBridge(ask('https://grace.org/a.png', 'image'), net.fetcher);
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71]);
  assert.equal((await builderFetchBridge(ask('https://grace.org/a.png'), net.fetcher)).status, 415);
  assert.equal((await builderFetchBridge(ask('https://grace.org/file.zip'), net.fetcher)).status, 415);
  assert.equal((await builderFetchBridge(ask('https://grace.org/gone'), net.fetcher)).status, 502);
});

test('only POST /fetch with a small body is served', async () => {
  const net = internet({}, {});
  assert.equal((await builderFetchBridge(ask('https://grace.org/', 'page', '/other'), net.fetcher)).status, 404);
  assert.equal((await builderFetchBridge(ask('https://grace.org/', 'page', '/fetch', 'GET'), net.fetcher)).status, 404);
  const large = new Request(`http://${BUILDER_FETCH_HOST}/fetch`, { method: 'POST', body: JSON.stringify({ url: 'https://grace.org/', pad: 'x'.repeat(5000) }) });
  assert.equal((await builderFetchBridge(large, net.fetcher)).status, 413);
  const garbage = new Request(`http://${BUILDER_FETCH_HOST}/fetch`, { method: 'POST', body: '{nope' });
  assert.equal((await builderFetchBridge(garbage, net.fetcher)).status, 400);
});

test('a page that does not answer in time is reported, not hung', async () => {
  const fetcher = async (url, init) => {
    if (url.startsWith('https://cloudflare-dns.com')) return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };
  const res = await builderFetchBridge(ask('https://slow.org/'), fetcher);
  assert.equal(res.status, 504);
});

test('feeds (robots.txt, sitemaps, iCal, RSS) are their own kind; an HTML page is not a feed', async () => {
  const net = internet({ 'church.example.org': ['93.184.216.34'] }, {
    'https://church.example.org/calendar.ics': () => new Response('BEGIN:VCALENDAR', { headers: { 'Content-Type': 'text/calendar' } }),
    'https://church.example.org/sitemap.xml': () => new Response('<urlset/>', { headers: { 'Content-Type': 'application/xml' } }),
    'https://church.example.org/robots.txt': () => new Response('User-agent: *', { headers: { 'Content-Type': 'text/plain' } }),
    'https://church.example.org/feed': html('<p>a page</p>'),
  });
  for (const path of ['calendar.ics', 'sitemap.xml', 'robots.txt']) {
    const response = await builderFetchBridge(ask(`https://church.example.org/${path}`, 'feed'), net.fetcher);
    assert.equal(response.status, 200, path);
  }
  const page = await builderFetchBridge(ask('https://church.example.org/feed', 'feed'), net.fetcher);
  assert.equal(page.status, 415);
  const refused = await builderFetchBridge(ask('http://127.0.0.1/robots.txt', 'feed'), net.fetcher);
  assert.equal(refused.status, 403);
});

test('stylesheets are their own kind: a page or script is not a stylesheet', async () => {
  const net = internet({ 'cdn.example.org': ['93.184.216.34'] }, {
    'https://cdn.example.org/theme.css': () => new Response(':root{--brand:#123456}', { headers: { 'Content-Type': 'text/css; charset=utf-8' } }),
    'https://cdn.example.org/page': html('<p>a page</p>'),
    'https://cdn.example.org/app.js': () => new Response('alert(1)', { headers: { 'Content-Type': 'text/javascript' } }),
  });
  const css = await builderFetchBridge(ask('https://cdn.example.org/theme.css', 'css'), net.fetcher);
  assert.equal(css.status, 200);
  assert.equal(await css.text(), ':root{--brand:#123456}');
  for (const path of ['page', 'app.js'])
    assert.equal((await builderFetchBridge(ask(`https://cdn.example.org/${path}`, 'css'), net.fetcher)).status, 415, path);
  assert.equal((await builderFetchBridge(ask('http://10.0.0.1/theme.css', 'css'), net.fetcher)).status, 403);
});

test('a calendar the church asked to import: only derived feed addresses, at every redirect, up to 5 MB', async () => {
  const google = 'https://calendar.google.com/calendar/ical/fbc.schedule%40gmail.com/public/basic.ics';
  for (const url of [google, 'https://tockify.com/api/feeds/ics/gracechurch', 'https://grace.org/events/?ical=1',
    'https://outlook.office365.com/owa/calendar/abc@grace.org/def/calendar.ics', 'https://ics.teamup.com/feed/ksabc123/0.ics',
    'https://grace.org/files/calendar.ics'])
    assert.equal(isCalendarFeed(url), true, url);
  for (const url of ['https://grace.org/', 'https://calendar.google.com/calendar/embed?src=x@gmail.com', 'http://grace.org/c.ics',
    'https://evil.org/ical/x/public/basic.ics.html'])
    assert.equal(isCalendarFeed(url), false, url);
  const ics = 'BEGIN:VCALENDAR\r\n' + 'X'.repeat(1_500_000) + '\r\nEND:VCALENDAR\r\n';
  const net = internet({ 'calendar.google.com': ['142.250.1.1'], 'grace.org': ['93.184.216.34'] }, {
    [google]: () => new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } }),
    'https://grace.org/move.ics': () => new Response('', { status: 302, headers: { location: 'https://grace.org/about' } }),
  });
  const read = await builderFetchBridge(ask(google, 'calendar'), net.fetcher);
  assert.equal(read.status, 200);
  assert.ok((await read.arrayBuffer()).byteLength > 1_000_000); // past the 1 MB feed cap, within the calendar cap
  assert.equal((await builderFetchBridge(ask('https://grace.org/', 'calendar'), net.fetcher)).status, 403);
  // A redirect away from a calendar feed address is refused before it is fetched.
  assert.equal((await builderFetchBridge(ask('https://grace.org/move.ics', 'calendar'), net.fetcher)).status, 403);
  assert.ok(!net.fetched().includes('https://grace.org/about'));
});
