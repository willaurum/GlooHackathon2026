"""Isaac's QA: greeters check in a planned guest, and the chat links to pages imported from the church website."""
from fastapi.testclient import TestClient

from backend.app import chat, main
from backend.tests.test_churches import ChurchTestCase


class WelcomeCheckInTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)

    def test_a_planned_guest_can_be_checked_in_then_claimed_and_met(self):
        info = self.client.get('/api/info').json()
        service = f"{info['services'][0]['day']} {info['services'][0]['time']}"
        visit = self.client.post('/api/visits', json={'name': 'Pat Example', 'contact': 'pat@example.org',
                                                        'service': service, 'party_size': 2, 'wants_host': True}).json()
        planned = self.client.get('/api/visits').json()['planned']
        self.assertIn(visit['visit_id'], [v['visit_id'] for v in planned])
        checked = self.client.post(f"/api/visits/{visit['visit_id']}/checkin")
        self.assertEqual(checked.status_code, 200, checked.text)
        self.assertEqual(checked.json()['status'], 'arrived')
        self.assertNotIn('token', checked.json())
        self.assertEqual(self.client.post(f"/api/visits/{visit['visit_id']}/checkin").status_code, 409)
        self.assertEqual(self.client.post(f"/api/visits/{visit['visit_id']}/claim", json={'host': 'Bob'}).json()['status'], 'on_the_way')
        self.assertEqual(self.client.post(f"/api/visits/{visit['visit_id']}/met").json()['status'], 'met')


class ImportedPageSuggestionTests(ChurchTestCase):
    def test_suggest_an_imported_page_by_its_slug(self):
        class Source:
            def list_content(self, kind):
                return [{'slug': 'riverstone-react', 'title': 'Riverstone react'}] if kind == 'pages' else []
        result = chat.suggest_page('imported', slug='riverstone-react', source=Source())
        self.assertEqual(result['slug'], 'riverstone-react')
        actions = []
        chat.collect_action(actions, 'suggest_page', result)
        self.assertEqual(actions, [{'tool': 'suggest_page', 'page': 'imported', 'slug': 'riverstone-react', 'title': 'Riverstone react'}])
        self.assertIn('error', chat.suggest_page('imported', slug='setup', source=Source()))
