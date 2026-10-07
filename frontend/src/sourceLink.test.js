import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceLink, factSources, fragmentPart, sourceLink } from './sourceLink.js';

test('the sources of a detail or a list entry on the preview', () => {
  const provenance = { info: { services: [{ url: 'https://church.test/', quote: 'Sundays at 9' }] },
    items: { ministries: { 'youth ministry': [{ url: 'https://church.test/m', quote: 'Youth Ministry meets' }] } } };
  assert.equal(factSources(provenance, { field: 'services' })[0].quote, 'Sundays at 9');
  assert.equal(factSources(provenance, { list: 'ministries', name: 'Youth  Ministry!' })[0].quote, 'Youth Ministry meets');
  assert.deepEqual(factSources(provenance, { list: 'staff', name: 'Ann' }), []);
  assert.deepEqual(factSources(null, { field: 'services' }), []);
});

const PAGE = 'https://gloo-hackathon-synthetic-church-sites.ebellis1.chatgpt.site/cedar-hollow-millbrook/';

test('a short quote with the words around it, like the Cedar Hollow example', () => {
  assert.equal(sourceLink(PAGE + '#visit', 'Sundays, 6:00 PM', { prefix: 'Youth Group', suffix: 'Find Us' }),
    PAGE + '#:~:text=Youth%20Group-,Sundays%2C%206%3A00%20PM,-Find%20Us');
  // Context from older drafts that crosses lines keeps only the line next to the quote (checked in Chrome).
  assert.equal(sourceLink(PAGE, 'Sundays, 6:00 PM', { prefix: '10:30 AM\n\nYouth Group', suffix: 'Find Us\n412 Orchard' }),
    PAGE + '#:~:text=Youth%20Group-,Sundays%2C%206%3A00%20PM,-Find%20Us');
});

test('the characters a text directive uses are encoded', () => {
  assert.equal(fragmentPart('9-11 & more, too'), '9%2D11%20%26%20more%2C%20too');
  assert.equal(sourceLink('https://church.test/a-b', 'Kids & youth - all ages'),
    'https://church.test/a-b#:~:text=Kids%20%26%20youth%20%2D%20all%20ages');
});

test('whitespace is collapsed and a long quote becomes its first and last words', () => {
  assert.equal(sourceLink('https://church.test/', '  Sunday\n\n worship   at 9 '), 'https://church.test/#:~:text=Sunday%20worship%20at%209');
  const long = 'We are a small, friendly congregation in downtown Corvallen. Come worship with us on Sundays at nine and eleven in the morning.';
  assert.equal(sourceLink('https://church.test/', long),
    'https://church.test/#:~:text=We%20are%20a%20small%2C%20friendly,and%20eleven%20in%20the%20morning.');
  const multi = 'Office hours\nMonday to Thursday\n9 to 4';
  assert.equal(sourceLink('https://church.test/', multi), 'https://church.test/#:~:text=Office%20hours%20Monday%20to%20Thursday%209%20to%204');
});

test('only a few words of context, and no link for unsafe or missing addresses', () => {
  assert.equal(sourceLink('https://church.test/', 'Hi', { prefix: 'one two three four five', suffix: 'six seven eight nine' }),
    'https://church.test/#:~:text=three%20four%20five-,Hi,-six%20seven%20eight');
  assert.equal(sourceLink('javascript:alert(1)', 'Hi'), '');
  assert.equal(sourceLink('', 'Hi'), '');
  assert.equal(sourceLink('https://church.test/page#old', ''), 'https://church.test/page');
  assert.equal(evidenceLink({ url: 'https://church.test/', quote: 'Hi', suffix: 'there' }), 'https://church.test/#:~:text=Hi,-there');
  assert.equal(evidenceLink(null), '');
});
