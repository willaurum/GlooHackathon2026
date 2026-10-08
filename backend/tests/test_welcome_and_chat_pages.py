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

    def test_a_guest_who_never_signed_up_is_checked_in_by_name(self):
        checked = self.client.post('/api/visits/new/checkin', json={'name': '  Sam   Newcomer '})
        self.assertEqual(checked.status_code, 201, checked.text)
        visit = checked.json()
        self.assertEqual((visit['name'], visit['status'], visit['service'], visit['party_size']),
                         ('Sam Newcomer', 'arrived', 'Walk-in', 1))
        self.assertTrue(visit['arrived_at'])
        self.assertNotIn('token', visit)
        # It persists: the walk-in is in the waiting queue, ready to be claimed, and not on the planned list.
        queue = self.client.get('/api/visits').json()
        self.assertIn(visit['visit_id'], [v['visit_id'] for v in queue['waiting']])
        self.assertNotIn(visit['visit_id'], [v['visit_id'] for v in queue['planned']])
        self.assertEqual(self.client.post(f"/api/visits/{visit['visit_id']}/claim", json={'host': 'Bob'}).json()['status'], 'on_the_way')
        self.assertEqual(self.client.post('/api/visits/new/checkin', json={'name': 'Kim', 'party_size': 3}).json()['party_size'], 3)

    def test_a_walk_in_needs_a_name(self):
        for body in ({}, {'name': ''}, {'name': '   '}, {'name': 'x' * 101}, {'name': 'Kim', 'party_size': 0}):
            self.assertEqual(self.client.post('/api/visits/new/checkin', json=body).status_code, 422, body)
        self.assertEqual(self.client.get('/api/visits').json()['waiting'], [])


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
