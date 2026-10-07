"""Calendar events: the demo church's seed, staff deleting an event, and the summary prompt's dates."""

import asyncio
import datetime
import json
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import ai_client, db, main
from backend.tests.test_churches import ChurchTestCase

SEED = json.loads((Path(__file__).resolve().parents[1] / 'app' / 'events.json').read_text(encoding='utf-8'))


def restart():
    db._ready.clear()
    db.initialize()


class EventSeedTests(ChurchTestCase):
    def test_serve_day_is_on_the_demo_calendar(self):
        serve_day = [e for e in db.list_events() if e['title'] == 'Serve Day']
        self.assertEqual([(e['date'], e['category']) for e in serve_day], [('2026-10-17', 'Outreach')])
        self.assertEqual(len(db.list_events()), len(SEED))

    def test_a_new_church_gets_no_sample_events(self):
        with db.use_church('hope-chapel', 'Hope Chapel'):
            self.assertEqual(db.list_events(), [])

    def test_a_deleted_event_stays_deleted_after_a_restart(self):
        first = db.list_events()[0]
        self.assertTrue(db.delete_event(first['id']))
        self.assertFalse(db.delete_event(first['id']))
        restart()
        self.assertNotIn(first['id'], [e['id'] for e in db.list_events()])
        self.assertEqual(len(db.list_events()), len(SEED) - 1)

    def test_a_new_sample_event_reaches_a_church_seeded_before_it(self):
        # A church seeded before Serve Day was added: its id is taken by a staff event, and it has no marker.
        serve_day = next(e for e in db.list_events() if e['title'] == 'Serve Day')
        db.delete_event(serve_day['id'])
        db.run(("DELETE FROM config WHERE key = ?", (f"event_seeded:{serve_day['id']}",)))
        staff = db.create_event('Staff test', 'Worship', '2026-11-01', '10:00 AM', 'Hall', 'A test event')
        db.run(("UPDATE events SET id = ? WHERE id = ?", (serve_day['id'], staff['id'])))
        restart()
        titles = [e['title'] for e in db.list_events()]
        self.assertEqual(titles.count('Serve Day'), 1)
        self.assertIn('Staff test', titles)
        restart()
        self.assertEqual([e['title'] for e in db.list_events()].count('Serve Day'), 1)


class EventDeleteRouteTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)

    def test_delete_an_event(self):
        event = db.list_events()[0]
        self.assertEqual(self.client.delete(f"/api/events/{event['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/api/events/{event['id']}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/events/{event['id']}").status_code, 404)


class SummaryDatesTests(unittest.TestCase):
    TODAY = datetime.date(2026, 10, 7)

    def test_event_timing_says_past_today_and_ahead(self):
        past = ai_client.event_timing('2026-09-27', self.TODAY)
        self.assertIn('Today is Wednesday, October 7, 2026.', past)
        self.assertIn('Sunday, September 27, 2026, 10 days ago: it has already happened', past)
        self.assertIn('The event is today', ai_client.event_timing('2026-10-07', self.TODAY))
        self.assertIn('Saturday, October 17, 2026, 10 days from now', ai_client.event_timing('2026-10-17', self.TODAY))
        self.assertEqual(ai_client.event_timing('not a date', self.TODAY), 'Today is Wednesday, October 7, 2026.')

    def test_the_summary_prompt_carries_both_dates_and_the_tense_rule(self):
        with mock.patch.object(ai_client, 'generate_text', new=mock.AsyncMock(return_value='ok')) as generate:
            asyncio.run(ai_client.summarize_event('Worship', 'Worship', 'Songs', '2026-09-27', '9:00 AM', 'Sanctuary', today=self.TODAY))
        system, user = generate.call_args.args[:2]
        self.assertIn('past tense for an event that has already happened', system)
        self.assertIn('this Sunday', system)  # named as a phrase to avoid
        self.assertIn('Today is Wednesday, October 7, 2026.', user)
        self.assertIn('it has already happened', user)


if __name__ == '__main__':
    unittest.main()
