import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HTML_ERROR, INFO_DEFAULTS, MAX_OPS, acceptOp, addOp, applyOps, checkOp, cleanText, describeChanges, newOpId, OP_ID,
  contrast, nearestReadable, parsePath, publicSite, readPath, readableOnWhite, removeOp, settle, styleVariables } from './siteDraft.js';

const published = () => ({
  info: { name: 'Hope Chapel', tagline: 'Old headline', about: 'About us', first_visit: '', services: [] },
  faqs: [{ id: 0, question: 'Is there parking?', answer: 'Yes.' }],
  staff: [{ id: 3, name: 'Sam Lee', role: 'Pastor', bio: '' }],
  pages: [{ id: 0, slug: 'about-us', title: 'About us', page_type: 'about', source_url: '', sections: [{ heading: 'Welcome', level: 2, text: 'Hi', links: [], embeds: [] }] }],
  ministries: [{ id: 2, name: 'Kids', shifts: [{ id: '2-1', filled: 1, total: 3 }, { id: '2-2', filled: 2, total: 2 }] }, { id: 1, name: 'Music' }],
  calendar: [{ id: 5, title: 'Picnic', date: '2026-06-02', time: '12:00', secret: 'x' }, { id: 4, title: 'Prayer', date: '2026-06-01', time: '' }],
  site: { theme: { primary: '#2d5c9e', text: '#222222' }, assets: [{ url: 'https://a.example/1.jpg', rights: true }, { url: 'https://a.example/2.jpg', rights: false }] },
});
let n = 0;
const op = (fields, extra = {}) => ({ id: 'op' + (++n), source: 'staff', pending: false, ...fields, ...extra });

test('text is cleaned like the server does', () => {
  assert.deepEqual(cleanText('  Hello \t  there\r\n friend  '), { value: 'Hello there friend' });
  assert.deepEqual(cleanText('One  \r\n\r\n\r\n\r\nTwo\u0007 \n  three  ', { multiline: true }), { value: 'One\n\nTwo\n  three' });
  assert.deepEqual(cleanText('Use <b>bold</b>'), { error: HTML_ERROR });
  assert.deepEqual(cleanText('Ages 3 < 5 and 9 > 6'), { value: 'Ages 3 < 5 and 9 > 6' });
  assert.deepEqual(cleanText('a < b and c > d'), { error: HTML_ERROR });
  assert.equal(cleanText('x'.repeat(11), { max: 10 }).error, 'Keep this under 10 characters.');
  assert.ok(cleanText('   ', { required: true }).error);
  assert.ok(cleanText(5).error);
});

test('paths name only the allowed fields; reading gives copy defaults', () => {
  const content = published();
  assert.equal(parsePath('info.name'), null);
  assert.equal(parsePath('info.address'), null);
  assert.equal(parsePath('copy.nope'), null);
  assert.equal(parsePath('staff.3.email'), null);
  assert.equal(parsePath('copy.home.leaders_text').multiline, true);
  assert.equal(readPath(content, 'info.tagline'), 'Old headline');
  assert.equal(readPath(content, 'copy.home.serve_title'), 'Serve');
  assert.equal(readPath(content, 'copy.header.about.text'), 'The story, the people and the heart behind Hope Chapel.');
  assert.equal(readPath(content, 'pages.about-us.sections.0.heading'), 'Welcome');
  assert.equal(readPath(content, 'pages.about-us.sections.4.heading'), undefined);
  assert.equal(readPath(content, 'staff.3.bio'), '');
  assert.equal(readPath(content, 'staff.9.name'), undefined);
  assert.equal(readPath(content, 'faqs.0.answer'), 'Yes.');
});

test('ops are checked for the editor', () => {
  const content = published();
  assert.equal(checkOp(content, op({ op: 'set_text', path: 'info.name', value: 'X' })).error, 'That text cannot be changed here.');
  assert.equal(checkOp(content, op({ op: 'set_text', path: 'info.tagline', value: '<script>' })).error, HTML_ERROR);
  assert.equal(checkOp(content, op({ op: 'set_text', path: 'staff.3.name', value: ' ' })).error, 'This cannot be empty.');
  assert.equal(checkOp(content, op({ op: 'set_text', path: 'faqs.7.question', value: 'Q?' })).stale, true);
  assert.equal(checkOp(content, op({ op: 'set_text', path: 'info.tagline', value: ' New  one ' })).op.value, 'New one');
  assert.equal(checkOp(content, op({ op: 'set_style', token: 'primary', value: '#FFEE00' })).op.value, readableOnWhite('#ffee00'));
  assert.ok(checkOp(content, op({ op: 'set_style', token: 'primary', value: '#ffffff' })).op);
  assert.match(checkOp(content, op({ op: 'set_style', token: 'background', value: '#333333' })).error, /light page background/);
  assert.match(checkOp(content, op({ op: 'set_style', token: 'text', value: '#eeeeee' })).error, /hard to read/);
  assert.equal(checkOp(content, op({ op: 'set_style', token: 'text', value: '' })).op.value, '');
  assert.equal(checkOp(content, op({ op: 'set_style', token: 'heading_font', value: 'Comic Sans' })).error, 'Pick one of the fonts in the list.');
  assert.ok(checkOp(content, op({ op: 'set_style', token: 'heading_font', value: 'Lora' })).op);
  assert.equal(checkOp(content, op({ op: 'set_style', token: 'heading_scale', value: 1.12 })).op.value, 1.1);
  assert.ok(checkOp(content, op({ op: 'set_style', token: 'heading_scale', value: 1.5 })).error);
  assert.ok(checkOp(content, op({ op: 'set_style', token: 'hero_scale', value: 0.7 })).op);
  assert.ok(checkOp(content, op({ op: 'move_section', page: 'home', section: 'leaders', before: 'map' })).error);
  assert.ok(checkOp(content, op({ op: 'move_section', page: 'home', section: 'leaders', to: 'middle' })).error);
  assert.ok(checkOp(content, op({ op: 'move_section', page: 'home', section: 'leaders', to: 'top' })).op);
  assert.ok(checkOp(content, op({ op: 'hide_section', page: 'visit', section: 'features' })).error);
  assert.ok(checkOp(content, op({ op: 'hide_page', page: 'guests/plan' })).error);
  assert.ok(checkOp(content, op({ op: 'hide_page', page: 'calendar' })).op);
});

test('a new change replaces an earlier one to the same text or style; suggestions never replace accepted ones', () => {
  const a = op({ op: 'set_text', path: 'info.tagline', value: 'A' });
  const b = op({ op: 'set_style', token: 'primary', value: '#2d5c9e' });
  const suggestion = op({ op: 'set_text', path: 'info.tagline', value: 'T', source: 'tekton', pending: true });
  let ops = addOp(addOp(addOp([], a), b), suggestion);
  assert.deepEqual(ops.map(o => o.id), [a.id, b.id, suggestion.id]);
  const a2 = op({ op: 'set_text', path: 'info.tagline', value: 'A2' });
  ops = addOp(ops, a2);
  assert.deepEqual(ops.map(o => o.id), [b.id, a2.id, suggestion.id]);
  const move = op({ op: 'move_section', page: 'home', section: 'leaders', to: 'top' });
  ops = addOp(addOp(ops, move), { ...move, id: 'again' });
  assert.deepEqual(ops.map(o => o.id), [b.id, a2.id, move.id, 'again', suggestion.id]);
  ops = acceptOp(ops, suggestion.id);
  assert.deepEqual(ops.map(o => o.id), [b.id, move.id, 'again', suggestion.id]);
  assert.equal(ops.at(-1).pending, false);
  assert.equal(ops.at(-1).source, 'tekton');
  assert.deepEqual(removeOp(ops, b.id).map(o => o.id), [move.id, 'again', suggestion.id]);
  assert.equal(MAX_OPS, 80);
});

test('applyOps applies every kind of op and reports stale ones', () => {
  const live = published();
  const ops = [
    op({ op: 'set_text', path: 'info.tagline', value: 'New headline' }),
    op({ op: 'set_text', path: 'copy.home.serve_title', value: 'Volunteer' }),
    op({ op: 'set_text', path: 'pages.about-us.sections.0.text', value: 'Hello\n\nthere' }),
    op({ op: 'set_text', path: 'staff.3.role', value: 'Lead pastor' }),
    op({ op: 'set_text', path: 'faqs.0.answer', value: 'Plenty.' }),
    op({ op: 'set_text', path: 'staff.8.name', value: 'Gone' }),
    op({ op: 'set_style', token: 'heading_font', value: 'Lora' }),
    op({ op: 'set_style', token: 'hero_scale', value: 1.2 }),
    op({ op: 'move_section', page: 'home', section: 'leaders', after: 'features' }),
    op({ op: 'hide_section', page: 'visit', section: 'map' }),
    op({ op: 'hide_page', page: 'calendar' }),
    op({ op: 'set_text', path: 'info.about', value: 'Suggested', source: 'tekton', pending: true }),
  ];
  const { content, stale } = applyOps(live, ops, { pending: true });
  assert.equal(content.info.tagline, 'New headline');
  assert.deepEqual(content.site.copy, { 'home.serve_title': 'Volunteer' });
  assert.equal(content.pages[0].sections[0].text, 'Hello\n\nthere');
  assert.equal(content.staff[0].role, 'Lead pastor');
  assert.equal(content.faqs[0].answer, 'Plenty.');
  assert.equal(content.site.theme.heading_font, 'Lora');
  assert.equal(content.site.theme.primary, '#2d5c9e');
  assert.deepEqual(content.site.style, { hero_scale: 1.2 });
  assert.deepEqual(content.site.layout.home, ['features', 'leaders', 'about', 'ministries', 'sermons', 'service_times']);
  assert.deepEqual(content.site.layout.hidden, ['visit:map']);
  assert.deepEqual(content.site.layout.hidden_pages, ['calendar']);
  assert.equal(content.info.about, 'Suggested');
  assert.deepEqual(stale, [ops[5].id]);
  // The live content is untouched, and suggestions can be left out.
  assert.equal(live.info.tagline, 'Old headline');
  assert.equal(applyOps(live, ops, { pending: false }).content.info.about, 'About us');
  // A copy key set back to "" goes back to the default; a size of 1 removes the setting; show undoes hide.
  const reset = applyOps(content, [op({ op: 'set_text', path: 'copy.home.serve_title', value: '' }),
    op({ op: 'set_style', token: 'hero_scale', value: 1 }), op({ op: 'show_section', page: 'visit', section: 'map' }),
    op({ op: 'show_page', page: 'calendar' }), op({ op: 'move_section', page: 'home', section: 'leaders', to: 'bottom' })]).content;
  assert.deepEqual(reset.site.copy, {});
  assert.deepEqual(reset.site.style, {});
  assert.deepEqual(reset.site.layout.hidden, []);
  assert.deepEqual(reset.site.layout.hidden_pages, []);
  assert.equal(reset.site.layout.home.at(-1), 'leaders');
});

test('describeChanges lists each change with before and after', () => {
  const live = published();
  const ops = [
    op({ op: 'set_text', path: 'copy.home.leaders_title', value: 'Leaders' }),
    op({ op: 'set_text', path: 'copy.footer.tagline', value: '' }),
    op({ op: 'set_text', path: 'staff.3.name', value: 'Sam K. Lee' }),
    op({ op: 'set_style', token: 'heading_scale', value: 0.9 }),
    op({ op: 'set_style', token: 'primary', value: '' }),
    op({ op: 'move_section', page: 'home', section: 'service_times', before: 'sermons' }),
    op({ op: 'hide_section', page: 'home', section: 'service_times' }),
    op({ op: 'hide_page', page: 'calendar' }),
    op({ op: 'set_text', path: 'faqs.9.answer', value: 'x' }),
    op({ op: 'set_text', path: 'info.tagline', value: 'Hi', source: 'tekton', pending: true }),
  ];
  const changes = describeChanges(live, ops);
  assert.deepEqual(changes.map(c => c.id), ops.map(o => o.id));
  assert.deepEqual(changes[0], { id: ops[0].id, op: 'set_text', source: 'staff', pending: false, stale: false,
    label: 'Home: bottom section heading', before: 'A big church can still feel personal.', after: 'Leaders', path: 'copy.home.leaders_title' });
  assert.equal(changes[1].after, 'Helping people find their people.');
  assert.equal(changes[2].label, 'Directory: Sam Lee, name');
  assert.deepEqual([changes[3].before, changes[3].after], ['100%', '90%']);
  assert.deepEqual([changes[4].label, changes[4].before, changes[4].after], ['Main color', '#2d5c9e', 'Default']);
  assert.deepEqual([changes[5].label, changes[5].before, changes[5].after], ['Moved "Service times" on Home', 'Position 5 of 6', 'Position 4 of 6']);
  assert.deepEqual([changes[6].label, changes[6].before, changes[6].after], ['"Service times" on Home', 'Shown', 'Hidden']);
  assert.deepEqual([changes[7].label, changes[7].after], ['Calendar page', 'Hidden']);
  assert.equal(changes[8].stale, true);
  assert.deepEqual([changes[9].pending, changes[9].source, changes[9].before, changes[9].after], [true, 'tekton', 'Old headline', 'Hi']);
});

test('publicSite matches the public API responses', () => {
  const site = publicSite(published());
  assert.deepEqual(Object.keys(site), ['info', 'church', 'ministries', 'events', 'pages']);
  assert.deepEqual(Object.keys(site.church), ['info', 'faqs', 'events', 'groups', 'staff', 'locations', 'sermons', 'site', 'pages']);
  assert.deepEqual(site.church.site.assets, [{ url: 'https://a.example/1.jpg', rights: true }]);
  assert.deepEqual(site.church.pages, [{ id: 0, slug: 'about-us', title: 'About us', page_type: 'about', source_url: '' }]);
  assert.deepEqual(site.church.groups, []);
  assert.deepEqual(site.ministries.map(m => [m.id, m.filled, m.total]), [[1, undefined, undefined], [2, 3, 5]]);
  assert.deepEqual(site.events.map(e => e.id), [4, 5]);
  assert.deepEqual(Object.keys(site.events[0]), ['id', 'title', 'category', 'date', 'time', 'location', 'ministry_name', 'description', 'ai_summary']);
  assert.equal(site.events[0].category, null);
  assert.equal(site.pages[0].sections.length, 1);
  assert.equal(publicSite({ info: { name: 'X' }, site: {} }).church.site, null);
});

test('style variables only for sizes within bounds; op ids are valid', () => {
  assert.deepEqual(styleVariables({ heading_scale: 1.1, hero_scale: 0.8 }), { '--heading-scale': '1.1', '--hero-scale': '0.8' });
  assert.deepEqual(styleVariables({ heading_scale: 3, hero_scale: '1.2' }), {});
  assert.deepEqual(styleVariables(null), {});
  const ids = new Set(Array.from({ length: 50 }, newOpId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, OP_ID);
});

test('format characters and line separators are cleaned like the server does', () => {
  assert.deepEqual(cleanText('Come\u202e as\u202c you\u200b are\ufeff\u2066!\u2069\u00ad'), { value: 'Come as you are!' });
  assert.deepEqual(cleanText('One\u2028Two\u2029Three'), { value: 'One Two Three' });
  assert.deepEqual(cleanText('One\u2028Two\u2029\u2029Three\u200d', { multiline: true }), { value: 'One\nTwo\n\nThree' });
  assert.ok(cleanText('\u200b\u200e\u2060', { required: true }).error);
});

test('numbers in paths are written one way only', () => {
  for (const path of ['staff.01.name', 'staff.00.name', 'faqs.\u0661.question', 'faqs.\uff10.answer', 'pages.about-us.sections.01.text',
    'pages.about-us.sections.1000.heading', 'staff.1234567890.name', 'staff.3.name\n'])
    assert.equal(parsePath(path), null, JSON.stringify(path));
  assert.equal(parsePath('staff.10.name').id, '10');
  assert.equal(parsePath('pages.about-us.sections.999.heading').index, 999);
  assert.equal(parsePath('faqs.0.answer').field, 'answer');
});

test('hiding then showing a section, or putting anything back, leaves no change', () => {
  const content = published();
  const hide = op({ op: 'hide_section', page: 'home', section: 'about' });
  let ops = settle(content, addOp([], hide));
  assert.deepEqual(ops.map(o => o.id), [hide.id]);
  // Showing it again replaces the hide, and the show changes nothing, so the draft is empty.
  ops = settle(content, addOp(ops, op({ op: 'show_section', page: 'home', section: 'about' })));
  assert.deepEqual(ops, []);
  ops = settle(content, addOp(addOp([], op({ op: 'hide_page', page: 'calendar' })), op({ op: 'show_page', page: 'calendar' })));
  assert.deepEqual(ops, []);
  const down = op({ op: 'move_section', page: 'home', section: 'about', after: 'ministries' });
  ops = settle(content, addOp([], down));
  assert.equal(ops.length, 1);
  ops = settle(content, addOp(ops, op({ op: 'move_section', page: 'home', section: 'about', before: 'ministries' })));
  assert.deepEqual(ops, []);
  ops = settle(content, addOp(addOp([], op({ op: 'set_text', path: 'info.tagline', value: 'New' })), op({ op: 'set_text', path: 'info.tagline', value: 'Old headline' })));
  assert.deepEqual(ops, []);
  ops = settle(content, addOp([], op({ op: 'set_style', token: 'primary', value: '#2d5c9e' })));
  assert.deepEqual(ops, []);
  ops = settle(content, addOp([], op({ op: 'set_style', token: 'hero_scale', value: 1 })));
  assert.deepEqual(ops, []);
  // Tekton's suggestions wait for an answer, even one that changes nothing.
  const suggestion = op({ op: 'show_section', page: 'home', section: 'about' }, { pending: true, source: 'tekton' });
  assert.deepEqual(settle(content, [suggestion]), [suggestion]);
  // A real change stays.
  const real = op({ op: 'set_text', path: 'info.tagline', value: 'Come as you are' });
  assert.deepEqual(settle(content, [hide, real]).map(o => o.id), [hide.id, real.id]);
});

test('review shows the default text a visitor saw, not "Empty"', () => {
  const content = published();
  content.info.tagline = '';
  content.info.about = '';
  const [tagline, about, emptied, first] = describeChanges(content, [op({ op: 'set_text', path: 'info.tagline', value: 'Come as you are' }),
    op({ op: 'set_text', path: 'info.about', value: 'We love our town.' }), op({ op: 'set_text', path: 'info.tagline', value: '' }),
    op({ op: 'set_text', path: 'info.first_visit', value: 'Come early.' })]);
  assert.equal(tagline.before, INFO_DEFAULTS.tagline);
  assert.equal(INFO_DEFAULTS.tagline, 'A place to belong, grow and give.');
  assert.equal(about.before, INFO_DEFAULTS.about);
  assert.equal(emptied.after, INFO_DEFAULTS.tagline);
  assert.equal(first.before, '');  // first visit has no default
});

test('a button color darkened to stay readable says so', () => {
  const checked = checkOp(published(), op({ op: 'set_style', token: 'accent', value: '#ffff66' }));
  assert.notEqual(checked.op.value, '#ffff66');
  assert.match(checked.note, /too light for buttons with white text, so it was darkened to #[0-9a-f]{6}\./);
  assert.equal(checkOp(published(), op({ op: 'set_style', token: 'accent', value: '#1f3a5f' })).note, undefined);
});

test('a background or text color that would not read is refused with the nearest one that does', () => {
  const content = published();
  content.site.theme = { text: '#222222' };
  const dark = checkOp(content, op({ op: 'set_style', token: 'background', value: '#334455' }));
  assert.match(dark.error, /^Your site keeps a light page background so text stays readable\. The nearest readable shade is #[0-9a-f]{6}\.$/);
  assert.equal(dark.suggest, nearestReadable('background', '#334455', content.site.theme));
  assert.ok(checkOp(content, op({ op: 'set_style', token: 'background', value: dark.suggest })).op);
  const pale = checkOp(content, op({ op: 'set_style', token: 'text', value: '#eeeeee' }));
  assert.match(pale.error, /^That text color would be hard to read on your background\./);
  assert.ok(contrast(pale.suggest, '#ffffff') >= 4.5);
  assert.ok(checkOp(content, op({ op: 'set_style', token: 'text', value: pale.suggest })).op);
  // The same shades the server suggests (backend site_editor.nearest_readable).
  assert.equal(nearestReadable('background', '#334455', {}), '#ccd0d5');
  assert.equal(nearestReadable('text', '#f0f0f0', { background: '#fdf3e1' }), '#6c6c6c');
  assert.equal(checkOp(content, op({ op: 'set_style', token: 'background', value: '#FDF3E1' })).op.value, '#fdf3e1');
});
