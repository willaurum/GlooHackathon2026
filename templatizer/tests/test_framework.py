import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from backend.app import church_content, db
from backend.tests.test_churches import ChurchTestCase
from templatizer.cli import load_blueprint, main, write_json
from templatizer.model import schema

ROOT = Path(__file__).resolve().parents[1]


class FrameworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def run_cli(self, *args):
        with contextlib.redirect_stdout(io.StringIO()):
            return main(list(map(str, args)))

    def document(self):
        return json.loads((ROOT / 'examples/complete.json').read_text(encoding='utf-8'))

    def save(self, value):
        path = self.directory / 'input.json'
        write_json(path, value)
        return path

    def test_complete_prepares_runtime_compatible_content(self):
        output = self.directory / 'prepared'
        self.assertEqual(self.run_cli('prepare', ROOT / 'examples/complete.json', '--output', output), 0)
        content = json.loads((output / 'church-content.json').read_text(encoding='utf-8'))
        self.assertEqual(content, church_content.normalize(church_content.ChurchContent.model_validate(content)))
        self.assertEqual(set(content), {'info', 'faqs', 'events', 'groups', 'ministries', 'calendar', 'regions'})
        self.assertEqual(content['info']['map_query'], content['info']['address'])
        self.assertEqual(content['ministries'][0]['id'], 0)
        manifest = json.loads((output / 'manifest.json').read_text())
        self.assertEqual(manifest['import_path'], '/api/churches/cedar-hollow/church/content')
        self.assertNotIn('password', manifest)

    def test_missing_information_is_not_fabricated(self):
        output = self.directory / 'partial'
        self.assertEqual(self.run_cli('prepare', ROOT / 'examples/incomplete.json', '--output', output), 0)
        content = json.loads((output / 'church-content.json').read_text())
        self.assertEqual(set(content), {'info'})
        self.assertEqual(content['info']['address'], '')
        self.assertEqual(content['info']['services'], [])
        self.assertEqual(content['info']['map_query'], '')
        self.assertTrue(json.loads((output / 'review-report.json').read_text())['warnings'])

    def test_conflicts_and_unverified_claims_block_without_creating_output(self):
        output = self.directory / 'blocked'
        self.assertEqual(self.run_cli('prepare', ROOT / 'examples/conflicting.json', '--output', output), 3)
        self.assertFalse(output.exists())
        document = self.document()
        document['review'] = [{'path': '/content/info/name', 'kind': 'unverified', 'message': 'Confirm the name.'}]
        self.assertEqual(self.run_cli('prepare', self.save(document), '--output', output), 3)
        self.assertFalse(output.exists())

    def test_invalid_documents_are_rejected(self):
        changes = [
            lambda d: d.update(schema_version=True),
            lambda d: d.update(schema_version='1'),
            lambda d: d.update(schema_version=2),
            lambda d: d.update(church_slug='staff'),
            lambda d: d.update(church_slug='../escape'),
            lambda d: d.update(template='other'),
            lambda d: d.update(password='unsupported'),
            lambda d: d['content']['info'].update(admin_role='owner'),
            lambda d: d['content'].pop('info'),
            lambda d: d['content']['info'].update(name=''),
            lambda d: d['content']['calendar'][0].update(date='next Sunday'),
            lambda d: d['content']['ministries'][0].update(total='3'),
            lambda d: d['content'].update(faqs=[{'id': 1, 'question': 'A', 'answer': 'B'}, {'id': 1, 'question': 'C', 'answer': 'D'}]),
            lambda d: d['content']['regions'].append(d['content']['regions'][0].copy()),
            lambda d: d['evidence'][0].update(source_url='https://different.example.org/'),
            lambda d: d['evidence'][0].update(path='/content/info/absent'),
            lambda d: d['evidence'][0].update(path='/content/info/phone'),
            lambda d: d['evidence'][0].update(path='/content/info/services/01/time'),
        ]
        for change in changes:
            document = self.document()
            change(document)
            with self.subTest(document=document):
                self.assertEqual(self.run_cli('validate', self.save(document)), 2)

    def test_duplicate_json_keys_and_non_json_are_rejected(self):
        path = self.directory / 'input.json'
        for text in ('{"schema_version":1,"schema_version":2}', '{broken'):
            path.write_text(text)
            self.assertEqual(self.run_cli('validate', path), 2)

    def test_prepare_refuses_overwrite(self):
        output = self.directory / 'prepared'
        self.assertEqual(self.run_cli('prepare', ROOT / 'examples/complete.json', '--output', output), 0)
        saved = (output / 'church-content.json').read_bytes()
        self.assertEqual(self.run_cli('prepare', ROOT / 'examples/incomplete.json', '--output', output), 2)
        self.assertEqual((output / 'church-content.json').read_bytes(), saved)

    def test_oversized_content_is_blocked(self):
        document = self.document()
        document['content']['calendar'] = [{'title': 'Example', 'date': '2026-10-16', 'description': 'x' * 4000} for _ in range(140)]
        output = self.directory / 'oversized'
        self.assertEqual(self.run_cli('prepare', self.save(document), '--output', output), 2)
        self.assertFalse(output.exists())

    def test_checked_in_schema_matches_runtime_contract(self):
        saved = json.loads((ROOT / 'schemas/site-blueprint-v1.schema.json').read_text(encoding='utf-8'))
        self.assertEqual(saved, schema())
        self.assertFalse(saved['$defs']['Info']['additionalProperties'])


class PreparedImportTests(ChurchTestCase):
    def test_blueprint_import_is_scoped_and_keeps_omitted_sections(self):
        blueprint = load_blueprint(ROOT / 'examples/complete.json')
        content = church_content.normalize(blueprint.content)
        demo_name = db.get_church_info()['name']
        with db.use_church(blueprint.church_slug, content['info']['name'], content['info']['city']):
            saved = church_content.put_content(church_content.ChurchContent.model_validate(content))
            self.assertEqual(saved['info']['name'], 'Cedar Hollow Community Church')
            self.assertEqual(saved['info']['services'][0]['time'], '10:15am')
            self.assertEqual(len(db.list_ministries()), 1)
            self.assertEqual(len(db.list_regions()), 1)
            church_content.put_content(church_content.ChurchContent.model_validate({
                'info': {'name': 'Cedar Hollow Community Church'},
            }))
            self.assertEqual(db.get_church_info()['address'], '')
            self.assertEqual(len(db.list_ministries()), 1)
            self.assertEqual(len(db.list_events()), 1)
        self.assertEqual(db.get_church_info()['name'], demo_name)
        with db.use_church('another-fixture', 'Another fictional church'):
            self.assertEqual(db.list_ministries(), [])
            self.assertEqual(db.list_regions(), [])


if __name__ == '__main__':
    unittest.main()
