import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend.app import main, recommendations


def provider(payload):
    client = MagicMock()
    client.with_options.return_value = client
    client.chat.completions.create.return_value = SimpleNamespace(choices=[
        SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))])
    return ('fake', 'test-model', {}, client)


class RecommendationTests(unittest.TestCase):
    def setUp(self):
        self.ministries = json.loads((Path(recommendations.__file__).parent / 'ministries.json').read_text(encoding='utf-8'))
        self.plan = {'summary': 'Here is a team to explore.', 'matches': [
            {'ministry_id': 1, 'reason': 'You enjoy welcoming people.', 'considerations': 'Confirm the Sunday schedule.'}]}

    def test_ai_order_and_catalog_contacts(self):
        self.plan['matches'].append({'ministry_id': 0, 'reason': 'You enjoy helping families.', 'considerations': 'Background check required.'})
        fake = provider(self.plan)
        result = recommendations.recommend('I enjoy welcoming families.', self.ministries, [fake])
        self.assertEqual([m['id'] for m in result['matches']], [1, 0])
        self.assertEqual(result['matches'][0]['email'], self.ministries[1]['email'])
        self.assertEqual(result['matches'][0]['head'], self.ministries[1]['head'])
        sent = fake[3].chat.completions.create.call_args.kwargs['messages']
        data = json.loads(sent[1]['content'])
        self.assertEqual(data['description'], 'I enjoy welcoming families.')
        self.assertNotIn('email', data['ministries'][0])

    def test_rejects_unknown_duplicate_and_full_ministries(self):
        self.ministries[0]['filled'] = self.ministries[0]['total']
        for ids in ([99], [1, 1], [0]):
            with self.subTest(ids=ids):
                plan = {'summary': 'Suggestions', 'matches': [
                    {**self.plan['matches'][0], 'ministry_id': key} for key in ids]}
                with self.assertLogs(recommendations.log, level='WARNING'), self.assertRaises(recommendations.Unavailable):
                    recommendations.recommend('Welcome people', self.ministries, [provider(plan)])

    def test_rejects_model_supplied_contacts_and_uses_fallback(self):
        bad = json.loads(json.dumps(self.plan))
        bad['matches'][0]['email'] = 'invented@example.com'
        with self.assertLogs(recommendations.log, level='WARNING'):
            result = recommendations.recommend('Welcome people', self.ministries, [provider(bad), provider(self.plan)])
        self.assertEqual(result['matches'][0]['email'], self.ministries[1]['email'])

    def test_failure_and_missing_configuration_do_not_use_rules(self):
        with self.assertRaises(recommendations.NotConfigured):
            recommendations.recommend('Welcome people', self.ministries, [])
        fake = provider(self.plan)
        fake[3].chat.completions.create.side_effect = TimeoutError()
        with self.assertLogs(recommendations.log, level='WARNING'), self.assertRaises(recommendations.Unavailable):
            recommendations.recommend('Welcome people', self.ministries, [fake])

    def test_empty_result_is_supported(self):
        result = recommendations.recommend('I can only serve on Tuesdays.', self.ministries, [
            provider({'summary': 'No current schedule fits. Please contact a team about other times.', 'matches': []})])
        self.assertEqual(result['matches'], [])

    def test_ollama_requests_structured_output_with_time_for_hpc(self):
        fake = provider(self.plan)
        recommendations.recommend('I welcome people.', self.ministries, [('ollama', 'gpt-oss:20b', {}, fake[3])])
        self.assertEqual(fake[3].with_options.call_args.kwargs['timeout'], 75)
        options = fake[3].chat.completions.create.call_args.kwargs
        self.assertEqual(options['response_format']['type'], 'json_schema')
        self.assertEqual(options['reasoning_effort'], 'low')

    def test_endpoint_accepts_paragraph_and_validates_oversized_input(self):
        client = TestClient(main.app)
        with patch.object(main.db, 'list_ministries', return_value=self.ministries), patch.object(
                recommendations.chat, 'make_clients', return_value=[provider(self.plan)]):
            response = client.post('/api/matches', json={'name': 'Jamie', 'description': ' I enjoy welcoming people. '})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['engine'], 'ai')
            self.assertEqual(response.json()['name'], 'Jamie')  # saving a connection needs it
            self.assertEqual(client.post('/api/matches', json={'description': 'x' * 4001}).status_code, 422)

    def test_endpoint_without_a_description_uses_rules(self):
        client = TestClient(main.app)
        with patch.object(main.db, 'list_ministries', return_value=self.ministries), patch.object(
                recommendations, 'recommend') as recommend:
            body = client.post('/api/matches', json={'skills': ['Music'], 'description': '   '}).json()
        recommend.assert_not_called()
        self.assertEqual(body['engine'], 'rules')
        self.assertTrue(body['matches'])

    def test_endpoint_falls_back_to_rules_without_ai_or_when_it_fails(self):
        # The live demo has no AI key, so Find a place must keep working without one.
        client = TestClient(main.app)
        with patch.object(main.db, 'list_ministries', return_value=self.ministries):
            for error, noted in [(recommendations.NotConfigured('Not configured'), False),
                                 (recommendations.Unavailable('Try again'), True)]:
                with patch.object(recommendations, 'recommend', side_effect=error):
                    response = client.post('/api/matches', json={'skills': ['Music'], 'description': 'My story'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['engine'], 'rules')
                self.assertEqual('note' in response.json(), noted)
