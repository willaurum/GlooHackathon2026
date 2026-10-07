"""The agentic builder (builder.py): import, extract, clarify, answer, build.

Runs offline against two fictional church sites in fixtures/builder/ (copies of the synthetic sites):
harborlight-messy has conflicting service times and phones and no address or email; cedar-hollow-static is
complete and consistent. The AI step is replaced by a fake so the tests are deterministic.

    python -m unittest backend.tests.test_builder
"""
import os
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, db, main
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
        for patcher in (mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1', 'BUILDER_AI': '0'}),
                        mock.patch.object(builder, '_http_fetch', site('harborlight-messy')),
                        mock.patch.object(builder, '_ai_complete', None),
                        mock.patch.object(builder, '_ai_describe', None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def hope(self):
        return {'X-Church': 'hope-chapel', 'X-Church-Name': 'Hope%20Chapel', 'X-Church-City': 'Austin'}

    def test_import_answer_and_build_into_a_church(self):
        created = self.client.post('/api/builder/sessions', headers=self.hope(), json={'url': 'https://church.test/'})
        self.assertEqual(created.status_code, 201, created.text)
        sid = created.json()['id']
        self.assertNotIn('text', created.json()['sources'][0])  # page texts stay on the server
        self.assertEqual(self.client.get('/api/builder/sessions/' + sid).status_code, 404)  # another church can't see it
        self.assertEqual(self.client.post(f'/api/builder/sessions/{sid}/build', headers=self.hope(), json={'apply': True}).status_code, 400)
        for field, value in [('services', 'Sundays 9 and 11'), ('phone', '5550194433'), ('name', 'Harborlight Chapel'),
                             ('address', '12 Water Street, Corvallen'), ('email', 'hello@harborlight.example.org')]:
            r = self.client.post(f'/api/builder/sessions/{sid}/answers', headers=self.hope(), json={'field': field, 'value': value})
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['status'], 'review')
        built = self.client.post(f'/api/builder/sessions/{sid}/build', headers=self.hope(), json={'apply': True})
        self.assertEqual(built.status_code, 200, built.text)
        with db.use_church('hope-chapel'):
            info = db.get_church_info()
        self.assertEqual(info['name'], 'Harborlight Chapel')
        self.assertEqual([s['time'] for s in info['services']], ['9:00 AM', '11:00 AM'])

    def test_the_demo_church_cannot_be_replaced(self):
        sid = self.client.post('/api/builder/sessions', json={'url': 'https://church.test/'}).json()['id']
        for field, value in [('services', 'Sundays 9 and 11'), ('phone', '5550194433'), ('name', 'X Church'),
                             ('address', '1 Main Street, Corvallen'), ('email', 'x@example.org')]:
            self.client.post(f'/api/builder/sessions/{sid}/answers', json={'field': field, 'value': value})
        self.assertEqual(self.client.post(f'/api/builder/sessions/{sid}/build', json={'apply': False}).status_code, 200)
        self.assertEqual(self.client.post(f'/api/builder/sessions/{sid}/build', json={'apply': True}).status_code, 403)
        self.assertEqual(db.get_church_info()['name'], 'Grace Community Church')

    def test_unknown_or_malformed_sessions_are_404(self):
        for sid in ('nope-nope-nope', '../../etc', 'x'):
            self.assertEqual(self.client.get('/api/builder/sessions/' + sid).status_code, 404)


if __name__ == '__main__':
    unittest.main()
