import json
import unittest
from datetime import date, time
from pathlib import Path
from backend.app.db import with_shift_coverage


class ShiftTests(unittest.TestCase):
    def test_seed_shifts_have_valid_dates_times_and_capacity(self):
        ministries = json.loads(Path('backend/app/ministries.json').read_text(encoding='utf-8'))
        ids = []
        for ministry in ministries:
            self.assertTrue(ministry['shifts'])
            for shift in ministry['shifts']:
                ids.append(shift['id'])
                date.fromisoformat(shift['date'])
                self.assertLess(time.fromisoformat(shift['start_time']), time.fromisoformat(shift['end_time']))
                self.assertGreater(shift['total'], 0)
                self.assertTrue(0 <= shift['filled'] <= shift['total'])
            self.assertEqual(with_shift_coverage(ministry), ministry)
        self.assertEqual(len(ids), len(set(ids)))

    def test_coverage_uses_shifts_without_mutating_saved_data(self):
        ministry = {'filled': 99, 'total': 100, 'shifts': [
            {'filled': 3, 'total': 6}, {'filled': 5, 'total': 6}]}
        result = with_shift_coverage(ministry)
        self.assertEqual((result['filled'], result['total']), (8, 12))
        self.assertEqual(ministry['filled'], 99)
        self.assertEqual(with_shift_coverage({'shifts': []})['total'], 0)

    def test_legacy_ministry_remains_readable(self):
        self.assertEqual(with_shift_coverage({'filled': 1, 'total': 2}), {'filled': 1, 'total': 2})
