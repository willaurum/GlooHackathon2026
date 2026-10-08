"""Prayer map regions and their dated "From the field" updates, set up through the church content import."""

import unittest

from fastapi.testclient import TestClient

from backend.app import db, main
from backend.tests.test_churches import ChurchTestCase


def region(code='KEN', **extra):
    return {'country': 'Kenya', 'country_code': code, 'codename': 'Team Savanna',
            'field_of_ministry': 'Clean water', 'since': 2020, 'team_size': 3, **extra}


class FieldUpdateTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app, headers={'X-Church': 'hope-chapel', 'X-Church-Name': 'Hope%20Chapel'})

    def put(self, regions):
        return self.client.put('/api/church/content', json={'regions': regions})

    def test_demo_church_starts_with_one_update_per_region(self):
        regions = db.list_regions()
        self.assertTrue(regions)
        for r in regions:
            self.assertNotIn('testimony', r)
            self.assertEqual(len(r['updates']), 1)
            main.RegionOut(**r)

    def test_a_new_church_has_no_regions(self):
        self.assertEqual(self.client.get('/api/regions').json(), [])

    def test_updates_are_saved_and_listed_newest_first(self):
        updates = [{'date': '2026-03-01', 'body': 'Older'}, {'date': '2026-06-01', 'title': 'Rains', 'body': 'Newer', 'author': 'Sam'}]
        response = self.put([region(updates=updates)])
        self.assertEqual(response.status_code, 200, response.text)
        saved = self.client.get('/api/regions').json()[0]['updates']
        self.assertEqual([u['body'] for u in saved], ['Newer', 'Older'])
        self.assertEqual((saved[0]['title'], saved[0]['author']), ('Rains', 'Sam'))

    def test_saving_again_keeps_history_and_removes_what_was_dropped(self):
        self.put([region(updates=[{'date': '2026-03-01', 'body': 'One'}, {'date': '2026-04-01', 'body': 'Two'}])])
        current = self.client.get('/api/regions').json()[0]
        keep = [u for u in current['updates'] if u['body'] == 'Two']
        self.put([{**current, 'updates': keep + [{'date': '2026-05-01', 'body': 'Three'}]}])
        after = self.client.get('/api/regions').json()
        self.assertEqual(after[0]['id'], current['id'])
        self.assertEqual([u['body'] for u in after[0]['updates']], ['Three', 'Two'])

    def test_removing_a_region_removes_its_updates(self):
        self.put([region(updates=[{'date': '2026-03-01', 'body': 'One'}])])
        self.put([])
        self.assertEqual(self.client.get('/api/regions').json(), [])
        with db.use_church('hope-chapel'):
            self.assertEqual(db.query("SELECT * FROM field_updates"), [])

    def test_a_country_can_only_be_added_once(self):
        self.assertEqual(self.put([region(), region()]).status_code, 422)

    def test_bad_input_is_refused(self):
        for bad in (region(code='ke'), region(updates=[{'date': 'soon', 'body': 'x'}]),
                    region(updates=[{'date': '2026-03-01', 'body': ''}]), region(since=1800)):
            self.assertEqual(self.put([bad]).status_code, 422, bad)

    def test_an_old_testimony_becomes_the_first_update(self):
        import json
        with db.use_church('hope-chapel'):
            db.run(("INSERT INTO regions VALUES (7, ?)", (json.dumps({'id': 7, 'country': 'Peru', 'country_code': 'PER',
                    'codename': 'Team Andes', 'testimony': 'We are here.'}),)))
            db._ready.clear()
            [peru] = db.list_regions()
        self.assertNotIn('testimony', peru)
        self.assertEqual([u['body'] for u in peru['updates']], ['We are here.'])

    def test_prayer_points_are_gone(self):
        self.assertEqual(self.client.get('/api/regions/0/prayer-angles').status_code, 404)
        self.assertEqual(self.client.post('/api/regions/0/prayer-angles').status_code, 404)
        self.assertEqual(db.query("SELECT name FROM sqlite_master WHERE name = 'prayer_angles'"), [])

    def test_export_includes_regions(self):
        self.put([region(updates=[{'date': '2026-03-01', 'body': 'One'}])])
        self.assertEqual(self.client.get('/api/church/content').json()['regions'][0]['country_code'], 'KEN')


if __name__ == '__main__':
    unittest.main()
