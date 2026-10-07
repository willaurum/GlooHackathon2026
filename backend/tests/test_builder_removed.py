"""What the fact check removed stays on the draft, and the church can add it back ("Add it anyway").

    python -m unittest backend.tests.test_builder_removed
"""
import os
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, builder_json, builder_run, main
from backend.tests.test_builder import site
from backend.tests.test_churches import ChurchTestCase


def reader(messages, tools):
    """An AI stand-in that gets some facts wrong: the fact check removes each of these."""
    if tools[0]['function']['name'] == 'record_church_facts':
        return {'facts': [
            {'field': 'about', 'value': 'A friendly church in Millbrook', 'quote': 'We are the friendliest church in Virginia.'},
            {'field': 'name', 'value': 'Cedar Hollow Bible Church', 'quote': 'Welcome Home!'},
            {'field': 'office_hours', 'value': 'Sundays 9:00 AM', 'quote': 'Join us every Sunday for worship at 9:00 AM'},
        ]}
    return {'items': [{'name': 'Invented Person', 'role': 'Pastor', 'kind': 'ministry', 'quote': 'Invented Person, Pastor'}]}


class RemovedTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        run, token = builder_run.start()
        try:
            with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
                session = builder.new_session('https://church.test/', fetch=site('cedar-hollow-millbrook'),
                                              complete=reader, describe=False)
        finally:
            builder_run.finish(token)
        builder._save(session)
        self.sid = session['id']

    def draft(self):
        return self.client.get('/api/builder/drafts/' + self.sid).json()

    def removed(self, field):
        return next(e for e in self.draft()['removed'] if e['field'] == field)

    def add(self, removed_id):
        return self.client.post(f'/api/builder/drafts/{self.sid}/removed/{removed_id}/add')

    def test_removed_claims_are_kept_with_reason_and_source(self):
        removed = {e['field']: e for e in self.draft()['removed']}
        self.assertEqual(removed['about']['reason'], 'its quote is not on the page')
        self.assertEqual(removed['name']['reason'], 'its quote does not name the church')
        self.assertEqual(removed['office_hours']['reason'], 'not office hours')
        self.assertEqual(removed['about']['source'], {'title': 'Cedar Hollow Community Church | Millbrook, VA',
                                                      'url': 'https://church.test/'})
        self.assertEqual(removed['about']['quote'], 'We are the friendliest church in Virginia.')
        items = [e for e in removed.values() if e['kind'] == 'item']
        self.assertTrue(items and items[0]['value']['name'] == 'Invented Person', removed)
        self.assertTrue(all(set(e) == {'id', 'kind', 'field', 'value', 'reason', 'quote', 'source'} for e in removed.values()))
        self.assertEqual(len({(e['field'], str(e['value'])) for e in self.draft()['removed']}), len(self.draft()['removed']))

    def test_adding_fills_an_empty_field_as_the_churchs(self):
        entry = self.removed('office_hours')
        draft = self.add(entry['id']).json()
        self.assertEqual(draft['fields']['office_hours']['status'], 'confirmed')
        self.assertEqual(draft['fields']['office_hours']['value'], 'Sundays 9:00 AM')
        self.assertNotIn(entry['id'], [e['id'] for e in draft['removed']])
        session = builder._load(self.sid)
        self.assertEqual(builder.provenance(session)['info']['office_hours'][0]['title'], 'You confirmed this')

    def test_adding_a_list_item_marks_it_added_by_the_church(self):
        entry = next(e for e in self.draft()['removed'] if e['kind'] == 'item')
        draft = self.add(entry['id']).json()
        added = next(e for e in draft['collections'][entry['field']] if e['value']['name'] == 'Invented Person')
        self.assertTrue(added['include'])
        self.assertEqual(added['evidence'], [])
        session = builder._load(self.sid)
        key = 'invented person'
        self.assertEqual(builder.provenance(session)['items'][entry['field']][key][0]['title'], 'You added this')
        self.assertTrue(builder_json.check(session)['valid'])
        self.assertEqual(self.add(entry['id']).status_code, 404)  # once added, it is no longer in the list

    def test_a_confirmed_value_is_never_overwritten(self):
        self.assertEqual(self.client.post(f'/api/builder/drafts/{self.sid}/answers',
                                          json={'field': 'name', 'value': 'Cedar Hollow Community Church'}).status_code, 200)
        draft = self.add(self.removed('name')['id']).json()
        question = next(q for q in draft['questions'] if q['field'] == 'name')
        self.assertEqual([c['value'] for c in question['candidates']], ['Cedar Hollow Community Church', 'Cedar Hollow Bible Church'])
        self.assertEqual([c['evidence'][0]['title'] for c in question['candidates']], ['You confirmed this', 'You added this'])
        self.assertEqual(draft['status'], 'clarifying')
        draft = self.client.post(f'/api/builder/drafts/{self.sid}/answers',
                                 json={'field': 'name', 'value': 'Cedar Hollow Community Church'}).json()
        self.assertEqual(draft['fields']['name']['value'], 'Cedar Hollow Community Church')

    def test_unknown_ids_and_drafts_that_are_importing(self):
        self.assertEqual(self.add('r999').status_code, 404)
        self.assertEqual(self.client.post('/api/builder/drafts/' + 'x' * 24 + '/removed/r1/add').status_code, 404)
        session = builder._load(self.sid)
        session['status'] = 'importing'
        builder._save(session)
        self.assertEqual(self.add('r1').status_code, 409)


class RemovedListTests(ChurchTestCase):
    def test_capped_and_one_per_field_and_value(self):
        run, token = builder_run.start()
        try:
            for n in range(250):
                builder_run.removed('its quote is not on the page', 'about', f'Text {n % 210}', {'title': 'T', 'url': 'u'}, 'q')
        finally:
            builder_run.finish(token)
        self.assertEqual(len(run.removed), builder_run.MAX_REMOVED)
        self.assertEqual(len({e['value'] for e in run.removed}), builder_run.MAX_REMOVED)
