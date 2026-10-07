"""The agentic builder (builder.py): import, extract, clarify, answer, build.

Runs offline against two fictional church sites in fixtures/builder/ (copies of the synthetic sites):
harborlight-messy has conflicting service times and phones and no address or email; cedar-hollow-static is
complete and consistent. The AI step is replaced by a fake so the tests are deterministic.

    python -m unittest backend.tests.test_builder
"""
import os
import threading
import time
from datetime import datetime, timedelta, timezone
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, church_content, db, main
from backend.tests.test_churches import ChurchTestCase

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'builder'


def site(name):
    """A fetch() that serves one fixture site as https://church.test/."""
    def fetch(url):
        page = url.split('https://church.test/', 1)[1] or 'index.html'
        path = FIXTURES / name / page
        if not path.is_file():
            raise FileNotFoundError(page)
        return url, 'text/html; charset=utf-8', path.read_text(encoding='utf-8')
    return fetch


class BuilderTestCase(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'})
        patcher.start()
        self.addCleanup(patcher.stop)

    def session(self, name, complete=None):
        return builder.new_session('https://church.test/', fetch=site(name), complete=complete or (lambda m, t: None), describe=False)


class MessySiteTests(BuilderTestCase):
    def test_conflicting_service_times_show_each_source_and_quote(self):
        s = self.session('harborlight-messy')
        self.assertEqual(s['status'], 'clarifying')
        q = next(q for q in s['questions'] if q['field'] == 'services')
        self.assertEqual(q['kind'], 'conflict')
        shown = {c['display']: c['evidence'] for c in q['candidates']}
        self.assertEqual(set(shown), {'Sunday 9:00 AM, Sunday 11:00 AM', 'Sunday 10:30 AM'})
        home = shown['Sunday 9:00 AM, Sunday 11:00 AM'][0]
        self.assertTrue(home['url'].endswith('/') and 'Sundays 9 & 11' in home['quote'])
        news = shown['Sunday 10:30 AM'][0]
        self.assertTrue(news['url'].endswith('newsandevents.html') and '10:30am' in news['quote'])
        # Not confirmed until the church answers.
        self.assertIsNone(s['fields']['services']['value'])

    def test_conflicting_phones_and_missing_fields_become_questions(self):
        s = self.session('harborlight-messy')
        kinds = {q['field']: q['kind'] for q in s['questions']}
        self.assertEqual(kinds, {'phone': 'conflict', 'services': 'conflict', 'name': 'missing', 'address': 'missing', 'email': 'missing'})
        phones = {c['display'] for c in next(q for q in s['questions'] if q['field'] == 'phone')['candidates']}
        self.assertEqual(phones, {'(555) 019-4433', '(555) 019-4434'})

    def test_answers_confirm_and_build_valid_content(self):
        s = self.session('harborlight-messy')
        with self.assertRaises(ValueError):
            builder.build_content(s)  # open questions first
        for field, value in [('services', 'Sundays 9:00 AM and 11:00 AM'), ('phone', '(555) 019-4433'),
                             ('name', 'Harborlight Chapel'), ('address', '12 Water Street, Corvallen'),
                             ('email', 'Hello@Harborlight.example.org')]:
            builder.apply_answer(s, field, value)
        self.assertEqual(s['status'], 'review')
        self.assertEqual(s['fields']['services'], {**s['fields']['services'], 'status': 'confirmed',
                                                   'value': [{'day': 'Sunday', 'time': '09:00'}, {'day': 'Sunday', 'time': '11:00'}]})
        info = builder.build_content(s)['info']
        self.assertEqual(info['name'], 'Harborlight Chapel')
        self.assertEqual(info['phone'], '(555) 019-4433')
        self.assertEqual(info['email'], 'hello@harborlight.example.org')
        self.assertEqual([(x['day'], x['time']) for x in info['services']], [('Sunday', '9:00 AM'), ('Sunday', '11:00 AM')])

    def test_typed_service_times_keep_each_time_on_its_own_day(self):
        s = self.session('cedar-hollow-static')
        builder.apply_answer(s, 'services', 'Sunday 8:30 AM, Sunday 10:45 AM, Wednesday 7:00 PM')
        self.assertEqual(s['fields']['services']['value'], [{'day': 'Sunday', 'time': '08:30'}, {'day': 'Sunday', 'time': '10:45'},
                                                            {'day': 'Wednesday', 'time': '19:00'}])
        builder.apply_answer(s, 'services', 'Sun 9am; Weds 6:30pm')
        self.assertEqual(s['fields']['services']['value'], [{'day': 'Sunday', 'time': '09:00'}, {'day': 'Wednesday', 'time': '18:30'}])

    def test_bad_answers_are_refused(self):
        s = self.session('harborlight-messy')
        for field, value in [('phone', '555-12'), ('email', 'not an email'), ('services', 'whenever'), ('nope', 'x')]:
            with self.assertRaises(ValueError, msg=field):
                builder.apply_answer(s, field, value)


class CleanSiteTests(BuilderTestCase):
    def test_complete_site_is_prefilled_with_no_questions(self):
        s = self.session('cedar-hollow-static')
        self.assertEqual(s['status'], 'review')
        self.assertEqual(s['questions'], [])
        value = {f: v['value'] for f, v in s['fields'].items()}
        self.assertEqual(value['name'], 'Cedar Hollow Community Church')
        self.assertEqual(value['address'], '418 Quillmore Lane, Thistlemere, OH')
        self.assertEqual(value['phone'], '5550142290')
        # The church's address, not the staff addresses that only appear on the About page.
        self.assertEqual(value['email'], 'hello@cedarhollow.example.org')
        self.assertEqual(value['services'], [{'day': 'Sunday', 'time': '08:30'}, {'day': 'Sunday', 'time': '10:45'},
                                             {'day': 'Wednesday', 'time': '19:00'}])

    def test_same_page_under_two_addresses_is_read_once(self):
        s = self.session('cedar-hollow-static')
        self.assertEqual(len({x['text'] for x in s['sources']}), len(s['sources']))


class AiGroundingTests(BuilderTestCase):
    def test_ai_claims_without_a_real_quote_are_dropped(self):
        def fake_ai(messages, tools):
            page = messages[1]['content']
            if 'Our History' not in page:
                return {'facts': []}
            return {'facts': [
                {'field': 'name', 'value': 'Harborlight Fellowship', 'quote': 'Harborlight Fellowship was started'},
                {'field': 'about', 'value': 'Founded by fishing families in 1952.', 'quote': 'started by a handful of fishing families in 1952'},
                {'field': 'office_hours', 'value': 'Mon-Fri 9-5', 'quote': 'Office hours are Monday to Friday 9 to 5'},  # not on the page
                {'field': 'faq', 'value': 'When is communion? || The first Sunday of every month.', 'quote': 'Communion is the first Sunday of every month.'},
            ]}
        s = self.session('harborlight-messy', complete=fake_ai)
        ai = [c for c in s['claims'] if c['method'] == 'ai']
        self.assertEqual({c['field'] for c in ai}, {'name', 'about', 'faq'})
        self.assertNotIn('office_hours', s['fields'])
        self.assertEqual(s['fields']['name']['value'], 'Harborlight Fellowship')
        self.assertNotIn('name', {q['field'] for q in s['questions']})

    def test_a_failing_ai_leaves_the_pattern_results(self):
        def broken(messages, tools):
            raise RuntimeError('model offline')
        s = self.session('cedar-hollow-static', complete=broken)
        self.assertEqual(s['fields']['phone']['value'], '5550142290')


class ImageTests(BuilderTestCase):
    def test_a_bulletin_image_adds_its_service_time_as_a_third_source(self):
        bulletin = ('HARBOR LIGHT\nWeekly Bulletin ~ Summer Schedule\nONE service this summer: Sundays at 10 AM\n'
                    '(June through Labor Day; two services return in the fall)')
        described = []

        def describe(data, content_type):
            described.append(content_type)
            return bulletin
        s = builder.new_session('https://church.test/', fetch=site('harborlight-messy'), complete=lambda m, t: None,
                                fetch_bytes=lambda url: ('image/png', b'png'), describe=describe)
        self.assertEqual(described, ['image/png'])  # one image on the site, read once
        image = next(x for x in s['sources'] if x['kind'] == 'image')
        self.assertTrue(image['url'].endswith('images/bulletin.png'))
        q = next(q for q in s['questions'] if q['field'] == 'services')
        shown = {c['display']: c['evidence'] for c in q['candidates']}
        self.assertEqual(set(shown), {'Sunday 9:00 AM, Sunday 11:00 AM', 'Sunday 10:30 AM', 'Sunday 10:00 AM'})
        self.assertIn('Sundays at 10 AM', shown['Sunday 10:00 AM'][0]['quote'])
        self.assertEqual(shown['Sunday 10:00 AM'][0]['source_id'], image['id'])

    def test_without_a_vision_model_images_are_skipped(self):
        s = self.session('harborlight-messy')
        self.assertEqual([x for x in s['sources'] if x['kind'] == 'image'], [])


class BudgetTests(BuilderTestCase):
    def test_ai_calls_run_with_four_workers(self):
        sources = [{'id': f's{i}', 'url': f'https://church.test/{i}', 'text': f'Page {i}'} for i in range(4)]
        lock = threading.Lock()
        running, peak = 0, 0

        def complete(messages, tools):
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.3)
            with lock:
                running -= 1
            return {'facts': [{'field': 'about', 'value': 'A test page.', 'quote': messages[1]['content'].split('\n')[-1]}]}

        started = time.monotonic()
        claims = builder.extract(sources, complete)
        self.assertLess(time.monotonic() - started, 0.9)
        self.assertEqual(peak, 4)
        self.assertEqual([c['source_id'] for c in claims], [s['id'] for s in sources])

    def test_hung_ai_is_dropped_and_pattern_claims_remain(self):
        release, started, finished = threading.Event(), threading.Event(), threading.Event()

        def complete(messages, tools):
            if 'Page: https://church.test/\n' in messages[1]['content']:
                started.set()
                release.wait(2)
                finished.set()
                return {'facts': [{'field': 'about', 'value': 'Late result.', 'quote': 'Sundays 9 & 11'}]}
            quote = messages[1]['content'].split('\n\n', 1)[1].split('\n')[0]
            return {'facts': [{'field': 'about', 'value': quote, 'quote': quote}]}

        try:
            before = time.monotonic()
            with mock.patch.object(builder, 'IMPORT_BUDGET', 0.15):
                s = self.session('harborlight-messy', complete)
            self.assertLess(time.monotonic() - before, 0.5)
            self.assertTrue(started.is_set())
            self.assertTrue(any(c['method'] == 'pattern' and c['field'] == 'services' for c in s['claims']))
            self.assertEqual({c['source_id'] for c in s['claims'] if c['method'] == 'ai'},
                             {source['id'] for source in s['sources'][1:]})
            self.assertEqual(s['notes'], ['1 source was read without AI because it took too long.'])
        finally:
            release.set()
            self.assertTrue(finished.wait(1))
        self.assertFalse(any(c['value'] == 'Late result.' for c in s['claims']))

    def test_crawl_stops_at_its_budget_without_sleeping(self):
        now, fetched = [0.0], []

        def fetch(url):
            fetched.append(url)
            now[0] += 10
            links = ''.join(f'<a href="/{i}">Page {i}</a>' for i in range(1, 12))
            return url, 'text/html', f'<p>{url} Sundays 9 & 11</p>{links}'

        with mock.patch.object(builder, '_now', lambda: now[0]):
            s = builder.new_session('https://church.test/', fetch=fetch, complete=lambda m, t: None, describe=False)
        self.assertEqual(fetched, ['https://church.test/', 'https://church.test/1', 'https://church.test/2'])
        self.assertEqual(len(s['sources']), 3)
        self.assertEqual(s['notes'], ['Stopped reading after 3 of 12 pages to stay within the time limit.'])

    def test_total_budget_includes_time_spent_crawling(self):
        now, called = [0.0], []

        def fetch(url):
            now[0] = 0.5
            return url, 'text/html', '<p>Sundays 9 & 11</p><a href="/next">Next</a>'

        with mock.patch.object(builder, '_now', lambda: now[0]), mock.patch.object(builder, 'IMPORT_BUDGET', 0.5):
            s = builder.new_session('https://church.test/', fetch=fetch, complete=lambda m, t: called.append(m), describe=False)
        self.assertEqual(called, [])
        self.assertEqual(len(s['sources']), 1)
        self.assertTrue(s['claims'])
        self.assertEqual(len(s['notes']), 2)

    def test_images_are_concurrent_and_keep_source_order(self):
        barrier = threading.Barrier(4)
        sources = [{'id': 's1', 'url': 'https://church.test/', 'title': 'Test page',
                    'images': [f'https://church.test/{i}.png' for i in range(4)]}]

        def describe(data, content_type):
            barrier.wait(timeout=1)
            time.sleep((3 - int(data)) * 0.01)
            return f'Test bulletin {int(data)}: Sundays at 10 AM'

        out = builder.read_images(sources, fetch_bytes=lambda url: ('image/png', url.rsplit('/', 1)[1][0].encode()),
                                  describe=describe)
        self.assertEqual([s['url'] for s in out], sources[0]['images'])
        self.assertEqual([s['id'] for s in out], ['s2', 's3', 's4', 's5'])

    def test_hung_image_does_not_block_the_import(self):
        release, started, finished = threading.Event(), threading.Event(), threading.Event()

        def describe(data, content_type):
            started.set()
            release.wait(2)
            finished.set()
            return 'Late bulletin: Sundays at 10 AM'

        try:
            before = time.monotonic()
            with mock.patch.object(builder, 'IMPORT_BUDGET', 0.15):
                s = builder.new_session('https://church.test/', fetch=site('harborlight-messy'),
                                        complete=lambda m, t: None, fetch_bytes=lambda url: ('image/png', b'png'),
                                        describe=describe)
            self.assertLess(time.monotonic() - before, 0.5)
            self.assertTrue(started.is_set())
            self.assertTrue(s['claims'])
            self.assertFalse(any(x['kind'] == 'image' for x in s['sources']))
            self.assertIn('1 image was skipped because reading took too long.', s['notes'])
        finally:
            release.set()
            self.assertTrue(finished.wait(1))

    def test_hung_fetch_stops_the_crawl(self):
        release, finished = threading.Event(), threading.Event()
        fetched = []

        def fetch(url):
            fetched.append(url)
            if url.endswith('/next'):
                release.wait(2)
                finished.set()
            return url, 'text/html', '<p>Sundays 9 & 11</p><a href="/next">Next</a>'

        try:
            before = time.monotonic()
            with mock.patch.object(builder, 'CRAWL_BUDGET', 0.15):
                s = builder.new_session('https://church.test/', fetch=fetch, complete=lambda m, t: None, describe=False)
            self.assertLess(time.monotonic() - before, 0.5)
            self.assertEqual(len(s['sources']), 1)
            self.assertEqual(s['notes'], ['Stopped reading after 1 of 2 pages to stay within the time limit.'])
        finally:
            release.set()
            self.assertTrue(finished.wait(1))
        self.assertEqual(fetched, ['https://church.test/', 'https://church.test/next'])

    def test_fixture_claims_and_evidence_match_sequential_extraction(self):
        for name in ('harborlight-messy', 'cedar-hollow-static'):
            with self.subTest(name=name):
                sources = builder.crawl('https://church.test/', fetch=site(name))
                delays = {s['url']: (len(sources) - i) * 0.01 for i, s in enumerate(sources)}

                def complete(messages, tools):
                    url = messages[1]['content'].split('\n')[0].removeprefix('Page: ')
                    time.sleep(delays[url])
                    quote = messages[1]['content'].split('\n\n', 1)[1].split('\n')[0]
                    return {'facts': [{'field': 'about', 'value': quote, 'quote': quote}]}

                expected = []
                for source in sources:
                    expected += builder.pattern_claims(source) + builder.ai_claims(source, complete)
                for i, claim in enumerate(expected, 1):
                    claim['id'] = f'c{i}'
                s = self.session(name, complete)
                fields = builder.reconcile(expected, len(sources))
                self.assertEqual(s['claims'], expected)
                self.assertEqual(s['fields'], fields)
                self.assertEqual(s['questions'], builder.questions(fields, expected, sources))
                self.assertEqual(s['notes'], [])


class SafetyTests(unittest.TestCase):
    def test_private_and_local_addresses_are_refused(self):
        with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '0'}):
            for url in ('http://127.0.0.1/', 'http://localhost:8000/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data',
                        'ftp://example.org/', 'file:///etc/passwd', 'not a url'):
                with self.assertRaises(ValueError, msg=url):
                    builder.crawl(url, fetch=lambda u: (u, 'text/html', ''))

    def test_pages_on_other_sites_are_not_followed(self):
        pages = {'https://church.test/': '<a href="/about">About</a><a href="https://elsewhere.test/x">X</a><p>Hi</p>',
                 'https://church.test/about': '<p>About us</p>'}
        fetched = []

        def fetch(url):
            fetched.append(url)
            return url, 'text/html', pages[url]
        with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
            builder.crawl('https://church.test/', fetch=fetch)
        self.assertEqual(fetched, ['https://church.test/', 'https://church.test/about'])


class RouteTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        builder.import_limiter.reset()
        self.addCleanup(builder.import_limiter.reset)
        for patcher in (mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1', 'BUILDER_AI': '0'}),
                        mock.patch.object(builder, '_http_fetch', site('harborlight-messy')),
                        mock.patch.object(builder, '_ai_complete', None),
                        mock.patch.object(builder, '_ai_describe', None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def hope(self):
        return {'X-Church': 'hope-chapel', 'X-Church-Name': 'Hope%20Chapel', 'X-Church-City': 'Austin'}

    def create(self, headers=None):
        response = self.client.post('/api/builder/drafts', headers=headers, json={'url': 'https://church.test/'})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertNotIn('text', response.json()['sources'][0])
        self.assertEqual(len(response.json()['id']), 24)
        self.assertEqual(response.json()['notes'], [])
        return response.json()['id']

    def confirm(self, sid):
        for field, value in [('services', 'Sundays 9 and 11'), ('phone', '5550194433'), ('name', 'Harborlight Chapel'),
                             ('address', '12 Water Street, Corvallen'), ('email', 'hello@example.org')]:
            r = self.client.post(f'/api/builder/drafts/{sid}/answers', json={'field': field, 'value': value})
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['status'], 'review')

    def test_public_import_answer_and_preview_without_a_church(self):
        sid = self.create()
        self.assertEqual(self.client.get('/api/builder/drafts/' + sid).status_code, 200)
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/preview').status_code, 400)
        self.confirm(sid)
        preview = self.client.post(f'/api/builder/drafts/{sid}/preview')
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()['content']['info']['name'], 'Harborlight Chapel')
        self.assertEqual(set(self.fake.seen), {builder.DRAFT_SPACE})

    def test_notes_survive_storage_and_get_with_legacy_default(self):
        sid = self.create()
        draft = builder._load(sid)
        draft['notes'] = ['Stopped reading to stay within the time limit.']
        builder._save(draft)
        self.assertEqual(self.client.get('/api/builder/drafts/' + sid).json()['notes'], draft['notes'])
        del draft['notes']
        builder._save(draft)
        self.assertEqual(self.client.get('/api/builder/drafts/' + sid).json()['notes'], [])

    def test_site_snapshot_has_confirmed_details_without_church_writes(self):
        demo = db.export_content()
        sid = self.create()
        self.confirm(sid)
        databases = set(self.fake.databases)
        draft = builder._load(sid)
        self.fake.seen.clear()
        with mock.patch.object(db, 'replace_content', side_effect=AssertionError('Church write')), \
                mock.patch.object(db, 'start_church', side_effect=AssertionError('Church creation')):
            response = self.client.get(f'/api/builder/drafts/{sid}/site', headers=self.hope())
        self.assertEqual(response.status_code, 200, response.text)
        snapshot = response.json()
        self.assertEqual(snapshot['info']['name'], 'Harborlight Chapel')
        self.assertEqual([(s['day'], s['time']) for s in snapshot['info']['services']],
                         [('Sunday', '9:00 AM'), ('Sunday', '11:00 AM')])
        self.assertEqual(snapshot['church']['info'], snapshot['info'])
        self.assertEqual(snapshot['ministries'], [])
        self.assertEqual(snapshot['events'], [])
        self.assertEqual(set(self.fake.seen), {builder.DRAFT_SPACE})
        self.assertEqual(set(self.fake.databases), databases)
        self.assertEqual(builder._load(sid), draft)
        self.assertEqual(db.export_content(), demo)

    def test_site_snapshot_allows_unanswered_questions(self):
        sid = self.create()
        response = self.client.get(f'/api/builder/drafts/{sid}/site')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['info']['name'], 'Your church')
        self.assertEqual(response.json()['info']['services'], [])
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/preview').status_code, 400)

    def test_site_snapshot_matches_the_real_public_endpoints(self):
        sid = self.create()
        self.confirm(sid)
        content = builder.build_content(builder._load(sid))
        content.update({
            'faqs': [{'question': 'What should I wear?', 'answer': 'Come as you are.'}],
            'events': [{'name': 'Community lunch', 'when': 'Sunday after service'}],
            'ministries': [{'name': 'Welcome', 'shifts': [{'date': '2030-01-06', 'start_time': '09:00',
                                                       'end_time': '10:00', 'filled': 1, 'total': 3}]}],
            'calendar': [{'title': 'Community lunch', 'date': '2030-01-06', 'time': '12:00'}],
        })
        content = church_content.normalize(church_content.ChurchContent(**content))
        with mock.patch.object(builder, 'build_content', return_value=content):
            snapshot = self.client.get(f'/api/builder/drafts/{sid}/site').json()
            self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/apply', headers=self.hope()).status_code, 200)
        for path in ('info', 'church', 'ministries', 'events'):
            self.assertEqual(self.client.get('/api/' + path, headers=self.hope()).json(), snapshot[path])
        self.assertEqual(snapshot['ministries'][0]['total'], 3)
        self.assertEqual(snapshot['events'][0]['title'], 'Community lunch')

    def test_expired_site_snapshot_is_404(self):
        sid = self.create()
        draft = builder._load(sid)
        draft['created_at'] = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        builder._save(draft)
        self.assertEqual(self.client.get(f'/api/builder/drafts/{sid}/site').status_code, 404)

    def test_drafts_live_outside_the_requesting_church(self):
        sid = self.create(self.hope())
        self.assertEqual(self.client.get('/api/builder/drafts/' + sid).status_code, 200)
        self.confirm(sid)
        with db.use_church('hope-chapel'):
            self.assertIsNone(db.one('SELECT data FROM config WHERE key = ?', ('draft:' + sid,)))
            self.assertIsNone(db.one('SELECT data FROM config WHERE key = ?', ('builder:' + sid,)))
        with db.use_church(builder.DRAFT_SPACE):
            self.assertIsNotNone(db.one('SELECT data FROM config WHERE key = ?', ('draft:' + sid,)))

    def test_apply_writes_into_current_church_and_consumes_draft(self):
        sid = self.create()
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/apply', headers=self.hope()).status_code, 400)
        self.confirm(sid)
        built = self.client.post(f'/api/builder/drafts/{sid}/apply', headers=self.hope())
        self.assertEqual(built.status_code, 200, built.text)
        self.assertEqual(built.json()['church'], 'hope-chapel')
        with db.use_church('hope-chapel'):
            info = db.get_church_info()
        self.assertEqual(info['name'], 'Harborlight Chapel')
        self.assertEqual([s['time'] for s in info['services']], ['9:00 AM', '11:00 AM'])
        self.assertEqual(self.client.get('/api/builder/drafts/' + sid).status_code, 404)
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/apply', headers=self.hope()).status_code, 404)
        with db.use_church(builder.DRAFT_SPACE):
            self.assertIsNone(db.one('SELECT data FROM config WHERE key = ?', ('draft:' + sid,)))
        self.assertEqual(db.get_church_info()['name'], 'Grace Community Church')

    def test_failed_apply_preserves_draft_for_retry(self):
        sid = self.create()
        self.confirm(sid)
        with mock.patch.object(db, 'replace_content', side_effect=RuntimeError('write unavailable')):
            with self.assertRaises(RuntimeError):
                self.client.post(f'/api/builder/drafts/{sid}/apply', headers=self.hope())
        self.assertEqual(self.client.get('/api/builder/drafts/' + sid).status_code, 200)
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/apply', headers=self.hope()).status_code, 200)

    def test_the_demo_church_cannot_be_replaced(self):
        sid = self.create()
        self.confirm(sid)
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/preview').status_code, 200)
        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/apply').status_code, 403)
        self.assertEqual(self.client.get('/api/builder/drafts/' + sid).status_code, 200)
        self.assertEqual(db.get_church_info()['name'], 'Grace Community Church')

    def test_expiry_is_measured_from_creation_not_last_answer(self):
        sid = self.create()
        draft = builder._load(sid)
        now = datetime.now(timezone.utc)
        draft['created_at'] = (now - timedelta(hours=23)).isoformat()
        builder._save(draft)
        self.confirm(sid)
        self.assertEqual(builder._load(sid)['created_at'], draft['created_at'])
        draft['created_at'] = (now - timedelta(hours=24, seconds=1)).isoformat()
        builder._save(draft)
        for path, method in [('', 'get'), ('/answers', 'post'), ('/preview', 'post'), ('/apply', 'post')]:
            kwargs = {'json': {'field': 'name', 'value': 'Church'}} if path == '/answers' else {}
            self.assertEqual(getattr(self.client, method)(f'/api/builder/drafts/{sid}{path}', **kwargs).status_code, 404)
        with db.use_church(builder.DRAFT_SPACE):
            self.assertIsNone(db.one('SELECT data FROM config WHERE key = ?', ('draft:' + sid,)))

    def test_per_ip_limit_and_forwarded_client_ip(self):
        for _ in range(5):
            self.create({'cf-connecting-ip': '192.0.2.1'})
        with mock.patch.object(builder, 'new_session') as importing:
            limited = self.client.post('/api/builder/drafts', headers={'cf-connecting-ip': '192.0.2.1'},
                                       json={'url': 'https://church.test/'})
            self.assertEqual(limited.status_code, 429)
            self.assertIn('address', limited.json()['detail'])
            importing.assert_not_called()
        self.create({'cf-connecting-ip': '192.0.2.2'})

    def test_socket_ip_limit_and_rolling_hour(self):
        builder.import_limiter.starts.extend((time.monotonic(), 'testclient') for _ in range(5))
        self.assertEqual(self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'}).status_code, 429)
        builder.import_limiter.reset()
        builder.import_limiter.starts.extend((time.monotonic() - 3601, 'testclient') for _ in range(5))
        self.create()

    def test_overall_limit(self):
        builder.import_limiter.starts.extend((time.monotonic(), f'client-{i}') for i in range(60))
        r = self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'})
        self.assertEqual(r.status_code, 429)
        self.assertIn('hour', r.json()['detail'])

    def test_concurrency_limit_and_release_on_import_failure(self):
        with builder.import_limiter.importing('one'), builder.import_limiter.importing('two'), builder.import_limiter.importing('three'):
            r = self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'})
            self.assertEqual(r.status_code, 429)
            self.assertIn('already running', r.json()['detail'])
        self.assertEqual(builder.import_limiter.running, 0)
        with mock.patch.object(builder, 'new_session', side_effect=ValueError('No pages')):
            self.assertEqual(self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'}).status_code, 400)
        self.assertEqual(builder.import_limiter.running, 0)
        self.create()

    def test_unknown_or_malformed_drafts_are_404(self):
        for sid in ('a' * 24, 'nope-nope-nope', '../../etc', 'x', '+' * 24, 'a' * 25):
            for path, method in [('', 'get'), ('/site', 'get'), ('/answers', 'post'), ('/preview', 'post'), ('/apply', 'post')]:
                kwargs = {'json': {'field': 'name', 'value': 'Church'}} if path == '/answers' else {}
                self.assertEqual(getattr(self.client, method)(f'/api/builder/drafts/{sid}{path}', **kwargs).status_code, 404)

    def test_old_session_routes_are_removed(self):
        self.assertEqual(self.client.post('/api/builder/sessions', json={'url': 'https://church.test/'}).status_code, 404)


if __name__ == '__main__':
    unittest.main()
