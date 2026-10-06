"""The team AI bridge (scripts/team-ai-bridge, api/teamai.ts): provider selection and graceful fallback."""
import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
from fastapi.testclient import TestClient

from backend.app import ai_client, chat, main, recommendations

# What api/teamai.ts puts in the container once TEAM_AI_URL and TEAM_AI_KEY are set.
BRIDGE = {'AI_PROVIDER': 'gloo', 'AI_FALLBACK': 'ollama', 'OLLAMA_BASE_URL': 'http://team-ai/v1',
          'OLLAMA_MODEL': 'qwen3.8:27b', 'TEAM_AI_BRIDGE': '1'}
GLOO = {**BRIDGE, 'GLOO_API_KEY': 'gloo-test-key'}


def failing_client():
    client = MagicMock()
    client.with_options.return_value = client
    client.chat.completions.create.side_effect = ConnectionError('bridge down')
    return client


class ProviderSelectionTests(unittest.TestCase):
    def setUp(self):
        ai_client._status_cache = None
        ai_client._active_model = None

    @patch.dict('os.environ', BRIDGE, clear=True)
    def test_bridge_is_used_until_gloo_key_is_set(self):
        self.assertEqual(chat.status(), {'configured': True, 'providers': ['ollama:qwen3.8:27b']})
        with patch('openai.OpenAI') as create:
            chat.make_clients()
        self.assertEqual(create.call_args.kwargs['base_url'], 'http://team-ai/v1')
        self.assertEqual(create.call_args.kwargs['timeout'], 90)
        target = ai_client.endpoint()
        self.assertEqual((target['provider'], target['base_url'], target['model'], target['api_key']),
                         ('ollama', 'http://team-ai/v1', 'qwen3.8:27b', ''))

    @patch.dict('os.environ', GLOO, clear=True)
    def test_setting_gloo_key_switches_everything_to_gloo(self):
        self.assertEqual(chat.status()['providers'], ['gloo:gloo-qwen-3.7-flash', 'ollama:qwen3.8:27b'])
        target = ai_client.endpoint()
        self.assertEqual(target['provider'], 'gloo')
        self.assertEqual(target['base_url'], 'https://platform.ai.gloo.com/ai/v2/guarded')
        self.assertEqual(target['api_key'], 'gloo-test-key')
        self.assertEqual(target['extra_body'], {'auto_routing': False})

    @patch.dict('os.environ', {'AI_BASE_URL': 'http://host.docker.internal:11434', 'AI_MODEL': 'llama3:8b',
                               'AI_PROVIDER': 'ollama'}, clear=True)
    def test_explicit_calendar_url_still_wins_for_local_setups(self):
        target = ai_client.endpoint()
        self.assertEqual((target['provider'], target['base_url'], target['model']),
                         ('custom', 'http://host.docker.internal:11434', 'llama3:8b'))

    @patch.dict('os.environ', {}, clear=True)
    def test_nothing_configured_means_local_ollama_default(self):
        target = ai_client.endpoint()
        self.assertEqual((target['provider'], target['base_url'], target['model']),
                         ('local', 'http://127.0.0.1:11434', 'qwen3.8:27b'))

    def test_timeouts_suit_a_slow_model_but_stay_under_cloudflare_limit(self):
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(chat.provider_timeout('ollama'), 90)
            self.assertEqual(chat.provider_timeout('gloo'), 60)
        with patch.dict('os.environ', {'OLLAMA_TIMEOUT': '500'}, clear=True):
            self.assertEqual(chat.provider_timeout('ollama'), 95)
        with patch.dict('os.environ', {'OLLAMA_TIMEOUT': 'soon'}, clear=True):
            self.assertEqual(chat.provider_timeout('ollama'), 90)


class FallbackTests(unittest.TestCase):
    def setUp(self):
        ai_client._status_cache = None
        ai_client._active_model = None
        church = json.loads((Path(chat.__file__).parent / 'church.json').read_text(encoding='utf-8'))
        self.ministries = json.loads((Path(chat.__file__).parent / 'ministries.json').read_text(encoding='utf-8'))
        patches = {
            'get_church_info': {'return_value': church['info']},
            'list_content': {'side_effect': lambda kind: church[kind]},
            'list_ministries': {'return_value': self.ministries},
            'log_chat': {},
        }
        for name, options in patches.items():
            patcher = patch.object(chat.db, name, **options)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_chat_answers_with_demo_replies_when_the_bridge_is_down(self):
        clients = [('ollama', 'qwen3.8:27b', {}, failing_client())]
        with self.assertLogs(chat.log, level='WARNING'):
            result = chat.run([{'role': 'user', 'content': 'When are services?'}], 'test', clients=clients)
        self.assertEqual(result['provider'], 'demo')
        self.assertTrue(result['offline'])
        self.assertIn('9:00am', result['reply'])

    def test_chat_uses_the_bridge_when_gloo_fails(self):
        working = MagicMock()
        working.chat.completions.create.return_value = SimpleNamespace(choices=[
            SimpleNamespace(message=SimpleNamespace(content='Hello from the HPC.', tool_calls=[]))])
        clients = [('gloo', 'haiku', {}, failing_client()), ('ollama', 'qwen3.8:27b', {}, working)]
        result = chat.run([{'role': 'user', 'content': 'Hello'}], 'test', clients=clients)
        self.assertEqual((result['reply'], result['provider']), ('Hello from the HPC.', 'ollama:qwen3.8:27b'))

    def test_find_a_place_gives_a_friendly_message_when_the_bridge_is_down(self):
        with self.assertLogs(recommendations.log, level='WARNING'), self.assertRaises(recommendations.Unavailable) as caught:
            recommendations.recommend('I like welcoming people.', self.ministries,
                                      [('ollama', 'qwen3.8:27b', {}, failing_client())])
        self.assertIn('browse Ministries', str(caught.exception))

    @patch.dict('os.environ', {**BRIDGE, 'OLLAMA_BASE_URL': 'http://127.0.0.1:9/v1'}, clear=True)
    def test_status_reports_offline_and_caches_it(self):
        status = asyncio.run(ai_client.get_status())
        self.assertFalse(status['connected'])
        self.assertEqual(status['provider'], 'ollama')
        with patch.object(ai_client, '_probe') as probe:
            asyncio.run(ai_client.get_status())
        probe.assert_not_called()

    @patch.dict('os.environ', BRIDGE, clear=True)
    def test_calendar_summary_returns_503_when_the_bridge_is_down(self):
        offline = {'connected': False, 'provider': 'ollama', 'default_model': 'qwen3.8:27b', 'available_models': []}
        client = TestClient(main.app)
        with patch.object(main.db, 'get_event', return_value={'id': 1}), \
                patch.object(main.ai_client, 'get_status', return_value=offline):
            response = client.post('/api/events/1/summarize')
        self.assertEqual(response.status_code, 503)
        self.assertIn('offline', response.json()['detail'])

    @patch.dict('os.environ', BRIDGE, clear=True)
    def test_ai_status_endpoint_tells_the_team_what_is_used(self):
        reachable = {'connected': True, 'provider': 'ollama', 'default_model': 'qwen3.8:27b', 'available_models': ['qwen3.8:27b']}
        with patch.object(main.ai_client, 'get_status', return_value=reachable):
            body = TestClient(main.app).get('/api/ai/status').json()
        self.assertTrue(body['connected'])
        self.assertTrue(body['team_bridge'])
        self.assertEqual(body['chat']['providers'], ['ollama:qwen3.8:27b'])


class CalendarSummaryTests(unittest.TestCase):
    def setUp(self):
        ai_client._status_cache = None
        ai_client._active_model = None
        self.event = dict(title='Serve Day', category='Outreach', description='Help neighbors.',
                          date='2026-10-10', time='9:00 AM', location='Fellowship hall')

    def summarize(self, handler):
        seen = []

        def record(request):
            seen.append(request)
            return handler(request)

        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
                return await ai_client.summarize_event(**self.event, client=client)
        return go, seen

    @patch.dict('os.environ', GLOO, clear=True)
    def test_gloo_summary_uses_the_chat_url_and_routing_flag(self):
        reply = {'choices': [{'message': {'content': 'Come serve with us. Everyone is welcome.'}}]}
        go, seen = self.summarize(lambda request: httpx.Response(200, json=reply))
        self.assertEqual(asyncio.run(go()), 'Come serve with us. Everyone is welcome.')
        self.assertEqual(str(seen[0].url), 'https://platform.ai.gloo.com/ai/v2/guarded/chat/completions')
        self.assertFalse(json.loads(seen[0].content)['auto_routing'])

    @patch.dict('os.environ', BRIDGE, clear=True)
    def test_a_timeout_is_not_retried_on_other_endpoints(self):
        connected = {'connected': True, 'provider': 'ollama', 'default_model': 'qwen3.8:27b', 'available_models': ['qwen3.8:27b']}

        def slow(request):
            raise httpx.ReadTimeout('slow model', request=request)
        go, seen = self.summarize(slow)
        with patch.object(ai_client, 'get_status', return_value=connected), self.assertRaises(RuntimeError):
            asyncio.run(go())
        self.assertEqual([r.url.path for r in seen], ['/v1/chat/completions'])

    @patch.dict('os.environ', BRIDGE, clear=True)
    def test_native_fallback_goes_beside_v1_not_under_it(self):
        connected = {'connected': True, 'provider': 'ollama', 'default_model': 'qwen3.8:27b', 'available_models': ['qwen3.8:27b']}

        def only_native(request):
            if request.url.path == '/api/generate':
                return httpx.Response(200, json={'response': 'A day to serve together.'})
            return httpx.Response(404)
        go, seen = self.summarize(only_native)
        with patch.object(ai_client, 'get_status', return_value=connected):
            self.assertEqual(asyncio.run(go()), 'A day to serve together.')
        self.assertEqual([r.url.path for r in seen], ['/v1/chat/completions', '/api/generate'])


if __name__ == '__main__':
    unittest.main()
