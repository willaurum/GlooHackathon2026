"""church.json and site.json: the files Tekton writes, their schemas, the file check, and structured output."""

import json
import os
import unittest
from unittest import mock

import httpx
import openai
from fastapi.testclient import TestClient

from backend.app import builder, builder_agents, builder_json, builder_run, main
from backend.tests.test_builder import site
from backend.tests.test_churches import ChurchTestCase


def cedar():
    with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
        return builder.new_session('https://church.test/', fetch=site('cedar-hollow-millbrook'),
                                   complete=lambda m, t: None, describe=False)


class SchemaTests(unittest.TestCase):
    def test_committed_schemas_match_the_models(self):
        for name in builder_json.MODELS:
            path = builder_json.SCHEMA_DIR / f'{name}.schema.json'
            self.assertTrue(path.is_file(), f'{path} is missing: run python -m backend.app.builder_json')
            self.assertEqual(path.read_text(encoding='utf-8'), builder_json.schema_text(name),
                             f'{path.name} is stale: run python -m backend.app.builder_json')

    def test_schemas_name_their_version_and_kind(self):
        church, site_ = builder_json.schemas()['church'], builder_json.schemas()['site']
        self.assertEqual(church['properties']['schema_version']['const'], builder_json.SCHEMA_VERSION)
        self.assertEqual(church['properties']['kind']['const'], 'church')
        self.assertEqual(site_['properties']['kind']['const'], 'site')
        self.assertIn('info', church['required'])


class FileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session = cedar()
        cls.files = builder_json.files(cls.session)

    def test_church_json_carries_the_church_and_where_each_fact_came_from(self):
        church = self.files['church']
        self.assertEqual((church['schema_version'], church['kind'], church['generated_by']), ('1.0', 'church', 'tekton'))
        self.assertEqual(church['info']['name'], 'Cedar Hollow Community Church')
        self.assertEqual(church['info']['phone'], '(434) 555-0142')
        phone = church['sources']['info']['phone'][0]
        self.assertEqual(set(phone), set(builder_json.SOURCE_FIELDS))
        self.assertEqual((phone['url'], phone['quote']), ('https://church.test/', '(434) 555-0142'))
        self.assertEqual(builder_json.validate('church', church), [])

    def test_site_json_carries_the_look_and_pages(self):
        site_ = self.files['site']
        self.assertEqual(site_['kind'], 'site')
        self.assertEqual(site_['site']['theme']['primary'], '#3e5631')
        self.assertTrue(site_['pages'])
        self.assertEqual(builder_json.validate('site', site_), [])

    def test_the_file_check_runs_at_the_end_of_the_import(self):
        check = self.session['file_check']
        self.assertTrue(check['valid'], check['errors'])
        self.assertEqual(check['unsupported_count'], 0)
        self.assertGreaterEqual(check['facts_checked'], 4)
        self.assertTrue(builder_json.summary(check).startswith('Checking church.json and site.json against the schema… valid'))

    def test_schema_problems_are_named(self):
        bad = {**self.files['church'], 'info': {'name': ''}, 'staff': [{'role': 'Pastor'}]}
        errors = builder_json.validate('church', bad)
        self.assertTrue(any(e.startswith('church.info.name') for e in errors), errors)
        self.assertTrue(any(e.startswith('church.staff.0.name') for e in errors), errors)
        self.assertEqual(builder_json.validate('site', {**self.files['site'], 'site': {'theme': {'primary': 'green'}}})[0][:23],
                         'site.site.theme.primary')

    def test_a_fact_whose_quote_is_not_on_its_page_is_counted(self):
        session = cedar()
        for claim in session['claims']:
            if claim['field'] == 'phone':
                claim['quote'] = '(434) 555-9999'
        checked, missing = builder_json.unsupported(session)
        self.assertEqual(missing, ['info.phone'])
        self.assertIn('1 fact does not trace to its page', builder_json.summary({**builder_json.check(session)}))

    def test_quotes_trace_across_joined_lines_titles_and_structured_data(self):
        page = {'title': 'Home | Grace', 'text': '412 Orchard Lane\nMillbrook, VA', 'jsonld': [{'startDate': '2030-01-18T10:00'}]}
        self.assertTrue(builder_json.traces('412 Orchard Lane, Millbrook, VA', page))
        self.assertTrue(builder_json.traces('Home | Grace', page))
        self.assertTrue(builder_json.traces('2030-01-18T10:00', page))
        self.assertFalse(builder_json.traces('99 Elm Street', page))

    def test_the_file_check_is_a_step_in_the_progress_feed(self):
        run, token = builder_run.start()
        try:
            cedar()
        finally:
            builder_run.finish(token)
        texts = [s['text'] for s in run.steps]
        self.assertTrue(any(t.startswith('Checking church.json and site.json against the schema') for t in texts), texts)


class FileRouteTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        builder.import_limiter.reset()
        self.addCleanup(builder.import_limiter.reset)
        for patcher in (mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1', 'BUILDER_AI': '0'}),
                        mock.patch.object(builder, '_http_fetch', site('cedar-hollow-millbrook')),
                        mock.patch.object(builder, '_http_feed', mock.Mock(side_effect=FileNotFoundError)),
                        mock.patch.object(builder, '_http_css', mock.Mock(side_effect=FileNotFoundError)),
                        mock.patch.object(builder, '_ai_complete', None),
                        mock.patch.object(builder, '_ai_describe', None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_the_files_download_from_a_finished_draft(self):
        response = self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'})
        self.assertEqual(response.status_code, 202, response.text)
        builder.wait_for_imports()
        draft = self.client.get('/api/builder/drafts/' + response.json()['id']).json()
        for name in ('church', 'site'):
            response = self.client.get(f"/api/builder/drafts/{draft['id']}/{name}.json")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn(f'filename="{name}.json"', response.headers['content-disposition'])
            self.assertEqual(response.json()['kind'], name)
            self.assertEqual(builder_json.validate(name, response.json()), [])
        self.assertTrue(draft['file_check']['valid'])
        self.assertEqual(self.client.get('/api/builder/drafts/' + 'x' * 24 + '/church.json').status_code, 404)


# ---------------------------------------------------------------- structured output

def bad_request(message='response_format is not supported'):
    return openai.BadRequestError(message, body=None, response=httpx.Response(400, request=httpx.Request('POST', 'http://ai.test')))


class FakeClient:
    """An OpenAI client that records each request and answers with `reply(kwargs)`."""
    def __init__(self, reply, seen, base_url='http://guarded.test'):
        self.reply, self.seen, self.base_url = reply, seen, base_url
        self.chat = mock.Mock(completions=mock.Mock(create=self.create))

    def create(self, **kwargs):
        self.seen.append({**kwargs, 'base_url': self.base_url})
        return self.reply(kwargs)

    def with_options(self, **kwargs):
        return FakeClient(self.reply, self.seen, kwargs.get('base_url', self.base_url))


def content(text, finish='stop'):
    return mock.Mock(choices=[mock.Mock(finish_reason=finish, message=mock.Mock(content=text, tool_calls=None))], usage=None)


def tool_call(arguments):
    call = mock.Mock()
    call.function.arguments = arguments
    return mock.Mock(choices=[mock.Mock(message=mock.Mock(tool_calls=[call], content=None))], usage=None)


STAFF = builder_agents.SPECIALISTS['staff']['tool']


class StructuredOutputTests(unittest.TestCase):
    def setUp(self):
        builder._no_json_schema.clear()
        self.addCleanup(builder._no_json_schema.clear)
        patcher = mock.patch.dict(os.environ, {'BUILDER_STRUCTURED_OUTPUT': '', 'BUILDER_STRUCTURED_ENDPOINT': ''})
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, reply, model='gloo-openai-gpt-4.1-mini', provider='gloo', tool=STAFF):
        seen = []
        with mock.patch('backend.app.chat.make_clients', return_value=[(provider, model, {}, FakeClient(reply, seen))]), \
                mock.patch.object(builder, 'builder_model', lambda name, m: m):
            answer = builder._ai_complete_impl([{'role': 'system', 'content': 'Read the page.'}], [tool], timeout=5)
        return answer, seen

    def test_auto_mode_follows_the_model_family(self):
        self.assertEqual(builder.output_mode('gloo', 'gloo-openai-gpt-4.1-mini', 'record_staff'), 'json_schema')
        self.assertEqual(builder.output_mode('gloo', 'gloo-google-gemini-2.5-flash', 'record_events'), 'json_schema')
        self.assertEqual(builder.output_mode('gloo', 'gloo-qwen-3.7-flash', 'record_church_facts'), 'json_schema')
        self.assertEqual(builder.output_mode('gloo', 'gloo-anthropic-claude-haiku-4.5', 'record_staff'), 'tools')
        self.assertEqual(builder.output_mode('ollama', 'qwen3', 'record_staff'), 'tools')
        self.assertEqual(builder.output_mode('openai', 'gpt-4.1-mini', 'record_staff'), 'json_schema')
        # Plain-word edits keep their tool call.
        self.assertEqual(builder.output_mode('gloo', 'gloo-openai-gpt-4.1-mini', 'change_site'), 'tools')
        with mock.patch.dict(os.environ, {'BUILDER_STRUCTURED_OUTPUT': 'tools'}):
            self.assertEqual(builder.output_mode('gloo', 'gloo-openai-gpt-4.1-mini', 'record_staff'), 'tools')
        with mock.patch.dict(os.environ, {'BUILDER_STRUCTURED_OUTPUT': 'json_schema'}):
            self.assertEqual(builder.output_mode('gloo', 'gloo-anthropic-claude-haiku-4.5', 'record_staff'), 'json_schema')

    def test_the_reader_schema_is_strict_and_portable(self):
        fmt = builder.response_format(STAFF)
        self.assertEqual((fmt['type'], fmt['json_schema']['name'], fmt['json_schema']['strict']), ('json_schema', 'record_staff', True))
        item = fmt['json_schema']['schema']['properties']['items']['items']
        self.assertFalse(item['additionalProperties'])
        self.assertEqual(set(item['required']), set(item['properties']))
        self.assertEqual(item['properties']['name']['type'], 'string')
        self.assertEqual(item['properties']['role']['type'], ['string', 'null'])
        text = json.dumps(fmt)
        for word in ('$ref', 'maxLength', 'pattern', 'minLength'):
            self.assertNotIn(word, text)
        for tool in [builder.AI_TOOL] + [s['tool'] for s in builder_agents.SPECIALISTS.values()]:
            self.assertLessEqual(json.dumps(builder.response_format(tool)).count('"null"'), 16)

    def test_json_schema_answers_come_from_the_direct_endpoint(self):
        answer, seen = self.call(lambda kw: content('{"items": [{"name": "Dan Whitfield", "role": "Pastor", "email": null, '
                                                     '"phone": null, "bio": null, "group": null, "quote": "Pastor Dan Whitfield"}]}'))
        self.assertEqual(answer, {'items': [{'name': 'Dan Whitfield', 'role': 'Pastor', 'quote': 'Pastor Dan Whitfield'}]})
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]['base_url'], builder.DIRECT_ENDPOINT)
        self.assertEqual(seen[0]['response_format']['type'], 'json_schema')
        self.assertNotIn('tools', seen[0])
        self.assertIn('JSON', seen[0]['messages'][0]['content'])

    def test_a_refusal_falls_back_to_the_tool_call_and_is_remembered(self):
        def reply(kw):
            if 'response_format' in kw:
                raise bad_request()
            return tool_call('{"items": []}')
        run, token = builder_run.start()
        try:
            answer, seen = self.call(reply)
            again, seen_again = self.call(reply)
        finally:
            builder_run.finish(token)
        self.assertEqual((answer, again), ({'items': []}, {'items': []}))
        self.assertEqual(['response_format' in s for s in seen], [True, False])
        self.assertEqual(seen[1]['base_url'], 'http://guarded.test')  # the tool call goes to the usual endpoint
        self.assertEqual(['response_format' in s for s in seen_again], [False])
        summary = run.summary()
        self.assertEqual(summary['output_modes'], {'json_schema_fallback': 1, 'tools': 2})
        self.assertEqual(summary['ai_log'][0]['endpoint'], builder.DIRECT_ENDPOINT)

    def test_unusable_answers_fall_back_too(self):
        for reply in (content('Sorry, I cannot do that.'), content('{"items": [', finish='length'),
                      content('{"wrong": []}'), content(None)):
            builder._no_json_schema.clear()
            answer, seen = self.call(lambda kw, r=reply: r if 'response_format' in kw else tool_call('{"items": []}'))
            self.assertEqual(answer, {'items': []})
            self.assertEqual(len(seen), 2)

    def test_a_provider_outage_still_moves_to_the_fallback_provider(self):
        seen = []

        def down(kw):
            raise ConnectionError('down')
        clients = [('gloo', 'gloo-openai-gpt-4.1-mini', {}, FakeClient(down, seen)),
                   ('ollama', 'qwen3', {}, FakeClient(lambda kw: tool_call('{"items": []}'), seen))]
        with mock.patch('backend.app.chat.make_clients', return_value=clients), \
                mock.patch.object(builder, 'builder_model', lambda name, m: m):
            self.assertEqual(builder._ai_complete_impl([], [STAFF], timeout=5), {'items': []})
        self.assertEqual([s['model'] for s in seen], ['gloo-openai-gpt-4.1-mini', 'qwen3'])
        self.assertNotIn('gloo-openai-gpt-4.1-mini', builder._no_json_schema)  # an outage is not a refusal

    def test_haiku_keeps_the_tool_call(self):
        answer, seen = self.call(lambda kw: tool_call('{"items": []}'), model='gloo-anthropic-claude-haiku-4.5')
        self.assertEqual(answer, {'items': []})
        self.assertNotIn('response_format', seen[0])
        self.assertEqual(seen[0]['tool_choice'], {'type': 'function', 'function': {'name': 'record_staff'}})


if __name__ == '__main__':
    unittest.main()
