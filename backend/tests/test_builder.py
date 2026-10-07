"""The agentic builder (builder.py): import, extract, clarify, answer, build.

Runs offline against two fictional church sites in fixtures/builder/ (copies of the synthetic sites):
harborlight-messy has conflicting service times and phones and no address or email; cedar-hollow-static is
complete and consistent. The AI step is replaced by a fake so the tests are deterministic.

    python -m unittest backend.tests.test_builder
"""
import asyncio
import io
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, church_content, db, main
from backend.tests.test_churches import ChurchTestCase

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'builder'


def pdf_bytes(text='Sunday worship at 9am'):
    stream = f'BT /F1 12 Tf 20 150 Td ({text}) Tj ET'.encode()
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
    data, offsets = b'%PDF-1.4\n', [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return data + f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()


def docx_bytes(text='Sunday worship at 9am', prefix=''):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('word/document.xml', prefix + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                         f'<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return data.getvalue()


def hung_document(connection, data, content_type):
    time.sleep(30)


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
    def test_scan_vision_payload_uses_a_pdf_attachment(self):
        from backend.app import chat
        client = mock.MagicMock()
        client.chat.completions.create.return_value.choices[0].message.content = 'Sunday worship at 9am'
        with mock.patch.object(chat, 'make_clients', return_value=[('test', 'vision-test', None, client)]):
            self.assertEqual(builder._ai_describe_impl(b'%PDF-test', 'application/pdf'), 'Sunday worship at 9am')
        attachment = client.chat.completions.create.call_args.kwargs['messages'][0]['content'][1]
        self.assertEqual(attachment['type'], 'file')
        self.assertEqual(attachment['file']['filename'], 'material.pdf')
        self.assertTrue(attachment['file']['file_data'].startswith('data:application/pdf;base64,'))

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
    def test_abandoned_work_is_bounded_by_the_shared_pool(self):
        release, saturated, drained = threading.Event(), threading.Event(), threading.Event()
        lock = threading.Lock()
        running, peak, calls = 0, 0, 0
        limit = builder._WORKERS._max_workers

        def read(item):
            nonlocal running, peak, calls
            with lock:
                running += 1
                calls += 1
                peak = max(peak, running)
                if running == limit:
                    saturated.set()
            try:
                release.wait(2)
            finally:
                with lock:
                    running -= 1
                    if not running:
                        drained.set()
            return item

        try:
            for _ in range(4):
                values, skipped = builder._parallel(list(range(8)), read, time.monotonic() + 0.08)
                self.assertEqual(values, [None] * 8)
                self.assertEqual(skipped, 8)
            self.assertTrue(saturated.is_set())
            self.assertEqual(peak, limit)
            self.assertEqual(calls, limit)
        finally:
            release.set()
            self.assertTrue(drained.wait(1))

    def test_later_import_uses_capacity_while_abandoned_work_runs(self):
        release, started, finished = threading.Event(), threading.Event(), threading.Event()

        def read(item):
            started.set()
            try:
                release.wait(2)
            finally:
                finished.set()
            return item

        try:
            self.assertEqual(builder._parallel(['slow'], read, time.monotonic() + 0.08), ([None], 1))
            self.assertTrue(started.is_set())
            self.assertFalse(finished.is_set())
            session = self.session('cedar-hollow-static')
            self.assertEqual(session['status'], 'review')
            self.assertEqual(session['notes'], [])
            self.assertFalse(finished.is_set())
        finally:
            release.set()
            self.assertTrue(finished.wait(1))

    def test_ai_calls_run_with_four_workers(self):
        sources = [{'id': f's{i}', 'url': f'https://church.test/{i}', 'text': f'Page {i}'} for i in range(8)]
        lock = threading.Lock()
        running, peak = 0, 0

        def complete(messages, tools):
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.05)
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

        with mock.patch.object(builder, '_now', lambda: now[0]), mock.patch.object(builder, 'CRAWL_WORKERS', 1):
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
                texts = {s['id']: s['text'] for s in sources}
                for i, claim in enumerate(expected, 1):
                    claim['id'] = f'c{i}'
                    claim.update(builder.quote_context(texts[claim['source_id']], claim['quote']))
                s = self.session(name, complete)
                fields = builder.reconcile(expected, len(sources))
                self.assertEqual(s['claims'], expected)
                self.assertEqual(s['fields'], fields)
                self.assertEqual(s['questions'], builder.questions(fields, expected, sources))
                self.assertEqual(s['notes'], [])


class DocumentTests(unittest.TestCase):
    def test_docx_declarations_are_rejected_before_xml_parsing(self):
        for prefix in ('<!DOCTYPE w:document [<!ENTITY example "expanded">]>',
                       '<!doctype w:document>', '<!EnTiTy example "expanded">'):
            with self.subTest(prefix=prefix), mock.patch.object(builder.ET, 'fromstring') as parse:
                with self.assertRaisesRegex(ValueError, '^That Word document is not supported\\.$'):
                    builder._docx_text(docx_bytes('&example;', prefix))
                parse.assert_not_called()

    def test_docx_text_is_capped(self):
        self.assertEqual(builder._docx_text(docx_bytes('x' * (builder.MAX_SOURCE_CHARS + 100))),
                         'x' * builder.MAX_SOURCE_CHARS)

    def test_child_limits_memory_and_caps_its_reply(self):
        connection, resource = mock.Mock(), mock.Mock()
        with mock.patch.dict('sys.modules', {'resource': resource}), \
                mock.patch.object(builder, '_document_text', return_value='x' * (builder.MAX_SOURCE_CHARS + 100)):
            builder._document_child(connection, b'document', 'application/pdf')
        resource.setrlimit.assert_called_once_with(resource.RLIMIT_AS,
                                                   (builder.DOCUMENT_MEMORY, builder.DOCUMENT_MEMORY))
        connection.send.assert_called_once_with(('ok', 'x' * builder.MAX_SOURCE_CHARS))
        connection.close.assert_called_once()

    def test_hung_document_processes_are_killed_and_files_skipped(self):
        context = builder.multiprocessing.get_context('spawn')
        make_process = context.Process
        processes, exits = [], []

        def process(*args, **kwargs):
            child = make_process(*args, **kwargs)
            proxy = mock.Mock(wraps=child)

            def close():
                exits.append(child.exitcode)
                child.close()

            proxy.close.side_effect = close
            processes.append(proxy)
            return proxy

        started, notes = time.monotonic(), []
        with mock.patch.object(builder, '_document_child', hung_document), \
                mock.patch.object(builder, 'DOCUMENT_TIMEOUT', 0.1), \
                mock.patch.object(context, 'Process', side_effect=process):
            sources = builder.read_files([('slow.pdf', pdf_bytes()), ('slow.docx', docx_bytes()),
                                          ('good.txt', b'Sunday worship at 9am')], describe=False,
                                         deadline=started + 1, notes=notes)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual([s['title'] for s in sources], ['good.txt'])
        self.assertEqual(notes, ['slow.pdf was skipped because it took too long to read.',
                                 'slow.docx was skipped because it took too long to read.'])
        self.assertEqual(len(processes), 2)
        for child in processes:
            child.terminate.assert_called_once()
            child.close.assert_called_once()
        self.assertTrue(all(code is not None and code != 0 for code in exits))

    def test_failed_parse_skips_only_its_file(self):
        notes = []
        with mock.patch.object(builder, '_parse_document', return_value=('failed', None)):
            sources = builder.read_files([('bad.pdf', pdf_bytes()), ('good.txt', b'Sunday worship at 9am')],
                                         describe=False, notes=notes)
        self.assertEqual([s['title'] for s in sources], ['good.txt'])
        self.assertEqual(notes, ['bad.pdf was skipped because it could not be read.'])


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
                        # No robots.txt, sitemap or feeds on this site.
                        mock.patch.object(builder, '_http_feed', mock.Mock(side_effect=FileNotFoundError)),
                        mock.patch.object(builder, '_ai_complete', None),
                        mock.patch.object(builder, '_ai_describe', None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def hope(self):
        return {'X-Church': 'hope-chapel', 'X-Church-Name': 'Hope%20Chapel', 'X-Church-City': 'Austin'}

    def create(self, headers=None):
        response = self.client.post('/api/builder/drafts', headers=headers, json={'url': 'https://church.test/'})
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()['status'], 'importing')
        self.assertEqual(len(response.json()['id']), 24)
        builder.wait_for_imports()
        response = self.client.get('/api/builder/drafts/' + response.json()['id'])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(response.json()['status'], ('clarifying', 'review'))
        self.assertNotIn('text', response.json()['sources'][0])
        self.assertEqual(response.json()['notes'], [])
        return response.json()['id']

    def confirm(self, sid):
        for field, value in [('services', 'Sundays 9 and 11'), ('phone', '5550194433'), ('name', 'Harborlight Chapel'),
                             ('address', '12 Water Street, Corvallen'), ('email', 'hello@example.org')]:
            r = self.client.post(f'/api/builder/drafts/{sid}/answers', json={'field': field, 'value': value})
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['status'], 'review')

    def upload(self, filename, data, content_type='application/octet-stream'):
        return self.client.post('/api/builder/drafts/upload', files={'files': (filename, data, content_type)})

    def test_blank_draft_asks_every_required_field_and_uses_existing_flow(self):
        response = self.client.post('/api/builder/drafts/blank')
        self.assertEqual(response.status_code, 201, response.text)
        draft = response.json()
        self.assertEqual(len(draft['id']), 24)
        self.assertIsNone(draft['url'])
        self.assertEqual(draft['sources'], [])
        self.assertEqual(draft['claims'], [])
        self.assertEqual({q['field'] for q in draft['questions']}, set(builder.REQUIRED))
        self.assertTrue(all(q['kind'] == 'missing' for q in draft['questions']))
        self.assertEqual(self.client.get('/api/builder/drafts/' + draft['id']).json(), draft)
        self.confirm(draft['id'])
        self.assertEqual(self.client.post(f'/api/builder/drafts/{draft["id"]}/preview').status_code, 200)
        self.assertEqual(set(self.fake.seen), {builder.DRAFT_SPACE})

    def test_text_upload_conflicts_keep_filename_and_exact_quotes(self):
        text = b'Come worship with us Sundays 9 & 11.\nSunday worship now starts at 10:30am.'
        response = self.upload('../../bulletin.txt', text, 'image/png')
        self.assertEqual(response.status_code, 201, response.text)
        draft = response.json()
        self.assertEqual(draft['sources'], [{'id': 's1', 'kind': 'file', 'url': None, 'title': 'bulletin.txt'}])
        question = next(q for q in draft['questions'] if q['field'] == 'services')
        self.assertEqual(question['kind'], 'conflict')
        self.assertEqual({c['display'] for c in question['candidates']}, {'Sunday 9:00 AM, Sunday 11:00 AM', 'Sunday 10:30 AM'})
        for candidate in question['candidates']:
            for evidence in candidate['evidence']:
                self.assertEqual(evidence['title'], 'bulletin.txt')
                self.assertIsNone(evidence['url'])
                self.assertIn(evidence['quote'], text.decode())
        self.confirm(draft['id'])
        self.assertEqual(self.client.post(f'/api/builder/drafts/{draft["id"]}/preview').status_code, 200)

    def test_generated_pdf_is_read_by_content(self):
        response = self.upload('bulletin.bin', pdf_bytes(), 'text/plain')
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()['fields']['services']['value'], [{'day': 'Sunday', 'time': '09:00'}])
        self.assertEqual(response.json()['sources'][0]['title'], 'bulletin.bin')

    def test_upload_save_runs_off_the_event_loop_and_reserves_time(self):
        save, upload_session = builder._save, builder._upload_session
        deadlines = []

        def checked_save(session):
            with self.assertRaises(RuntimeError):
                asyncio.get_running_loop()
            return save(session)

        def checked_session(files, deadline):
            deadlines.append(deadline)
            return upload_session(files, deadline)

        started = time.monotonic()
        with mock.patch.object(builder, '_save', side_effect=checked_save) as saved, \
                mock.patch.object(builder, '_upload_session', side_effect=checked_session):
            response = self.upload('bulletin.txt', b'Sunday worship at 9am')
        self.assertEqual(response.status_code, 201, response.text)
        saved.assert_called_once()
        self.assertGreaterEqual(deadlines[0], started + builder.IMPORT_BUDGET - 5)
        self.assertLessEqual(deadlines[0], time.monotonic() + builder.IMPORT_BUDGET - 5)

    def test_docx_entities_and_invalid_documents_return_400(self):
        files = [('entities.docx', docx_bytes('&example;', '<!DOCTYPE w:document [<!ENTITY example "expanded">]>')),
                 ('broken.docx', docx_bytes('<broken>')), ('broken.pdf', b'%PDF-1.4\nnot a PDF')]
        for filename, data in files:
            with self.subTest(filename=filename):
                response = self.upload(filename, data)
                self.assertEqual(response.status_code, 400, response.text)
                if filename == 'entities.docx':
                    self.assertEqual(response.json()['detail'], 'That Word document is not supported.')

    def test_docx_and_html_are_read_by_content(self):
        for filename, data in [('welcome.bin', docx_bytes()),
                               ('welcome.txt', b'<html><script>Sunday worship at 11am</script><p>Sunday worship at 9am</p></html>')]:
            with self.subTest(filename=filename):
                response = self.upload(filename, data)
                self.assertEqual(response.status_code, 201, response.text)
                self.assertEqual(response.json()['fields']['services']['value'], [{'day': 'Sunday', 'time': '09:00'}])

    def test_oversized_and_unsupported_files_are_rejected(self):
        for filename, data, message in [('large.txt', b'x' * (builder.MAX_FILE_BYTES + 1), '5 MB'),
                                         ('fake.pdf', b'\x00\x01\x02\x03', 'Unsupported'),
                                         ('archive.docx', b'PK\x03\x04not a document', 'Word document')]:
            with self.subTest(filename=filename):
                response = self.upload(filename, data)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn(message, response.json()['detail'])

    def test_file_count_field_and_total_limits_are_rejected(self):
        for files in [[], [('files', ('bulletin.txt', b'x'))] * 6,
                      [('other', ('bulletin.txt', b'x'))],
                      [('files', (f'{i}.txt', b'x' * (4 * 1024 * 1024))) for i in range(3)]]:
            with self.subTest(count=len(files)):
                response = self.client.post('/api/builder/drafts/upload', files=files)
                self.assertEqual(response.status_code, 400, response.text)
        response = self.client.post('/api/builder/drafts/upload', files={'files': ('bulletin.txt', b'x')}, data={'description': 'extra'})
        self.assertEqual(response.status_code, 400, response.text)

    def test_docx_zip_bomb_is_rejected(self):
        response = self.upload('large.docx', docx_bytes('x' * (builder.MAX_FILE_BYTES + 1)))
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn('expands beyond', response.json()['detail'])

    def test_images_and_scanned_pdf_without_vision_are_skipped_with_notes(self):
        for filename, data in [('bulletin.png', b'\x89PNG\r\n\x1a\n'), ('bulletin.jpg', b'\xff\xd8\xff'),
                               ('bulletin.webp', b'RIFF\x00\x00\x00\x00WEBP'), ('scan.pdf', pdf_bytes(''))]:
            response = self.upload(filename, data)
            self.assertEqual(response.status_code, 201, response.text)
            draft = response.json()
            self.assertEqual(draft['sources'], [])
            self.assertEqual(draft['claims'], [])
            self.assertTrue(any(filename in note and 'no vision model' in note for note in draft['notes']))

    def test_images_and_scanned_pdf_use_the_same_vision_reader(self):
        for filename, data, content_type in [('bulletin.png', b'\x89PNG\r\n\x1a\n', 'image/png'),
                                               ('scan.pdf', pdf_bytes(''), 'application/pdf')]:
            with mock.patch.object(builder, '_ai_available', return_value=True), \
                    mock.patch.object(builder, '_ai_describe', return_value='Sunday worship at 10am') as describe:
                response = self.upload(filename, data, 'text/plain')
                self.assertEqual(response.status_code, 201, response.text)
                describe.assert_called_once_with(data, content_type)
                self.assertEqual(response.json()['sources'][0]['kind'], 'image')
                self.assertEqual(response.json()['fields']['services']['value'], [{'day': 'Sunday', 'time': '10:00'}])

    def test_rate_limit_is_shared_by_all_import_paths(self):
        # Earlier imports from this address, so the five below reach the limit.
        builder.import_limiter.starts.extend((time.monotonic(), 'testclient') for _ in range(builder.IMPORTS_PER_ADDRESS - 5))
        self.create()
        for _ in range(2):
            self.assertEqual(self.client.post('/api/builder/drafts/blank').status_code, 201)
            self.assertEqual(self.upload('bulletin.txt', b'Sunday worship at 9am').status_code, 201)
        for path in ('/blank', '/upload', ''):
            response = self.client.post('/api/builder/drafts' + path, files={'files': ('bulletin.txt', b'x')} if path == '/upload' else None,
                                        json={'url': 'https://church.test/'} if path == '' else None)
            self.assertEqual(response.status_code, 429, response.text)
        self.assertEqual(builder.import_limiter.running, 0)

    def test_upload_and_blank_drafts_use_the_existing_expiry(self):
        for response in [self.upload('bulletin.txt', b'Sunday worship at 9am'), self.client.post('/api/builder/drafts/blank')]:
            self.assertEqual(response.status_code, 201, response.text)
            sid = response.json()['id']
            draft = builder._load(sid)
            draft['created_at'] = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
            builder._save(draft)
            self.assertEqual(self.client.get('/api/builder/drafts/' + sid).status_code, 404)

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
        # Dated events found on the site (the fish fry, while it is upcoming) are the calendar.
        self.assertEqual([e['title'] for e in snapshot['events']],
                         [e['value']['name'] for e in draft['collections'].get('events', []) if e['value'].get('date')])
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
        # Applying keeps the city the church signed up with (the draft has none).
        for info in (snapshot['info'], snapshot['church']['info']):
            info['city'] = 'Austin'
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
        for _ in range(builder.IMPORTS_PER_ADDRESS):
            self.create({'cf-connecting-ip': '192.0.2.1'})
        with mock.patch.object(builder, 'new_session') as importing:
            limited = self.client.post('/api/builder/drafts', headers={'cf-connecting-ip': '192.0.2.1'},
                                       json={'url': 'https://church.test/'})
            self.assertEqual(limited.status_code, 429)
            self.assertIn('address', limited.json()['detail'])
            importing.assert_not_called()
        self.create({'cf-connecting-ip': '192.0.2.2'})

    def test_socket_ip_limit_and_rolling_hour(self):
        builder.import_limiter.starts.extend((time.monotonic(), 'testclient') for _ in range(builder.IMPORTS_PER_ADDRESS))
        self.assertEqual(self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'}).status_code, 429)
        builder.import_limiter.reset()
        builder.import_limiter.starts.extend((time.monotonic() - 3601, 'testclient') for _ in range(builder.IMPORTS_PER_ADDRESS))
        self.create()

    def test_overall_limit(self):
        builder.import_limiter.starts.extend((time.monotonic(), f'client-{i}') for i in range(builder.IMPORTS_PER_HOUR))
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
            started = self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'})
            self.assertEqual(started.status_code, 202)
            builder.wait_for_imports()
        failed = self.client.get('/api/builder/drafts/' + started.json()['id']).json()
        self.assertEqual((failed['status'], failed['error']), ('failed', 'No pages'))
        self.assertEqual(builder.import_limiter.running, 0)
        self.assertEqual(self.client.post('/api/builder/drafts', json={'url': 'ftp://church.test/'}).status_code, 400)
        self.assertEqual(builder.import_limiter.running, 0)
        self.create()

    def test_unknown_or_malformed_drafts_are_404(self):
        for sid in ('a' * 24, 'nope-nope-nope', '../../etc', 'x', '+' * 24, 'a' * 25):
            for path, method in [('', 'get'), ('/site', 'get'), ('/answers', 'post'), ('/preview', 'post'), ('/apply', 'post')]:
                kwargs = {'json': {'field': 'name', 'value': 'Church'}} if path == '/answers' else {}
                self.assertEqual(getattr(self.client, method)(f'/api/builder/drafts/{sid}{path}', **kwargs).status_code, 404)

    def test_old_session_routes_are_removed(self):
        self.assertEqual(self.client.post('/api/builder/sessions', json={'url': 'https://church.test/'}).status_code, 404)

    def test_saving_a_draft_drops_expired_drafts(self):
        old = {**builder.session_from_sources(None, []), 'created_at': (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()}
        builder._save(old)
        sid = self.create()
        with db.use_church(builder.DRAFT_SPACE):
            keys = [row['key'] for row in db.query("SELECT key FROM config WHERE key LIKE 'draft:%'")]
        # The new draft and its page rows; nothing of the expired one.
        self.assertIn('draft:' + sid, keys)
        self.assertTrue(all(key == 'draft:' + sid or key.startswith(f'draft:{sid}:page:') for key in keys), keys)


class AiOfflineTests(BuilderTestCase):
    """The laptop build's Ollama (or Cloudflare's Gloo) can be down; the import must still finish and say so."""

    def test_an_offline_ai_is_explained_in_the_notes(self):
        def offline(messages, tools):
            raise ConnectionError('Connection refused')
        s = self.session('cedar-hollow-static', complete=offline)
        self.assertEqual(s['fields']['phone']['value'], '5550142290')
        self.assertEqual(s['notes'], [builder.AI_OFFLINE_NOTE])

    def test_an_ai_that_never_answers_is_explained(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def hung(messages, tools):
            release.wait(2)
            return {'facts': []}
        with mock.patch.object(builder, 'IMPORT_BUDGET', 0.15):
            s = self.session('cedar-hollow-static', complete=hung)
        self.assertEqual(s['notes'], [builder.AI_SLOW_NOTE])
        self.assertEqual(s['fields']['phone']['value'], '5550142290')

    def test_some_failed_ai_calls_are_counted(self):
        def flaky(messages, tools):
            if 'Page: https://church.test/\n' in messages[1]['content']:
                raise RuntimeError('500 from the model')
            return {'facts': []}
        s = self.session('harborlight-messy', complete=flaky)
        self.assertEqual(s['notes'], ['1 source was read without AI because the AI reader returned an error.'])

    def test_no_configured_model_is_explained(self):
        with mock.patch.object(builder, '_ai_complete', lambda m, t, timeout=None: None), \
                mock.patch.object(builder, '_ai_available', lambda: False):
            s = builder.new_session('https://church.test/', fetch=site('cedar-hollow-static'), describe=False)
        self.assertEqual(s['notes'], [builder.AI_MISSING_NOTE])

    def test_real_calls_are_bounded_by_the_budget_and_fall_back_from_a_forced_tool(self):
        import httpx
        import openai
        calls, options = [], []

        class Completions:
            def create(self, **kwargs):
                calls.append(kwargs['tool_choice'])
                if isinstance(kwargs['tool_choice'], dict):
                    raise openai.BadRequestError('tool_choice not supported', body=None,
                                                 response=httpx.Response(400, request=httpx.Request('POST', 'http://ai.test')))
                call = mock.Mock()
                call.function.arguments = '{"facts": []}'
                return mock.Mock(choices=[mock.Mock(message=mock.Mock(tool_calls=[call]))])

        class Client:
            chat = mock.Mock(completions=Completions())

            def with_options(self, **kwargs):
                options.append(kwargs)
                return self

        with mock.patch('backend.app.chat.make_clients', return_value=[('ollama', 'qwen', {}, Client())]):
            self.assertEqual(builder._ai_complete_impl([], [builder.AI_TOOL], timeout=12.0), {'facts': []})
        self.assertEqual(calls, [{'type': 'function', 'function': {'name': 'record_church_facts'}}, 'auto'])
        self.assertEqual(options, [{'timeout': 12.0, 'max_retries': 0}])

    def test_gloo_uses_a_fast_model_and_other_providers_keep_theirs(self):
        with mock.patch.dict(os.environ, {'GLOO_BUILDER_MODEL': '', 'GLOO_MATCH_MODEL': ''}):
            self.assertEqual(builder.builder_model('gloo', 'gloo-qwen-3.7-flash'), 'gloo-anthropic-claude-haiku-4.5')
            self.assertEqual(builder.builder_model('ollama', 'qwen3.8:27b'), 'qwen3.8:27b')
        with mock.patch.dict(os.environ, {'GLOO_BUILDER_MODEL': '', 'GLOO_MATCH_MODEL': 'gloo-match'}):
            self.assertEqual(builder.builder_model('gloo', 'gloo-qwen-3.7-flash'), 'gloo-match')
        with mock.patch.dict(os.environ, {'GLOO_BUILDER_MODEL': 'gloo-builder', 'GLOO_MATCH_MODEL': 'gloo-match'}):
            self.assertEqual(builder.builder_model('gloo', 'gloo-qwen-3.7-flash'), 'gloo-builder')
            self.assertEqual(builder.builder_model('openai', 'gpt-5-mini'), 'gpt-5-mini')


class FetchBridgeTests(unittest.TestCase):
    """On Cloudflare the container fetches through the Worker (BUILDER_FETCH_URL=http://builder-fetch)."""

    def setUp(self):
        import httpx
        self.requests = []
        real_client = httpx.Client

        def handler(request):
            self.requests.append(request)
            body = json.loads(request.content)
            if 'private' in body['url']:
                return httpx.Response(403, json={'detail': 'That address is on a private network and cannot be imported.'})
            if body['kind'] == 'image':
                return httpx.Response(200, content=b'\x89PNG', headers={'content-type': 'image/png'})
            return httpx.Response(200, content='<title>Hi | Grace</title><p>Café at 9am</p>'.encode('latin-1'),
                                  headers={'content-type': 'text/html; charset=iso-8859-1', 'x-final-url': body['url'] + 'home'})

        transport = httpx.MockTransport(handler)
        for patcher in (mock.patch.dict(os.environ, {'BUILDER_FETCH_URL': 'http://builder-fetch/', 'BUILDER_ALLOW_PRIVATE': '0'}),
                        mock.patch.object(builder.httpx, 'Client', lambda **kw: real_client(transport=transport, **kw))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_pages_and_images_go_through_the_bridge(self):
        final, content_type, text = builder._http_fetch('https://grace.example/')
        self.assertEqual((final, content_type), ('https://grace.example/home', 'text/html; charset=iso-8859-1'))
        self.assertIn('Café at 9am', text)
        self.assertEqual(builder._http_fetch_bytes('https://grace.example/a.png'), ('image/png', b'\x89PNG'))
        self.assertEqual([str(r.url) for r in self.requests], ['http://builder-fetch/fetch'] * 2)

    def test_the_bridge_refusal_reaches_the_church(self):
        with self.assertRaises(ValueError) as caught:
            builder.crawl('https://private.example/')
        self.assertIn('private network', str(caught.exception))

    def test_schemes_are_still_checked_in_the_container(self):
        for url in ('file:///etc/passwd', 'ftp://example.org/', 'not a url'):
            with self.assertRaises(ValueError, msg=url):
                builder.crawl(url)
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
