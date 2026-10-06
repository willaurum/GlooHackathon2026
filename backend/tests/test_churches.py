"""Every church has its own database: isolation, the demo default, new churches and content import.

The Durable Object databases are replaced by in-memory SQLite, one per X-Church header,
so these run without Cloudflare. Staff-only access is enforced by the Worker
(api/churches.ts) and is tested in api/test/churches.test.mjs.
"""

import json
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import church_content, db, main

APP = Path(__file__).resolve().parents[1] / 'app'


class FakeDurableObjects:
    """POST /sql like the ChurchDB Durable Object, with one SQLite database per church."""

    def __init__(self):
        self.databases = {}
        self.seen = []

    def post(self, path, json, headers):
        slug = headers['X-Church']
        self.seen.append(slug)
        conn = self.databases.setdefault(slug, sqlite3.connect(':memory:', check_same_thread=False))
        conn.row_factory = sqlite3.Row
        results = []
        with conn:
            for statement in json['batch']:
                cursor = conn.execute(statement['sql'], statement['params'])
                rows = [dict(row) for row in cursor.fetchall()]
                results.append({'rows': rows, 'rowsWritten': max(cursor.rowcount, 0)})
        return mock.Mock(raise_for_status=lambda: None, json=lambda: {'results': results})


class ChurchTestCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeDurableObjects()
        patcher = mock.patch.object(db, '_client', self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        db._ready.clear()
        self.addCleanup(db._ready.clear)


class DatabaseScopeTests(ChurchTestCase):
    def test_no_church_is_the_demo_church_with_its_seed(self):
        self.assertEqual(db.current_church(), db.DEMO_CHURCH)
        self.assertEqual(db.get_church_info()['name'], 'Grace Community Church')
        self.assertEqual(len(db.list_ministries()), 6)
        self.assertEqual(set(self.fake.seen), {db.DEMO_CHURCH})

    def test_new_church_starts_empty_with_its_name(self):
        with db.use_church('hope-chapel', 'Hope Chapel', 'Austin, TX'):
            info = db.get_church_info()
            self.assertEqual((info['name'], info['city'], info['services']), ('Hope Chapel', 'Austin, TX', []))
            self.assertEqual(db.get_config()['name'], 'Hope Chapel')
            for empty in (db.list_ministries(), db.list_events(), db.list_content('faqs'), db.list_regions(),
                          db.list_notes(), db.list_requests(), db.list_connections()):
                self.assertEqual(empty, [])
        self.assertIn('hope-chapel', db.ready_churches())

    def test_churches_never_see_each_other(self):
        with db.use_church('hope-chapel', 'Hope Chapel'):
            hope_visit = db.create_visit('Sam Rivera', 'sam@example.com', 'Sunday 10:00am', 2, '', True)
            db.mark_arrived(hope_visit['token'])
            db.create_request('prayer', 'Sam Rivera', 'sam@example.com', 'Please pray for my family.')
            db.log_chat('session-1', 'user', {'content': 'hello'})
            db.create_note('11111111-1111-1111-1111-111111111111', 'Hope sermon', 'youtube', 'https://www.youtube.com/watch?v=abcdefghijk')
        # The demo church sees none of it, by id or by token.
        self.assertIsNone(db.get_visit_by_token(hope_visit['token']))
        self.assertEqual(db.list_visits(['arrived']), [])
        self.assertEqual(db.list_requests(), [])
        self.assertEqual(db.get_chat_log('session-1'), [])
        self.assertIsNone(db.get_note('11111111-1111-1111-1111-111111111111'))
        self.assertIsNone(db.set_visit_host(hope_visit['visit_id'], 'Greeter'))
        grace_visit = db.create_visit('Alex Doe', '', 'Sunday 9:00am', 1, '', True)
        with db.use_church('second-church', 'Second Church'):
            self.assertIsNone(db.get_visit_by_token(grace_visit['token']))
            self.assertEqual(db.list_visits(['planned']), [])
            self.assertIsNone(db.get_note('11111111-1111-1111-1111-111111111111'))
        with db.use_church('hope-chapel'):
            self.assertEqual([v['name'] for v in db.list_visits(['arrived'])], ['Sam Rivera'])
            self.assertEqual(len(db.list_requests()), 1)

    def test_every_call_names_its_church(self):
        with db.use_church('hope-chapel', 'Hope Chapel'):
            db.list_ministries()
        db.list_ministries()
        self.assertEqual(self.fake.seen[-1], db.DEMO_CHURCH)
        self.assertIn('hope-chapel', self.fake.seen)
        self.assertEqual(set(self.fake.databases), {'hope-chapel', db.DEMO_CHURCH})


def demo_seed_document():
    """The demo church seed files, combined into the import shape."""
    church = json.loads((APP / 'church.json').read_text(encoding='utf-8'))
    return {**church, 'ministries': json.loads((APP / 'ministries.json').read_text(encoding='utf-8')),
            'calendar': json.loads((APP / 'events.json').read_text(encoding='utf-8'))}


class ContentImportTests(ChurchTestCase):
    def test_the_demo_seed_files_are_a_valid_import(self):
        body = church_content.ChurchContent.model_validate(demo_seed_document())
        content = church_content.normalize(body)
        self.assertEqual(len(content['ministries']), 6)
        self.assertEqual(content['info']['name'], 'Grace Community Church')

    def test_import_fills_a_new_church_and_leaves_others_alone(self):
        document = demo_seed_document()
        document['info'] = {**document['info'], 'name': 'Hope Chapel', 'city': 'Austin, TX'}
        content = church_content.normalize(church_content.ChurchContent.model_validate(document))
        with db.use_church('hope-chapel', 'Hope Chapel'):
            saved = db.replace_content(content)
            self.assertEqual(saved['info']['name'], 'Hope Chapel')
            self.assertEqual(db.get_config()['name'], 'Hope Chapel')
            self.assertEqual(len(db.list_ministries()), 6)
            self.assertEqual(len(db.list_events()), len(document['calendar']))
            # Replacing one section keeps the rest; ids are filled in.
            db.replace_content(church_content.normalize(church_content.ChurchContent.model_validate(
                {'faqs': [{'question': 'Is there parking?', 'answer': 'Yes, behind the building.'}]})))
            self.assertEqual(db.list_content('faqs'), [{'id': 0, 'question': 'Is there parking?', 'answer': 'Yes, behind the building.'}])
            self.assertEqual(len(db.list_ministries()), 6)
        with db.use_church('other-church', 'Other Church'):
            self.assertEqual(db.list_ministries(), [])
        self.assertEqual(db.get_church_info()['name'], 'Grace Community Church')
        self.assertEqual(len(db.list_content('faqs')), 6)

    def test_a_team_without_a_schedule_keeps_its_helpers_needed(self):
        with db.use_church('hope-chapel', 'Hope Chapel'):
            db.replace_content(church_content.normalize(church_content.ChurchContent.model_validate(
                {'ministries': [{'name': 'Greeters', 'total': 6}]})))
            self.assertEqual((db.list_ministries()[0]['filled'], db.list_ministries()[0]['total']), (0, 6))

    def test_a_team_with_saved_connections_is_kept(self):
        with db.use_church('hope-chapel', 'Hope Chapel'):
            two = {'ministries': [{'name': 'Greeters'}, {'name': 'Coffee'}]}
            db.replace_content(church_content.normalize(church_content.ChurchContent.model_validate(two)))
            db.save_connection(1, 'Sam Rivera')
            db.replace_content(church_content.normalize(church_content.ChurchContent.model_validate({'ministries': []})))
            self.assertEqual([m['name'] for m in db.list_ministries()], ['Coffee'])

    def test_bad_content_is_rejected(self):
        for bad in ({'info': {'name': ''}}, {'faqs': [{'question': 'Q'}]}, {'calendar': [{'title': 'X', 'date': 'soon'}]},
                    {'ministries': [{'name': 'A', 'shifts': [{'date': '2026-10-11', 'start_time': '25:00', 'end_time': '10:00'}]}]},
                    {'faqs': [{'id': 1, 'question': 'A', 'answer': 'B'}, {'id': 1, 'question': 'C', 'answer': 'D'}]},
                    {'unknown': []}):
            with self.subTest(bad=bad):
                with self.assertRaises((ValueError, church_content.ContentError)):
                    church_content.normalize(church_content.ChurchContent.model_validate(bad))


class HttpScopeTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)  # no lifespan: no notes worker thread

    def hope(self, **headers):
        return {'X-Church': 'hope-chapel', 'X-Church-Name': 'Hope%20Chapel', 'X-Church-City': 'Austin', **headers}

    def test_requests_without_a_church_are_the_demo_church(self):
        response = self.client.get('/api/info')
        self.assertEqual(response.json()['name'], 'Grace Community Church')

    def test_x_church_picks_the_database(self):
        self.assertEqual(self.client.get('/api/info', headers=self.hope()).json()['name'], 'Hope Chapel')
        self.assertEqual(self.client.get('/api/ministries', headers=self.hope()).json(), [])
        self.assertEqual(len(self.client.get('/api/ministries').json()), 6)

    def test_visit_sign_up_uses_that_church_service_times(self):
        self.assertEqual(self.client.post('/api/visits', headers=self.hope(), json={
            'name': 'Sam', 'service': 'Sunday 9:00am', 'party_size': 1}).status_code, 400)
        content = {'info': {'name': 'Hope Chapel', 'services': [{'day': 'Sunday', 'time': '10:00am'}]}}
        self.assertEqual(self.client.put('/api/church/content', headers=self.hope(), json=content).status_code, 200)
        created = self.client.post('/api/visits', headers=self.hope(), json={'name': 'Sam', 'service': 'Sunday 10:00am', 'party_size': 1})
        self.assertEqual(created.status_code, 201)
        token = created.json()['token']
        self.assertEqual(self.client.get('/api/visits/' + token).status_code, 404)
        self.assertEqual(self.client.get('/api/visits/' + token, headers=self.hope()).status_code, 200)

    def test_a_malformed_church_is_refused(self):
        self.assertEqual(self.client.get('/api/info', headers={'X-Church': '../main'}).status_code, 400)

    def test_content_round_trip(self):
        put = self.client.put('/api/church/content', headers=self.hope(), json={'faqs': [{'question': 'Parking?', 'answer': 'Free lot.'}]})
        self.assertEqual(put.status_code, 200)
        self.assertEqual(self.client.get('/api/church/content', headers=self.hope()).json()['faqs'][0]['answer'], 'Free lot.')
        self.assertEqual(self.client.put('/api/church/content', headers=self.hope(), json={'faqs': [{'answer': 'x'}]}).status_code, 422)


if __name__ == '__main__':
    unittest.main()
