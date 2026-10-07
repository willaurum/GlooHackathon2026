"""Builder seed files: offline imports, validation and the real public site endpoints."""
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, builder_export, builder_score, builder_structured, chat, church_content, db, main
from backend.tests.test_churches import APP, ChurchTestCase

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'builder'
SITES = ('cedar-hollow-millbrook', 'harborlight-messy')
ANSWERS = {'name': 'Lantern Meadow Chapel', 'address': '123 Lantern Lane, Meadowville (fictional)',
           'phone': '5550101234', 'email': 'office@lantern.example',
           'services': [{'day': 'Sunday', 'time': '10:00'}]}


def normalized(content):
    return church_content.normalize(church_content.ChurchContent(**content))


def imported(name, answer=True):
    session = builder_score.import_fixture(FIXTURES / name)
    if answer:
        for question in list(session['questions']):
            builder.apply_answer(session, question['field'], ANSWERS[question['field']])
    return session


class ExportTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(builder_structured, '_today', lambda: date(2026, 10, 7))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_offline_fixture_round_trips(self):
        for name in SITES:
            with self.subTest(site=name):
                session = imported(name)
                self.assertEqual(session['questions'], [])
                content = builder.build_content(session)
                exported = builder_export.files(content)
                self.assertEqual(list(exported), ['church.json', 'ministries.json', 'events.json', 'builder.json'])
                self.assertEqual(list(exported['church.json']), [k for k in ('info', 'faqs', 'events', 'groups') if k in content])
                self.assertEqual(builder_export.load(exported), normalized(content))
                self.assertEqual(exported['builder.json']['pages'], content['pages'])

    def test_every_section_and_empty_lists_are_preserved(self):
        content = normalized({
            'info': {'name': 'Lantern Meadow Chapel', 'custom': 'Kept'},
            'faqs': [], 'events': [], 'groups': [], 'ministries': [], 'calendar': [], 'regions': [],
            'staff': [{'name': 'Alex Example', 'role': 'Pastor'}],
            'locations': [{'name': 'Meadow Hall', 'address': '123 Lantern Lane (fictional)'}],
            'sermons': [{'title': 'A welcoming place', 'url': 'https://lantern.example/message'}],
            'site': {}, 'pages': [],
        })
        exported = builder_export.files(content)
        self.assertEqual(list(exported['builder.json']), ['staff', 'locations', 'sermons', 'site', 'pages'])
        self.assertEqual(exported['ministries.json'], {'ministries': []})
        self.assertEqual(exported['events.json'], {'calendar': []})
        self.assertEqual(exported['regions.json'], {'regions': []})
        self.assertEqual(builder_export.load(exported), content)
        self.assertEqual(builder_export.load(builder_export.files({'faqs': []})), {'faqs': []})

    def test_demo_seed_files_load_without_changing_supplied_values(self):
        seeds = {name: json.loads((APP / name).read_text(encoding='utf-8'))
                 for name in ('church.json', 'ministries.json', 'events.json')}
        merged = {**seeds['church.json'], 'ministries': seeds['ministries.json'], 'calendar': seeds['events.json']}
        loaded = builder_export.load(seeds)
        self.assertEqual(loaded, normalized(merged))

        def supplied_values(value, seed):
            if isinstance(seed, dict):
                return {k: supplied_values(value[k], v) for k, v in seed.items()}
            if isinstance(seed, list):
                self.assertEqual(len(value), len(seed))
                return [supplied_values(v, s) for v, s in zip(value, seed)]
            return value

        self.assertEqual(supplied_values(loaded, merged), merged)
        self.assertEqual(builder_export.load(builder_export.files(loaded)), loaded)

    def test_load_uses_content_validation(self):
        for exported in (
            {'church.json': {'info': {'name': ''}}},
            {'events.json': {'calendar': [{'title': 'Lunch', 'date': 'bad-date'}]}},
            {'church.json': {'faqs': [{'id': 1, 'question': 'Where?', 'answer': 'Here.'},
                                      {'id': 1, 'question': 'When?', 'answer': 'Sunday.'}]}},
            {'builder.json': {'pages': [{'slug': 'home', 'title': 'Home'}, {'slug': 'home', 'title': 'Other'}]}},
            {'church.json': {'calendar': []}},
            {'unknown.json': {}},
            {'builder.json': []},
        ):
            with self.subTest(files=exported), self.assertRaises(church_content.ContentError):
                builder_export.load(exported)

    def test_cli_writes_offline_files_and_applies_answers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            answers = root / 'answers.json'
            answers.write_text(json.dumps(ANSWERS), encoding='utf-8')
            output = root / 'site'
            with mock.patch('sys.argv', ['builder_export', str(FIXTURES / SITES[0]), str(output),
                                         '--answers', str(answers)]), \
                    mock.patch.object(builder, '_ai_complete', side_effect=AssertionError('AI called')), \
                    mock.patch.object(builder, '_ai_describe', side_effect=AssertionError('Vision called')):
                builder_export.main()
            exported = {path.name: json.loads(path.read_text(encoding='utf-8')) for path in output.glob('*.json')}
            content = builder_export.load(exported)
            self.assertEqual(content['info']['name'], ANSWERS['name'])
            self.assertEqual(content['info']['services'], [{'day': 'Sunday', 'time': '10:00 AM', 'note': ''}])
            for name, data in exported.items():
                self.assertEqual((output / name).read_text(encoding='utf-8'),
                                 json.dumps(data, indent=2, ensure_ascii=False) + '\n')


class ExportDatabaseTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        patcher = mock.patch.object(builder_structured, '_today', lambda: date(2026, 10, 7))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_files_load_into_a_fresh_church_and_public_endpoints(self):
        for name in SITES:
            with self.subTest(site=name):
                content = builder.build_content(imported(name))
                # Fill optional sections these rules-only imports may leave empty.
                content.update({
                    'faqs': [{'question': 'Where do we meet?', 'answer': 'At Meadow Hall.'}],
                    'ministries': [{'name': 'Welcome team', 'shifts': [{'date': '2026-10-11',
                                    'start_time': '09:00', 'end_time': '11:00', 'filled': 1, 'total': 3}]}],
                    'calendar': [{'title': 'Community lunch', 'date': '2026-10-11', 'time': '12:00'}],
                })
                content = normalized(content)
                slug = 'export-' + name
                with db.use_church(slug, 'Empty church'):
                    self.assertEqual(db.list_ministries(), [])
                    self.assertEqual(db.list_events(), [])
                    db.replace_content(builder_export.load(builder_export.files(content)))
                    stored = db.export_content()
                    self.assertEqual(chat.church_info()['church'], content['info'])
                    self.assertEqual(chat.church_info()['faqs'], content['faqs'])
                    self.assertEqual(chat.search_ministries()['ministries'][0]['name'], 'Welcome team')
                    self.assertEqual(chat.list_events(date(2026, 10, 7))['calendar'][0]['title'], 'Community lunch')
                expected = {'info': content['info'], 'church': church_content.public_church(content),
                            'ministries': church_content.public_ministries(content),
                            'events': church_content.public_events(content)}
                for route, value in expected.items():
                    response = self.client.get('/api/' + route, headers={'X-Church': slug})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json(), value)
                for section, value in content.items():
                    self.assertEqual(stored[section], value)
                self.assertEqual(stored['faqs'][0]['answer'], 'At Meadow Hall.')

    def test_files_route_keeps_pages_and_allows_open_questions(self):
        for answered in (False, True):
            with self.subTest(answered=answered):
                session = imported('harborlight-messy', answer=answered)
                self.assertEqual(bool(session['questions']), not answered)
                content = builder.build_content(session, allow_unanswered=True)
                builder._save(session)
                response = self.client.get('/api/builder/drafts/' + session['id'] + '/files')
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json(), {'files': builder_export.files(content)})
                self.assertEqual(builder_export.load(response.json()['files']), content)
                self.assertEqual(set(self.fake.databases), {builder.DRAFT_SPACE})

    def test_files_route_unknown_id_is_404(self):
        for draft_id in ('missing', 'x' * 24):
            self.assertEqual(self.client.get('/api/builder/drafts/' + draft_id + '/files').status_code, 404)


if __name__ == '__main__':
    unittest.main()
