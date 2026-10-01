import json
from datetime import date
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
        clock = patch('backend.app.eligibility.date', wraps=date)
        clock.start().today.return_value = date(2026, 9, 30)
        self.addCleanup(clock.stop)
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
        self.assertEqual(data['ministries'][1]['shifts'], self.ministries[1]['shifts'])
        self.assertEqual(result['matches'][0]['shifts'], self.ministries[1]['shifts'])

    def test_rejects_unknown_duplicate_and_full_ministries(self):
        self.ministries[0]['filled'] = self.ministries[0]['total']
        for shift in self.ministries[0]['shifts']:
            shift['filled'] = shift['total']
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

    def test_endpoint_accepts_paragraph_and_rejects_oversized_input(self):
        client = TestClient(main.app)
        with patch.object(main.db, 'list_ministries', return_value=self.ministries), patch.object(
                recommendations.chat, 'make_clients', return_value=[provider(self.plan)]):
            response = client.post('/api/matches', json={'description': ' I enjoy welcoming people. '})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['engine'], 'ai')
        for description in ('x' * 4001,):
            self.assertEqual(client.post('/api/matches', json={'description': description}).status_code, 422)

    def test_endpoint_reports_unconfigured_and_provider_errors(self):
        client = TestClient(main.app)
        with patch.object(main.db, 'list_ministries', return_value=self.ministries):
            for error, code in [(recommendations.NotConfigured('Not configured'), 503),
                                (recommendations.Unavailable('Try again'), 502)]:
                with patch.object(recommendations, 'recommend', side_effect=error):
                    self.assertEqual(client.post('/api/matches', json={'description': 'My story'}).status_code, code)


    def test_endpoint_passes_structured_preferences_to_ai(self):
        client = TestClient(main.app)
        fake = provider(self.plan)
        preferences = {'availability': [{'day': 'Sunday', 'start_time': '08:00', 'end_time': '13:00'}],
                       'preferred_service': 'sunday-9', 'frequency': 'monthly',
                       'earliest_start_date': '2026-10-11'}
        with patch.object(main.db, 'list_ministries', return_value=self.ministries), patch.object(
                recommendations.chat, 'make_clients', return_value=[fake]):
            response = client.post('/api/matches', json={'description': 'I like welcoming people.', 'preferences': preferences})
        self.assertEqual(response.status_code, 200)
        sent = json.loads(fake[3].chat.completions.create.call_args.kwargs['messages'][1]['content'])
        self.assertEqual(sent['preferences'], {**preferences, 'days_and_times': '', 'unavailable_requirements': []})
        self.assertEqual([s['id'] for s in response.json()['matches'][0]['shifts']], ['1-1'])

    def test_endpoint_accepts_unspecified_preferences(self):
        client = TestClient(main.app)
        with patch.object(main.db, 'list_ministries', return_value=self.ministries), patch.object(
                recommendations, 'recommend', return_value={'matches': [], 'summary': 'Confirm your schedule.'}) as recommend:
            response = client.post('/api/matches', json={'description': 'I enjoy music', 'preferences': {
                'days_and_times': '', 'preferred_service': '', 'frequency': None, 'earliest_start_date': None}})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(recommend.call_args.kwargs['preferences']['frequency'])
        self.assertIsNone(recommend.call_args.kwargs['preferences']['earliest_start_date'])

    def test_endpoint_rejects_invalid_preferences_before_ai(self):
        client = TestClient(main.app)
        for preferences in ({'frequency': 'daily'}, {'earliest_start_date': '2026-02-30'},
                            {'days_and_times': 'x' * 501}, {'preferred_service': 'x' * 201}):
            with self.subTest(preferences=preferences), patch.object(recommendations, 'recommend') as recommend:
                response = client.post('/api/matches', json={'description': 'I enjoy music', 'preferences': preferences})
                self.assertEqual(response.status_code, 422)
                recommend.assert_not_called()


    def test_filtered_ministry_id_from_model_is_rejected(self):
        fake = provider(self.plan)  # Welcome team cannot fit a Tuesday window.
        prefs = {'availability': [{'day': 'Tuesday', 'start_time': '18:00', 'end_time': '20:00'}]}
        with self.assertLogs(recommendations.log, level='WARNING'), self.assertRaises(recommendations.Unavailable):
            recommendations.recommend('Welcome people', self.ministries, [fake], preferences=prefs)
        catalog = json.loads(fake[3].chat.completions.create.call_args.kwargs['messages'][1]['content'])['ministries']
        self.assertEqual([m['id'] for m in catalog], [5])

    def test_no_eligible_shifts_skips_ai(self):
        with patch.object(recommendations.chat, 'make_clients') as make_clients:
            result = recommendations.recommend('Welcome people', self.ministries,
                preferences={'earliest_start_date': '2026-11-01'})
        self.assertEqual(result['engine'], 'eligibility')
        self.assertEqual(result['matches'], [])
        make_clients.assert_not_called()

    def test_invalid_time_windows_rejected(self):
        client = TestClient(main.app)
        for start, end in [('10:30', '08:30'), ('08:30', '08:30'), ('25:00', '26:00')]:
            response = client.post('/api/matches', json={'description': 'Welcome people', 'preferences': {
                'availability': [{'day': 'Sunday', 'start_time': start, 'end_time': end}]}})
            self.assertEqual(response.status_code, 422)


    def test_optional_answers_can_be_skipped_without_ai(self):
        client = TestClient(main.app)
        for payload in ({}, {'description': ''}, {'description': '   '}):
            with self.subTest(payload=payload), patch.object(main.db, 'list_ministries', return_value=self.ministries), patch.object(
                    recommendations.chat, 'make_clients') as make_clients:
                response = client.post('/api/matches', json=payload)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['engine'], 'browse')
            self.assertEqual(len(response.json()['matches']), len(self.ministries))
            self.assertEqual(response.json()['matches'][0]['email'], self.ministries[0]['email'])
            make_clients.assert_not_called()

    def test_general_availability_alone_is_sent_as_context(self):
        client = TestClient(main.app)
        fake = provider(self.plan)
        with patch.object(main.db, 'list_ministries', return_value=self.ministries), patch.object(
                recommendations.chat, 'make_clients', return_value=[fake]):
            response = client.post('/api/matches', json={'description': 'General availability: Occasional Sundays, still figuring it out.'})
        self.assertEqual(response.status_code, 200)
        sent = json.loads(fake[3].chat.completions.create.call_args.kwargs['messages'][1]['content'])
        self.assertIn('Occasional Sundays', sent['description'])
