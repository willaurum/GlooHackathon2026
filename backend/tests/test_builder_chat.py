"""Public draft chat uses imported content and never files staff requests."""
import json
from types import SimpleNamespace
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, builder_export, chat, main
from backend.tests.test_builder_json_import import FILES
from backend.tests.test_churches import ChurchTestCase


class DraftChatTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        builder.import_limiter.reset()
        builder.draft_chat_limiter.reset()
        self.addCleanup(builder.import_limiter.reset)
        self.addCleanup(builder.draft_chat_limiter.reset)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        response = self.client.post('/api/builder/drafts/json', json=FILES)
        self.assertEqual(response.status_code, 201, response.text)
        self.path = '/api/builder/drafts/' + response.json()['id'] + '/chat'

    def ask(self, question, path=None):
        return self.client.post(path or self.path, json={'session_id': 'draft-test',
                                'messages': [{'role': 'user', 'content': question}]})

    def test_offline_and_failed_provider_replies_use_the_draft(self):
        with mock.patch.object(chat, 'provider_chain', return_value=[]):
            reply = self.ask('When are services?')
        self.assertEqual(reply.status_code, 200, reply.text)
        for text in ('Meadow Lantern Chapel', '10:00 AM', '123 Lantern Lane'):
            self.assertIn(text, reply.json()['reply'])
        self.assertNotIn('Grace Community', reply.text)
        with mock.patch.object(chat, 'provider_chain', return_value=[('fake', 'model', {}, 'key')]), \
             mock.patch.object(chat, 'make_clients', return_value=[('fake', 'model', {}, None)]), \
             mock.patch.object(chat, 'complete', side_effect=RuntimeError('offline')):
            reply = self.ask('What is your address?')
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertIn('123 Lantern Lane', reply.json()['reply'])
        self.assertNotIn('Grace Community', reply.text)

    def test_ai_tools_read_all_draft_sections_and_never_file_requests(self):
        content = builder_export.load(FILES)
        seen = {}

        def complete(clients, convo, session_id, final=False, source=None):
            if convo[-1]['role'] == 'user':
                tools = ['get_church_info', 'list_events', 'list_small_groups', 'search_ministries',
                         'list_staff', 'list_sermons', 'list_pages', 'request_connection', 'hand_off_to_staff']
                calls = [SimpleNamespace(id=name, function=SimpleNamespace(name=name, arguments='{}')) for name in tools]
                message = SimpleNamespace(content='', tool_calls=calls)
            else:
                seen.update({m['tool_call_id']: json.loads(m['content']) for m in convo if m['role'] == 'tool'})
                message = SimpleNamespace(content=seen['get_church_info']['church']['name'], tool_calls=[])
            return SimpleNamespace(choices=[SimpleNamespace(message=message)]), 'fake:model'

        with mock.patch.object(chat, 'provider_chain', return_value=[('fake', 'model', {}, 'key')]), \
             mock.patch.object(chat, 'make_clients', return_value=[('fake', 'model', {}, None)]), \
             mock.patch.object(chat, 'complete', side_effect=complete), \
             mock.patch.object(chat.db, 'create_request') as create, mock.patch.object(chat.db, 'log_chat') as log:
            reply = self.ask('Tell me about the church')
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(seen['get_church_info']['church'], content['info'])
        self.assertEqual(seen['get_church_info']['faqs'], content['faqs'])
        self.assertEqual(seen['get_church_info']['locations'][0]['name'], 'Meadow Hall')
        self.assertEqual(seen['list_events']['events'], content['events'])
        self.assertEqual(seen['list_small_groups']['groups'], content['groups'])
        self.assertEqual(seen['search_ministries']['ministries'][0]['name'], 'Welcome team')
        self.assertEqual(seen['list_staff']['staff'][0]['name'], 'Alex Example')
        self.assertEqual(seen['list_sermons']['sermons'][0]['title'], 'A welcoming place')
        self.assertEqual(seen['list_pages']['pages'], content['pages'])
        for tool in ('request_connection', 'hand_off_to_staff'):
            self.assertEqual(seen[tool], {'message': chat.PREVIEW_REQUEST})
        self.assertEqual(reply.json()['actions'], [])
        create.assert_not_called()
        log.assert_not_called()

    def test_offline_requests_do_not_collect_or_save_contact_details(self):
        with mock.patch.object(chat, 'provider_chain', return_value=[]), \
             mock.patch.object(chat.db, 'create_request') as create:
            for question in ('Connect me to Welcome team', 'I have a prayer request', 'I want to die'):
                reply = self.ask(question)
                self.assertEqual(reply.status_code, 200, reply.text)
                self.assertIn(chat.PREVIEW_REQUEST, reply.json()['reply'])
                self.assertEqual(reply.json()['actions'], [])
        create.assert_not_called()

    def test_unknown_draft_limits_and_request_validation(self):
        self.assertEqual(self.ask('Hello', '/api/builder/drafts/' + 'x' * 24 + '/chat').status_code, 404)
        self.assertEqual(self.ask('x' * 2001).status_code, 422)
        self.assertEqual(self.client.post(self.path, json={'session_id': 'test', 'messages':
                         [{'role': 'user', 'content': 'Hello'}] * 41}).status_code, 422)
        self.assertEqual(self.client.post(self.path, json={'session_id': 'test', 'messages':
                         [{'role': 'assistant', 'content': 'Hello'}]}).status_code, 400)
        with mock.patch.object(builder, 'IMPORTS_PER_ADDRESS', 1), mock.patch.object(chat, 'provider_chain', return_value=[]):
            self.assertEqual(self.ask('Hello').status_code, 200)
            self.assertEqual(self.ask('Hello').status_code, 429)
