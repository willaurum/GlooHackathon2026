import copy
import json
import unittest
from datetime import date
from pathlib import Path
from backend.app.eligibility import eligible_ministries


class EligibilityTests(unittest.TestCase):
    def setUp(self):
        self.ministries = json.loads(Path('backend/app/ministries.json').read_text(encoding='utf-8'))

    def filter(self, **preferences):
        return eligible_ministries(self.ministries, preferences, today=date(2026, 9, 30))[0]

    def test_exact_window_fits_but_partial_overlap_does_not(self):
        result = self.filter(availability=[{'day': 'Sunday', 'start_time': '08:30', 'end_time': '10:30'}])
        self.assertEqual([m['id'] for m in result], [0, 1])
        self.assertEqual([s['id'] for s in result[1]['shifts']], ['1-1'])
        self.assertEqual((result[1]['filled'], result[1]['total']), (3, 6))
        self.assertEqual(self.filter(availability=[{'day': 'Sunday', 'start_time': '09:00', 'end_time': '10:00'}]), [])

    def test_windows_are_alternatives_and_must_not_be_joined_across_gaps(self):
        result = self.filter(availability=[{'day': 'Saturday', 'start_time': '09:00', 'end_time': '12:00'},
                                           {'day': 'Tuesday', 'start_time': '18:00', 'end_time': '20:00'}])
        self.assertEqual([m['id'] for m in result], [3, 5])
        self.assertEqual(self.filter(availability=[{'day': 'Sunday', 'start_time': '08:00', 'end_time': '09:00'},
                                                   {'day': 'Sunday', 'start_time': '09:30', 'end_time': '10:30'}]), [])

    def test_capacity_is_checked_on_matching_shift(self):
        result = self.filter(preferred_service='sunday-11')
        self.assertNotIn(2, [m['id'] for m in result])
        self.assertIn(1, [m['id'] for m in result])

    def test_requirements_and_frequency(self):
        self.assertNotIn(0, [m['id'] for m in self.filter(unavailable_requirements=['background_check'])])
        self.assertNotIn(4, [m['id'] for m in self.filter(frequency='one-time')])
        self.assertIn(4, [m['id'] for m in self.filter(frequency='weekly')])
        self.assertNotIn(4, [m['id'] for m in self.filter(unavailable_requirements=['midweek_rehearsal'])])

    def test_date_boundary_and_expired_shifts(self):
        self.assertEqual([m['id'] for m in self.filter(earliest_start_date='2026-10-13')], [5])
        self.assertEqual(eligible_ministries(self.ministries, {}, today=date(2026, 10, 14))[0], [])

    def test_unknown_availability_is_flagged_and_catalog_is_not_mutated(self):
        before = copy.deepcopy(self.ministries)
        result = self.filter()
        self.assertTrue(result[0]['confirmations'])
        self.assertEqual(self.ministries, before)

    def test_legacy_prose_requests_clarification(self):
        result, message = eligible_ministries(self.ministries, {'days_and_times': 'Not Sundays'})
        self.assertEqual(result, [])
        self.assertIn('day and time windows', message)
