import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costText, factCheck, feedSteps, runSummary } from './builder.js';
import { orderedSections } from './churchSite.js';

test('run summary, cost and the fact check in words', () => {
  assert.equal(runSummary(null), '');
  assert.equal(runSummary({ pages: 12, seconds: 40.6, cost_usd: 0.0312 }), 'Read 12 pages in 41s, about $0.03');
  assert.equal(runSummary({ pages: 1, seconds: 3, cost_usd: null }), 'Read 1 page in 3s');
  assert.equal(runSummary({ pages: 3, seconds: 3, cost_usd: 0 }), 'Read 3 pages in 3s');
  assert.equal(runSummary({ pages: 0, sources: 2, seconds: 9, cost_usd: 0.004 }), 'Read 2 files in 9s, about under $0.01');
  assert.equal(costText(0), 'no AI cost');
  assert.equal(costText(undefined), '');
  assert.deepEqual(factCheck({ dropped_total: 3, dropped: { 'its quote is not on the page': 1, 'it did not match its page': 2 } }),
    { total: 3, line: '3 unsupported claims removed', reasons: ['2 because it did not match its page', '1 because its quote is not on the page'] });
  assert.equal(factCheck({ dropped_total: 1, dropped: {} }).line, '1 unsupported claim removed');
  assert.equal(factCheck({ dropped_total: 0 }).line, 'Every fact matched a quote on its page');
  assert.equal(factCheck(null), null);
});

test('the feed keeps the first step and the newest ones', () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({ text: 'step ' + i }));
  assert.deepEqual(feedSteps(steps, 5).map(s => s.text), ['step 0', 'step 26', 'step 27', 'step 28', 'step 29']);
  assert.deepEqual(feedSteps(undefined), []);
});

test('sections follow the stored layout, then any it does not name, without hidden ones', () => {
  const defaults = ['features', 'about', 'ministries', 'sermons', 'service_times', 'leaders'];
  assert.deepEqual(orderedSections(null, 'home', defaults), defaults);
  const layout = { home: ['service_times', 'features', 'about', 'ministries', 'sermons', 'leaders', 'bogus'], hidden: ['home:leaders', 'visit:map'] };
  assert.deepEqual(orderedSections(layout, 'home', defaults), ['service_times', 'features', 'about', 'ministries', 'sermons']);
  assert.deepEqual(orderedSections({ home: ['sermons'] }, 'home', defaults), ['sermons', 'features', 'about', 'ministries', 'service_times', 'leaders']);
  assert.deepEqual(orderedSections(layout, 'visit', ['service_times', 'map']), ['service_times']);
});
