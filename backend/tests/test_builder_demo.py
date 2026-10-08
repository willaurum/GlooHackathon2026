"""What the demo shows: the progress feed, the fact check, time and cost, sites that only render in a browser,
the statement of faith going back to the pastor, changes asked in plain words, and where each fact came from."""
import os
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, builder_edit, builder_run, main
from backend.tests.test_builder import BuilderTestCase, site
from backend.tests.test_churches import ChurchTestCase

PAGES = {
    'index.html': '<html><head><title>Home | Cedar Church</title></head><body><nav><a href="/beliefs">What We Believe</a>'
                  '<a href="/ministries">Ministries</a></nav><p>Welcome to Cedar Church.</p>'
                  '<p>Sunday worship at 9:00 AM and 11:00 AM.</p><p>Call (555) 010-2000.</p></body></html>',
    'beliefs': '<html><head><title>What We Believe | Cedar Church</title></head><body><h1>What We Believe</h1>'
               '<p>We believe the Bible is the inspired word of God and that salvation is by grace through faith.</p></body></html>',
    'ministries': '<html><head><title>Ministries | Cedar Church</title></head><body><h1>Ministries</h1>'
                  '<p>Youth Ministry meets Wednesdays at 7 PM.</p><p>Food Pantry serves neighbors on Saturdays.</p></body></html>',
}


def pages(url):
    page = url.split('https://church.test/', 1)[1] or 'index.html'
    if page not in PAGES:
        raise FileNotFoundError(page)
    return url, 'text/html', PAGES[page]


def reader(messages, tools):
    """An AI that returns one real quote and two it made up, so the fact check has something to remove."""
    if tools[0]['function']['name'] != 'record_church_facts':
        return {'items': []}
    text = messages[1]['content']
    facts = [{'field': 'about', 'value': 'Made up', 'quote': 'A sentence that is not on the page.'},
             {'field': 'first_visit', 'value': 'Wear a tie', 'quote': 'Wear a tie to every service.'}]
    if 'inspired word of God' in text:
        facts.append({'field': 'about', 'value': 'They believe the Bible', 'quote': 'We believe the Bible is the inspired word of God'})
    if 'Welcome to Cedar Church' in text:
        facts.append({'field': 'about', 'value': 'Welcome to Cedar Church.', 'quote': 'Welcome to Cedar Church.'})
    return {'facts': facts}


class ProgressAndCheckTests(BuilderTestCase):
    def run_import(self, fetch=pages, complete=reader):
        run, token = builder_run.start()
        try:
            return run, builder.new_session('https://church.test/', fetch=fetch, complete=complete, describe=False)
        finally:
            builder_run.finish(token)

    def test_steps_fact_check_and_summary(self):
        run, session = self.run_import()
        texts = [step['text'] for step in session['run']['steps']]
        self.assertEqual(texts[0], 'Reading https://church.test/')
        self.assertIn('Read “Home” (home page)', texts)
        self.assertIn('Read “Ministries” (ministries)', texts)
        self.assertTrue(any(t.startswith('Checking facts… 6 unsupported claims removed') for t in texts), texts)
        self.assertTrue(texts[-1].startswith('Done: read 3 pages in '), texts[-1])
        self.assertEqual(session['run']['dropped_total'], 6)
        self.assertEqual(session['run']['dropped'], {'its quote is not on the page': 6})
        self.assertEqual(session['run']['pages'], 3)
        kinds = {step['kind'] for step in session['run']['steps']}
        self.assertIn('check', kinds)
        self.assertIn('done', kinds)

    def test_every_fact_kept_says_so(self):
        _, session = self.run_import(complete=lambda m, t: {'facts': []} if t[0]['function']['name'] == 'record_church_facts' else {'items': []})
        self.assertIn('Checking facts… every fact matched a quote on its page', [s['text'] for s in session['run']['steps']])

    def test_no_run_means_no_steps(self):
        session = builder.new_session('https://church.test/', fetch=pages, complete=reader, describe=False)
        self.assertNotIn('run', session)

    def test_specialist_drops_are_counted(self):
        source = {'id': 's1', 'kind': 'page', 'page_type': 'staff', 'url': 'https://church.test/staff', 'title': 'Staff',
                  'text': 'Pastor Ann Lee leads worship. Deacon Joe Park serves.', 'links': []}

        def complete(messages, tools):
            if tools[0]['function']['name'] == 'record_church_facts':
                return {'facts': []}
            return {'items': [
                {'name': 'Ann Lee', 'role': 'Pastor', 'quote': 'Pastor Ann Lee leads worship.'},
                {'name': 'Joe Park', 'role': 'Deacon', 'quote': 'Deacon Joe Park serves.'},
                {'name': 'Bob Ray', 'role': 'Elder', 'quote': 'Bob Ray is an elder.'},
                {'name': 'Cy Doe', 'role': 'Deacon', 'quote': 'Pastor Ann Lee leads worship.'}]}
        run, token = builder_run.start()
        try:
            _, items = builder.extract_all([source], complete)
        finally:
            builder_run.finish(token)
        self.assertEqual(len(items), 2)
        self.assertEqual(run.dropped, {'it did not match its page': 2})
        self.assertIn('Staff reader on “Staff”: 2 found', [step['text'] for step in run.steps])

    def test_past_events_are_skipped_not_counted(self):
        self.assertEqual(builder._specialist_drops('events', {'items': [{'name': 'Picnic', 'date': '2001-05-01'},
                                                                         {'name': 'Gala', 'date': 'soon'}]}, []), 1)
        self.assertEqual(builder._specialist_drops('staff', None, []), 0)


class CostTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(builder_run, '_prices', dict(builder_run.PRICES))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_cost_from_tokens_and_prices(self):
        run = builder_run.Run()
        run.ai('gloo-anthropic-claude-haiku-4.5', SimpleNamespace(prompt_tokens=20_000, completion_tokens=2_000))
        run.ai('gloo-anthropic-claude-haiku-4.5', None, failed=True)
        summary = run.summary(pages=12)
        self.assertEqual((summary['tokens_in'], summary['tokens_out'], summary['ai_calls'], summary['ai_failed']), (20000, 2000, 2, 1))
        self.assertAlmostEqual(summary['cost_usd'], 0.03)
        self.assertEqual(builder_run.money(summary['cost_usd']), '$0.03')

    def test_local_models_cost_nothing_and_unknown_models_are_unknown(self):
        run = builder_run.Run()
        run.ai('llama3.1:8b', SimpleNamespace(prompt_tokens=5000, completion_tokens=500))
        self.assertEqual(run.cost(), 0)
        self.assertEqual(builder_run.money(0), 'no AI cost')
        run.ai('gloo-some-new-model', SimpleNamespace(prompt_tokens=1, completion_tokens=1))
        self.assertIsNone(run.cost())
        self.assertEqual(builder_run.money(None), '')
        self.assertEqual(builder_run.money(0.004), 'under $0.01')

    def test_steps_are_bounded_and_keep_the_first(self):
        run = builder_run.Run()
        for i in range(builder_run.MAX_STEPS + 30):
            run.step(f'step {i}')
        self.assertEqual(len(run.steps), builder_run.MAX_STEPS)
        self.assertEqual(run.steps[0]['text'], 'step 0')
        self.assertEqual(run.steps[-1]['text'], f'step {builder_run.MAX_STEPS + 29}')


class BrowserOnlySiteTests(BuilderTestCase):
    def test_app_shell_pivots_to_questions(self):
        session = self.session('riverstone-js')
        self.assertTrue(session['js_rendered'])
        self.assertEqual(session['notes'], [builder.JS_SITE_NOTE])
        self.assertEqual(session['status'], 'clarifying')
        self.assertEqual({q['field'] for q in session['questions']}, set(builder.REQUIRED))
        self.assertEqual(session['url'], 'https://church.test/')

    def test_real_sites_are_not_app_shells(self):
        for name in ('harborlight-messy', 'cedar-hollow-static', 'snappage-like'):
            with self.subTest(name=name):
                self.assertFalse(builder.builds_in_browser(builder.crawl('https://church.test/', fetch=site(name))))


class QuoteContextTests(unittest.TestCase):
    def test_context_stays_on_the_lines_next_to_the_quote(self):
        # Cedar Hollow's visit block; Chrome matches "Youth Group-," here but not "AM Youth Group-,".
        text = 'Sunday School\n10:30 AM\n\nYouth Group\nSundays, 6:00 PM\nFind Us\n412 Orchard Lane'
        self.assertEqual(builder.quote_context(text, 'Sundays, 6:00 PM'), {'prefix': 'Youth Group', 'suffix': 'Find Us'})
        self.assertEqual(builder.quote_context('Join us Sundays at 9 for worship and coffee.', 'Sundays at 9'),
                         {'prefix': 'Join us', 'suffix': 'for worship and'})
        self.assertEqual(builder.quote_context('Sundays\n  at   9', 'Sundays at 9'), {})
        self.assertEqual(builder.quote_context('Hi', 'missing'), {})


class BeliefsTests(BuilderTestCase):
    def test_beliefs_go_to_the_pastor_word_for_word(self):
        session = builder.new_session('https://church.test/', fetch=pages, complete=reader, describe=False)
        beliefs = session['beliefs']
        self.assertEqual(beliefs['status'], 'needs_pastor')
        self.assertFalse(beliefs['confirmed'])
        page = next(p for p in session['site']['pages'] if p['id'] in beliefs['page_ids'])
        self.assertFalse(page['include'])
        self.assertEqual(session['notes'], [])
        run, token = builder_run.start()
        try:
            builder.new_session('https://church.test/', fetch=pages, complete=reader, describe=False)
        finally:
            builder_run.finish(token)
        self.assertTrue(any('go to your pastor' in step['text'] for step in run.snapshot()['steps']))
        # The AI's summary of the beliefs page is not used as the church's About text.
        self.assertNotIn('They believe the Bible', [c['value'] for c in session['claims']])
        builder.confirm_beliefs(session, True)
        self.assertTrue(page['include'])
        builder.confirm_beliefs(session, False)
        self.assertFalse(page['include'])

    def test_no_beliefs_page(self):
        session = self.session('harborlight-messy')
        self.assertEqual(session['beliefs'], {'status': 'missing'})
        with self.assertRaises(ValueError):
            builder.confirm_beliefs(session, True)

    def one_page(self, beliefs):
        html = ('<html><head><title>Cedar Hollow Church</title></head><body><nav><a href="#about">About</a>'
                '<a href="#beliefs">Beliefs</a></nav><section id="about"><h2>About Us</h2><p>We are a small church in '
                'Millbrook that loves our neighbors and gathers every Sunday morning.</p></section>'
                f'<section id="beliefs"><h2>What We Believe</h2><p>{beliefs}</p></section></body></html>')
        return builder.new_session('https://church.test/', fetch=lambda url: (url, 'text/html', html),
                                   complete=lambda m, t: None, describe=False)

    def test_a_placeholder_beliefs_section_is_a_question_for_the_pastor(self):
        session = self.one_page('This page is under construction. Please check back soon!')
        self.assertEqual(session['beliefs'], {'status': 'missing', 'placeholder': True})
        self.assertIn(builder.BELIEFS_PLACEHOLDER_NOTE, session['notes'])
        headings = [s['heading'] for p in session['site']['pages'] for s in p.get('sections', [])]
        self.assertNotIn('What We Believe', headings)
        self.assertEqual(len(session['site']['pages']), 1)

    def test_a_beliefs_section_becomes_a_held_page(self):
        session = self.one_page('We believe in one God, Father, Son and Holy Spirit, and that Scripture is true.')
        self.assertEqual(session['beliefs']['status'], 'needs_pastor')
        home, beliefs = session['site']['pages']
        self.assertNotIn('What We Believe', [s['heading'] for s in home['sections']])
        self.assertEqual((beliefs['id'], beliefs['title'], beliefs['include']), ('beliefs', 'What We Believe', False))
        builder.confirm_beliefs(session, True)
        self.assertTrue(beliefs['include'])


class EditTests(unittest.TestCase):
    def draft(self):
        session = builder.session_from_sources(None, [])
        for field, value in [('name', 'Cedar Church'), ('phone', '5550102000'), ('services', 'Sundays 9 and 11'),
                             ('address', '1 Main St, Cedar, VA'), ('email', 'hi@cedar.test')]:
            builder.apply_answer(session, field, value)
        session['collections'] = {'ministries': [
            {'id': 'i1', 'value': {'name': 'Youth Ministry'}, 'include': True, 'evidence': []},
            {'id': 'i2', 'value': {'name': 'Food Pantry'}, 'include': True, 'evidence': []}]}
        return session

    def test_rules_read_the_common_requests(self):
        cases = {
            'Put service times above ministries': [{'op': 'move', 'page': 'home', 'section': 'service_times', 'before': 'ministries'}],
            'move the FAQs below the campuses on the visit page.': [{'op': 'move', 'page': 'visit', 'section': 'faqs', 'after': 'locations'}],
            'Put sermons at the top': [{'op': 'move', 'page': 'home', 'section': 'sermons', 'to': 'top'}],
            'Hide the leaders section': [{'op': 'hide', 'page': 'home', 'section': 'leaders'}],
            'Hide the youth ministry': [{'op': 'exclude', 'collection': 'ministries', 'name': 'youth'}],
            'Change the phone number to (434) 555-0100': [{'op': 'set_field', 'field': 'phone', 'value': '(434) 555-0100'}],
        }
        for request, ops in cases.items():
            with self.subTest(request=request):
                self.assertEqual(builder_edit.rule_ops(request), ops)
        self.assertIsNone(builder_edit.rule_ops('Make the homepage feel more traditional'))

    def test_move_hide_change_and_undo(self):
        session = self.draft()
        changes = builder.apply_edit(session, builder_edit.rule_ops('Put service times above ministries'))
        self.assertEqual(changes, ['Moved Service times on Home above Ministries'])
        home = session['layout']['home']
        self.assertLess(home.index('service_times'), home.index('ministries'))
        content = builder.build_content(session)
        self.assertEqual(content['site']['layout']['home'], home)
        self.assertEqual(builder.apply_edit(session, builder_edit.rule_ops('Hide the youth ministry')), ['Left out Youth Ministry'])
        self.assertFalse(session['collections']['ministries'][0]['include'])
        builder.apply_edit(session, builder_edit.rule_ops('change the phone number to 434-555-0100'))
        self.assertEqual(session['fields']['phone']['value'], '4345550100')
        self.assertEqual(builder.undo_edit(session), 'Changed phone to 434-555-0100')
        self.assertEqual(session['fields']['phone']['value'], '5550102000')
        builder.undo_edit(session)
        self.assertTrue(session['collections']['ministries'][0]['include'])
        builder.undo_edit(session)
        self.assertEqual(session['layout']['home'], builder_edit.default_layout()['home'])
        self.assertNotIn('site', builder.build_content(session))
        with self.assertRaises(ValueError):
            builder.undo_edit(session)

    def test_ai_operations_are_checked_by_code(self):
        session = self.draft()
        calls = []

        def complete(messages, tools):
            calls.append(messages)
            return {'reply': 'Done.', 'operations': [
                {'op': 'move', 'page': 'home', 'section': 'service_times', 'to': 'top'},
                {'op': 'move', 'page': 'home', 'section': 'banner', 'to': 'top'},       # no such section
                {'op': 'exclude', 'collection': 'ministries', 'name': 'Choir'},          # no such entry
                {'op': 'write_html', 'value': '<script>'},                               # not an operation
                {'op': 'set_field', 'field': 'about', 'value': 'A warm church.'}]}
        ops, reply = builder_edit.ai_ops(session, 'Lead with our times and say we are warm', complete, builder.FIELD_LABELS)
        self.assertIn('Food Pantry', calls[0][1]['content'])
        changes = builder.apply_edit(session, ops)
        self.assertEqual(changes, ['Moved Service times on Home to the top', 'Changed about to A warm church.'])
        self.assertEqual(reply, 'Done.')
        with self.assertRaises(ValueError):
            builder.apply_edit(session, [{'op': 'hide', 'page': 'home', 'section': 'nope'}])

    def test_layout_is_cleaned(self):
        layout = builder_edit.clean_layout({'home': ['leaders', 'leaders', 'bogus'], 'hidden': ['home:about', 'x:y', 'visit:map']})
        self.assertEqual(layout['home'][0], 'leaders')
        self.assertEqual(sorted(layout['home']), sorted(builder_edit.PAGES['home']))
        self.assertEqual(layout['hidden'], ['home:about', 'visit:map'])


class RouteTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        builder.import_limiter.reset()
        self.addCleanup(builder.import_limiter.reset)
        for patcher in (mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1', 'BUILDER_AI': '0'}),
                        mock.patch.object(builder, '_http_fetch', pages),
                        mock.patch.object(builder, '_http_feed', mock.Mock(side_effect=FileNotFoundError)),
                        mock.patch.object(builder, '_http_css', mock.Mock(side_effect=FileNotFoundError)),
                        mock.patch.object(builder, '_ai_complete', None),
                        mock.patch.object(builder, '_ai_describe', None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def imported(self):
        r = self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'})
        self.assertEqual(r.status_code, 202, r.text)
        self.assertEqual(r.json()['progress']['steps'], [])
        builder.wait_for_imports()
        return self.client.get('/api/builder/drafts/' + r.json()['id']).json()

    def test_finished_import_keeps_its_run(self):
        draft = self.imported()
        self.assertTrue(draft['run']['steps'][-1]['text'].startswith('Done: read 3 pages'))
        self.assertIn('seconds', draft['run'])
        self.assertEqual(draft['beliefs']['status'], 'needs_pastor')

    def test_progress_is_saved_while_reading(self):
        saved = []
        real = builder._save

        def spy(session):
            if session.get('status') == 'importing' and session.get('progress', {}).get('steps'):
                saved.append(session['progress'])
            return real(session)
        with mock.patch.object(builder, '_save', spy), mock.patch.object(builder, 'PROGRESS_EVERY', 0.01), \
                mock.patch.object(builder, '_http_fetch', lambda url: (__import__('time').sleep(0.05), pages(url))[1]):
            self.imported()
        self.assertTrue(saved, 'no progress was saved while importing')
        self.assertEqual(saved[-1]['steps'][0]['text'], 'Reading https://church.test/')

    def test_edits_beliefs_and_provenance_routes(self):
        draft = self.imported()
        sid = draft['id']
        for field, value in [('name', 'Cedar Church'), ('address', '1 Main St, Cedar, VA'), ('email', 'hi@cedar.test')]:
            self.client.post(f'/api/builder/drafts/{sid}/answers', json={'field': field, 'value': value})
        r = self.client.post(f'/api/builder/drafts/{sid}/edits', json={'request': 'Put service times above ministries'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['method'], 'rules')
        self.assertEqual(r.json()['changes'], ['Moved Service times on Home above Ministries'])
        snapshot = self.client.get(f'/api/builder/drafts/{sid}/site').json()
        home = snapshot['church']['site']['layout']['home']
        self.assertLess(home.index('service_times'), home.index('ministries'))
        services = snapshot['provenance']['info']['services'][0]
        self.assertEqual(services['quote'], 'Sunday worship at 9:00 AM and 11:00 AM.')
        self.assertEqual(services['prefix'], 'to Cedar Church.')
        self.assertEqual(services['suffix'], 'Call (555) 010-2000.')
        self.assertEqual(snapshot['provenance']['info']['name'][0]['title'], 'You confirmed this')
        # Without an AI, a request the rules do not know gets a clear answer.
        r = self.client.post(f'/api/builder/drafts/{sid}/edits', json={'request': 'Make it feel more traditional'})
        self.assertEqual(r.status_code, 400)
        self.assertIn('Put service times above ministries', r.json()['detail'])
        r = self.client.post(f'/api/builder/drafts/{sid}/edits/undo')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['reply'], 'Undid: Moved Service times on Home above Ministries')
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/edits/undo').status_code, 400)
        # The beliefs page joins the site only once the pastor confirms it.
        slugs = lambda: [p['slug'] for p in self.client.get(f'/api/builder/drafts/{sid}/site').json()['pages']]  # noqa: E731
        self.assertNotIn('beliefs', slugs())
        r = self.client.post(f'/api/builder/drafts/{sid}/beliefs', json={'confirmed': True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()['beliefs']['confirmed'])
        self.assertIn('beliefs', slugs())


if __name__ == '__main__':
    unittest.main()
