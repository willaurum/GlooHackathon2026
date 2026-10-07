import assert from 'node:assert/strict';
import test from 'node:test';
import { directionsHref, footerLinks, givingLink, livestreamLink, nextSteps, pageOfType, signupLinks, siteLinks } from './churchSite.js';

const site = { links: [
  { kind: 'giving', url: 'https://tithe.ly/give?c=1', text: 'Give', provider: 'Tithe.ly' },
  { kind: 'giving', url: 'https://church.pushpay.com/g', text: 'Give now', provider: 'Pushpay', cta: true },
  { kind: 'giving', url: 'javascript:alert(1)', text: 'Bad', provider: 'Bad' },
  { kind: 'livestream', url: 'https://www.youtube.com/@church/live', text: 'Watch', provider: 'YouTube' },
  { kind: 'social', url: 'https://instagram.com/church', provider: 'Instagram' },
  { kind: 'social', url: 'https://instagram.com/church-kids', provider: 'Instagram' },
  { kind: 'social', url: 'https://facebook.com/church', provider: 'Facebook' },
  { kind: 'app', url: 'https://apps.apple.com/app/church', provider: 'App Store' },
  { kind: 'form', url: 'https://forms.gle/abc', text: 'Volunteer sign-up', provider: 'Google Forms' },
  { kind: 'form', url: 'https://forms.gle/abc', text: 'Same form again', provider: 'Google Forms' },
] };

test('links of a kind: safe, calls to action first, each address once', () => {
  assert.deepEqual(siteLinks(site, 'giving').map(l => l.label), ['Pushpay', 'Tithe.ly']);
  assert.equal(givingLink(site).url, 'https://church.pushpay.com/g');
  assert.equal(livestreamLink(site).label, 'YouTube');
  assert.equal(givingLink({}), null);
  assert.equal(livestreamLink(null), null);
  assert.deepEqual(signupLinks(site).map(l => l.label), ['Volunteer sign-up']);
});

test('footer links: one per provider, social then apps', () => {
  assert.deepEqual(footerLinks(site).map(l => l.label), ['Instagram', 'Facebook', 'App Store']);
});

test('the story and beliefs pages Tekton imported', () => {
  const pages = [{ slug: 'what-we-believe', title: 'What We Believe', page_type: 'about' },
    { slug: 'about-us', title: 'About Us', page_type: 'about' }, { slug: 'events', title: 'Events', page_type: 'events' }];
  assert.equal(pageOfType(pages, 'beliefs').slug, 'what-we-believe');
  assert.equal(pageOfType(pages, 'about').slug, 'about-us');
  assert.equal(pageOfType([pages[0]], 'about'), null);
  assert.equal(pageOfType(undefined, 'beliefs'), null);
});

test('next steps: tagged ones for the demo church, the first three otherwise', () => {
  const events = [{ name: 'A', audience: 'Men' }, { name: 'B', audience: '' }, { name: 'C', audience: 'Everyone' }, { name: 'D' }, { name: 'E' }];
  assert.deepEqual(nextSteps(events, true).map(e => e.name), ['C']);
  assert.deepEqual(nextSteps(events, false).map(e => e.name), ['A', 'B', 'C']);
  assert.equal(directionsHref('1 Main St, Lynchburg'), 'https://www.google.com/maps/dir/?api=1&destination=1%20Main%20St%2C%20Lynchburg');
});
