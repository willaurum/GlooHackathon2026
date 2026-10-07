import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAGE_ROUTE, embedSrc, pageRoute, paragraphs, safeHref, siteMenu } from './site.js';

test('only http(s) addresses are used', () => {
  assert.equal(safeHref('https://church.test/a'), 'https://church.test/a');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '/relative', '', null, 'JaVaScRiPt:alert(1)'])
    assert.equal(safeHref(bad), '', String(bad));
});

test('players from known hosts embed; everything else is a link', () => {
  assert.equal(embedSrc('https://www.youtube.com/watch?v=HPmsg000001'), 'https://www.youtube-nocookie.com/embed/HPmsg000001');
  assert.equal(embedSrc('https://youtu.be/HPmsg000001'), 'https://www.youtube-nocookie.com/embed/HPmsg000001');
  assert.equal(embedSrc('https://vimeo.com/123456'), 'https://player.vimeo.com/video/123456');
  assert.equal(embedSrc('https://player.castr.com/live_1'), 'https://player.castr.com/live_1');
  assert.equal(embedSrc('https://subsplash.com/u/-X/give?embed=true'), 'https://subsplash.com/u/-X/give?embed=true');
  assert.equal(embedSrc('https://www.google.com/maps/embed?pb=1'), 'https://www.google.com/maps/embed?pb=1');
  for (const other of ['https://www.youtube.com/@church', 'https://evil.example/embed', 'http://player.castr.com/live_1',
    'https://www.google.com/search?q=x', 'https://youtube.com.evil.example/embed/HPmsg000001', 'javascript:alert(1)'])
    assert.equal(embedSrc(other), '', other);
});

test('the imported menu links pages, other sites and submenus', () => {
  const site = { navigation: { main: [
    { label: 'Home', page: 'home', url: '', children: [] },
    { label: 'About', page: '', url: '', children: [
      { label: 'Our Team', page: 'team', url: '', children: [] },
      { label: 'Gone', page: 'deleted', url: '', children: [] }] },
    { label: 'Groups', page: '', url: 'https://x.churchcenter.com/groups', children: [] },
    { label: 'Bad', page: '', url: 'javascript:alert(1)', children: [] },
    { label: 'Empty', page: '', url: '', children: [] }] } };
  assert.deepEqual(siteMenu(site, [{ slug: 'home' }, { slug: 'team' }]), [
    { label: 'Home', route: 'p/home', children: [] },
    { label: 'About', children: [{ label: 'Our Team', route: 'p/team', children: [] }] },
    { label: 'Groups', href: 'https://x.churchcenter.com/groups', children: [] }]);
  assert.deepEqual(siteMenu(null, []), []);
});

test('page routes and paragraphs', () => {
  assert.equal(pageRoute('team'), 'p/team');
  assert.ok(PAGE_ROUTE.test('p/blog-2030-08-01'));
  for (const bad of ['p/', 'p/Team', 'p/-x', 'p/a/b', 'p/../x']) assert.ok(!PAGE_ROUTE.test(bad), bad);
  assert.deepEqual(paragraphs('One\n\n Two \n'), ['One', 'Two']);
});
