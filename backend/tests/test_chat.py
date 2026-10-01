import json
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app import chat


class ChatTests(unittest.TestCase):
    def setUp(self):
        directory = Path(chat.__file__).parent
        self.church = json.loads((directory / 'church.json').read_text(encoding='utf-8'))
        self.ministries = json.loads((directory / 'ministries.json').read_text(encoding='utf-8'))
        patches = {
            'get_church_info': {'return_value': self.church['info']},
            'list_content': {'side_effect': lambda kind: self.church[kind]},
            'list_ministries': {'return_value': self.ministries},
            'get_ministry': {'side_effect': lambda key: next((m for m in self.ministries if m['id'] == key), None)},
            'find_pending_request': {'return_value': None},
            'create_request': {'return_value': {'request_id': 42}},
            'log_chat': {},
        }
        self.mocks = {}
        for name, options in patches.items():
            patcher = patch.object(chat.db, name, **options)
            self.mocks[name] = patcher.start()
            self.addCleanup(patcher.stop)
        self.actions = []
        self.tools = chat.demo_tools('test', self.actions)

    def reply(self, text, history=None):
        return chat.demo_reply(text, self.tools, history)

    def test_starter_questions(self):
        self.assertIn('9:00am', self.reply('When are services?'))
        self.assertIn('open spots', self.reply('How can I get involved?'))
        self.assertIn('Young adults', self.reply('Are there small groups?'))

    def test_care_and_connection_take_precedence(self):
        self.assertIn('saved', self.reply('Help me, I am struggling').lower())
        self.assertEqual(self.mocks['create_request'].call_args.args[0], 'pastoral_care')
        self.assertIn('saved', self.reply('Connect me to Worship collective. My name is Jamie. jamie@example.com'))
        self.assertEqual(self.mocks['create_request'].call_args.args[0], 'connection')
        self.assertIn('Saved', self.reply('I have a prayer request'))
        self.assertEqual(self.mocks['create_request'].call_args.args[0], 'prayer')

    def test_connection_collects_details_over_three_turns(self):
        first = 'Connect me to Welcome team'
        prompt = self.reply(first)
        self.assertEqual(prompt, chat.CONNECTION_PROMPT)
        history = [{'role': 'user', 'content': first}, {'role': 'assistant', 'content': prompt}]
        second = 'My name is jamie parker'
        prompt = self.reply(second, history)
        self.assertEqual(prompt, chat.CONNECTION_PROMPT)
        self.mocks['create_request'].assert_not_called()
        history.extend([{'role': 'user', 'content': second}, {'role': 'assistant', 'content': prompt}])
        self.assertIn('saved', self.reply('jamie@example.com', history))
        args = self.mocks['create_request'].call_args.args
        self.assertEqual(args[:3], ('connection', 'jamie parker', 'jamie@example.com'))
        self.assertEqual(args[-1], 1)

    def test_connection_requires_a_name(self):
        self.assertEqual(self.reply('Connect me to Welcome team at jamie@example.com'), chat.CONNECTION_PROMPT)
        self.mocks['create_request'].assert_not_called()

    def test_canceled_or_completed_flow_does_not_replay(self):
        for last_reply in ('Okay, I will not save a connection request.', 'Your request is saved for staff review.'):
            history = [{'role': 'user', 'content': 'Connect me to Welcome team. My name is Jamie'},
                       {'role': 'assistant', 'content': last_reply}]
            self.reply('jamie@example.com', history)
        self.mocks['create_request'].assert_not_called()

    def test_cancel_and_topic_change_while_collecting(self):
        history = [{'role': 'user', 'content': 'Connect me to Welcome team'},
                   {'role': 'assistant', 'content': chat.CONNECTION_PROMPT}]
        self.assertIn('will not save', self.reply('cancel', history))
        self.assertIn('9:00am', self.reply('When are services?', history))
        self.mocks['create_request'].assert_not_called()

    def test_crisis_guidance_survives_storage_failure(self):
        self.mocks['create_request'].side_effect = RuntimeError('database unavailable')
        with self.assertLogs(chat.log, level='ERROR'):
            reply = self.reply('I want to die')
        self.assertIn('988', reply)
        self.assertIn("couldn't save", reply)
        self.assertEqual(self.actions, [])

    def test_handoff_is_saved_not_notified(self):
        result = chat.hand_off_to_staff('prayer', 'Please pray for my family')
        self.assertEqual(result['status'], 'pending_staff_review')
        self.assertIn('no notification', result['message'])
        self.assertNotIn('one business day', result['message'])

    @patch.dict('os.environ', {'AI_PROVIDER': 'gloo', 'OPENAI_API_KEY': 'unused-key'}, clear=True)
    def test_status_and_reply_agree_when_only_unused_provider_has_key(self):
        self.assertFalse(chat.status()['configured'])
        reply = chat.run([{'role': 'user', 'content': 'When are services?'}], 'test')
        self.assertEqual(reply['provider'], 'demo')
        self.assertIn('9:00am', reply['reply'])

    @patch.dict('os.environ', {'AI_PROVIDER': 'ollama', 'OLLAMA_MODEL': 'gpt-oss:20b',
                              'OLLAMA_BASE_URL': 'http://host.docker.internal:11434/v1'}, clear=True)
    def test_ollama_uses_configured_tunnel_without_api_key(self):
        self.assertEqual(chat.status(), {'configured': True, 'providers': ['ollama:gpt-oss:20b']})
        with patch('openai.OpenAI') as create:
            clients = chat.make_clients()
        self.assertEqual(len(clients), 1)
        self.assertEqual(create.call_args.kwargs['base_url'], 'http://host.docker.internal:11434/v1')
        self.assertEqual(create.call_args.kwargs['api_key'], 'ollama')

    @patch.dict('os.environ', {}, clear=True)
    def test_ollama_is_not_enabled_unless_selected(self):
        self.assertFalse(chat.status()['configured'])


if __name__ == '__main__':
    unittest.main()
