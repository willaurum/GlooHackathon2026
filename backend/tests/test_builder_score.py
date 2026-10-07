"""Human answer keys and deterministic, offline accuracy checks for the builder."""
import copy
import json
import unittest
from pathlib import Path
from unittest import mock

from backend.app import builder, builder_score

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'builder'


def draft(fields, questions=()):
    return {'fields': {f: {'status': status, 'value': value} for f, (status, value) in fields.items()},
            'questions': [{'field': f, 'kind': kind} for f, kind in questions]}


class ScoreTests(unittest.TestCase):
    def test_each_outcome_and_totals_without_mutation(self):
        session = draft({'name': ('prefilled', 'Example Chapel'), 'address': ('prefilled', 'Wrong address'),
                         'phone': ('conflict', None), 'email': ('missing', None), 'services': ('missing', None)},
                        [('phone', 'conflict'), ('email', 'missing'), ('services', 'missing')])
        expected = {'label': 'Example', 'name': 'Example Chapel', 'address': '12 Fiction Lane',
                    'about': 'A welcoming congregation.', 'services': [{'day': 'Sunday', 'time': '09:00'}],
                    'conflicts': ['phone'], 'missing': ['email']}
        original = copy.deepcopy((session, expected))
        result = builder_score.score(session, expected)
        self.assertEqual(result['fields'], {'name': 'correct', 'address': 'wrong', 'about': 'missed',
                                           'phone': 'correctly_flagged_conflict', 'email': 'correctly_flagged_missing',
                                           'services': 'false_conflict'})
        self.assertEqual(result['totals'], {'correct': 1, 'wrong': 1, 'missed': 1, 'correctly_flagged_conflict': 1,
                                           'correctly_flagged_missing': 1, 'false_conflict': 1, 'fields': 4,
                                           'conflicts': 1, 'gaps': 1, 'total': 6, 'successful': 3,
                                           'false_questions': 1, 'accuracy': 0.5})
        self.assertEqual(result['summary'], 'Example: 1/1 conflicts flagged, 1/1 gaps flagged, '
                                          '1/4 fields correct, 1 false questions')
        self.assertEqual((session, expected), original)

    def test_builder_normalization_and_service_order(self):
        services = [{'day': 'Sunday', 'time': '08:30'}, {'day': 'Wednesday', 'time': '19:00'}]
        examples = [('name', 'EXAMPLE Chapel!', 'Example Chapel'),
                    ('address', '12 Fiction Lane, Madeuptown, OH', '12 fiction lane Madeuptown OH'),
                    ('phone', '(555) 010-1234', '5550101234'),
                    ('email', ' HELLO@example.org ', 'hello@example.org'),
                    ('about', 'A welcoming\n congregation.', 'a welcoming congregation.'),
                    ('services', list(reversed(services)), services)]
        for field, value, expected in examples:
            with self.subTest(field=field):
                result = builder_score.score(draft({field: ('prefilled', value)}), {field: expected})
                self.assertEqual(result['fields'], {field: 'correct'})

    def test_wrong_values_do_not_get_partial_credit(self):
        examples = [('phone', '5550101235', '5550101234'),
                    ('services', [{'day': 'Sunday', 'time': '10:00'}], [{'day': 'Sunday', 'time': '09:00'}]),
                    ('about', 'Welcoming people.', 'A welcoming congregation.')]
        for field, value, expected in examples:
            with self.subTest(field=field):
                result = builder_score.score(draft({field: ('confirmed', value)}), {field: expected})
                self.assertEqual(result['fields'], {field: 'wrong'})

    def test_flags_need_an_open_question_of_the_right_kind_and_no_value(self):
        for category, field, kind in [('conflicts', 'phone', 'conflict'), ('missing', 'email', 'missing')]:
            for status, value, questions, outcome in [
                    ('prefilled', 'invented', [], 'wrong'),
                    (kind, 'invented', [(field, kind)], 'wrong'),
                    (kind, None, [], 'missed'),
                    (kind, None, [(field, 'missing' if kind == 'conflict' else 'conflict')], 'missed'),
                    ('prefilled', None, [(field, kind)], 'missed')]:
                with self.subTest(category=category, status=status, value=value, questions=questions):
                    result = builder_score.score(draft({field: (status, value)}, questions), {category: [field]})
                    self.assertEqual(result['fields'], {field: outcome})

    def test_either_question_kind_is_false_when_the_site_has_one_answer(self):
        for kind in ('conflict', 'missing'):
            with self.subTest(kind=kind):
                result = builder_score.score(draft({'name': (kind, None)}, [('name', kind)]),
                                             {'name': 'Example Chapel'})
                self.assertEqual(result['fields']['name'], 'false_conflict')
                self.assertEqual(result['totals']['false_questions'], 1)

    def test_unasked_missing_value_is_missed(self):
        for value in (None, '', []):
            with self.subTest(value=value):
                result = builder_score.score(draft({'about': ('prefilled', value)}), {'about': 'Our story.'})
                self.assertEqual(result['fields']['about'], 'missed')

    def test_empty_key_and_overlapping_designations(self):
        self.assertEqual(builder_score.score({}, {})['totals']['accuracy'], 0.0)
        for expected in ({'phone': '5550101234', 'conflicts': ['phone']},
                         {'conflicts': ['phone'], 'missing': ['phone']}):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                builder_score.score({}, expected)


class FixtureScoreTests(unittest.TestCase):
    def fixture_score(self, name):
        root = FIXTURES / name
        expected = json.loads((root / 'expected.json').read_text(encoding='utf-8'))
        # Block external readers and catch calls even if the builder swallows their errors.
        with mock.patch.object(builder.socket, 'getaddrinfo', side_effect=AssertionError('DNS forbidden')) as dns, \
                mock.patch.object(builder, '_http_fetch', side_effect=AssertionError('HTTP forbidden')) as http, \
                mock.patch.object(builder, '_http_fetch_bytes', side_effect=AssertionError('Images forbidden')) as images, \
                mock.patch.object(builder, '_ai_complete', side_effect=AssertionError('AI forbidden')) as ai, \
                mock.patch.object(builder, '_ai_describe', side_effect=AssertionError('Vision forbidden')) as vision:
            session = builder_score.import_fixture(root)
            for reader in (dns, http, images, ai, vision):
                reader.assert_not_called()
        self.assertTrue(all(s['kind'] == 'page' for s in session['sources']))
        return builder_score.score(session, expected)

    def test_cedar_hollow_current_accuracy(self):
        result = self.fixture_score('cedar-hollow-static')
        # Offline pattern extraction misses the three prose fields, though they are in the HTML.
        self.assertEqual(result['fields'], {'name': 'correct', 'address': 'correct', 'phone': 'correct',
                                           'email': 'correct', 'services': 'correct', 'office_hours': 'missed',
                                           'about': 'missed', 'first_visit': 'missed'})
        self.assertEqual(result['totals'], {'correct': 5, 'wrong': 0, 'missed': 3, 'correctly_flagged_conflict': 0,
                                           'correctly_flagged_missing': 0, 'false_conflict': 0, 'fields': 8,
                                           'conflicts': 0, 'gaps': 0, 'total': 8, 'successful': 5,
                                           'false_questions': 0, 'accuracy': 0.625})
        self.assertEqual(result['summary'], 'Cedar Hollow: 5/8 fields correct, 0 false questions')

    def test_harborlight_current_accuracy(self):
        result = self.fixture_score('harborlight-messy')
        # Header/footer/about names vary in the HTML, but the offline builder asks for a missing name.
        # It also misses office hours, history and visitor prose; the absent bulletin adds no facts.
        self.assertEqual(result['fields'], {'name': 'missed', 'phone': 'correctly_flagged_conflict',
                                           'services': 'correctly_flagged_conflict', 'address': 'correctly_flagged_missing',
                                           'email': 'correctly_flagged_missing', 'office_hours': 'missed',
                                           'about': 'missed', 'first_visit': 'missed'})
        self.assertEqual(result['totals'], {'correct': 0, 'wrong': 0, 'missed': 4, 'correctly_flagged_conflict': 2,
                                           'correctly_flagged_missing': 2, 'false_conflict': 0, 'fields': 3,
                                           'conflicts': 3, 'gaps': 2, 'total': 8, 'successful': 4,
                                           'false_questions': 0, 'accuracy': 0.5})
        self.assertEqual(result['summary'], 'Harborlight: 2/3 conflicts flagged, 2/2 gaps flagged, '
                                          '0/3 fields correct, 0 false questions')


if __name__ == '__main__':
    unittest.main()
