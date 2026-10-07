"""Regressions from real church imports, each built from that church's real pages, trimmed (scripts, styles and
layout attributes removed; fixtures/builder/real/<church>/, each page names where it came from).

  - forest-baptist: https://www.forestbaptistchurch.org/ (Google Sites)

    python -m unittest backend.tests.test_builder_real_sites
"""
import json
import os
import unittest
from pathlib import Path
from unittest import mock

from backend.app import builder, builder_agents, builder_run, builder_score

REAL = Path(__file__).resolve().parent / 'fixtures' / 'builder' / 'real'
FBC = REAL / 'forest-baptist'


def source(site, path, sid='s1'):
    """One real page as the crawler reads it, served at https://church.test/<path>."""
    fetch, _ = builder_score.fixture_fetchers(REAL / site)
    url = 'https://church.test/' + path
    final_url, _, html = fetch(url)
    page = builder.parse_html(html)
    return {'id': sid, 'kind': 'page', 'url': final_url, **page}


def import_site(site, start, complete=None):
    fetch, fetch_feed = builder_score.fixture_fetchers(REAL / site)
    with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
        return builder.new_session('https://church.test/' + start, fetch=fetch, fetch_feed=fetch_feed,
                                   complete=complete or (lambda m, t: None), describe=False)


class AnswerShapeTests(unittest.TestCase):
    """Forest Baptist: 595 facts were dropped "because not in the expected shape". The model sent its facts as a
    JSON string, and every character of it was counted as one fact."""

    FACTS = [
        {'field': 'about', 'value': 'A missions-minded Southern Baptist church',
         'quote': 'A missions-minded Southern Baptist church that exists To Know Him and Make Him Known'},
        {'field': 'first_visit', 'value': "We'd love to have you join us soon!", 'quote': "We'd love to have you join us soon!"},
        {'field': 'office_hours', 'value': '<UNKNOWN>', 'quote': 'Sunday Services'},
        {'field': 'name', 'value': None, 'quote': None},
    ]

    def setUp(self):
        self.home = source('forest-baptist', 'home')
        self.run, self.token = builder_run.start()
        self.addCleanup(builder_run.finish, self.token)

    def claims(self, answer):
        return {(c['field'], c['value']) for c in builder.ai_claims(self.home, lambda m, t: answer)}

    def test_facts_as_a_list_a_json_string_or_wrapped_again(self):
        wanted = {('about', 'A missions-minded Southern Baptist church'), ('first_visit', "We'd love to have you join us soon!")}
        for answer in ({'facts': self.FACTS}, {'facts': json.dumps(self.FACTS)},
                       {'facts': json.dumps({'facts': self.FACTS})}, {'facts': '```json\n' + json.dumps(self.FACTS) + '\n```'}):
            self.assertEqual(self.claims(answer), wanted, answer)
        self.assertNotIn('not in the expected shape', self.run.dropped)

    def test_an_unreadable_answer_is_one_drop_not_one_per_character(self):
        self.assertEqual(self.claims({'facts': '[{"field": "about", "value": "A missions-minded", "quote": '}), set())
        self.assertEqual(self.run.dropped, {'not in the expected shape': 1})

    def test_specialist_items_as_a_json_string(self):
        staff = source('forest-baptist', 'about/staff')
        people = [{'name': 'Tyler Scarlett', 'role': 'Pastor-Teacher', 'email': 'N/A', 'quote': 'Tyler Scarlett'},
                  {'name': 'Reed Hernandez', 'role': None, 'email': 'not specified', 'quote': 'Reed Hernandez'}]
        for raw in ({'items': people}, {'items': json.dumps(people)}, {'items': json.dumps({'items': people})}):
            found = builder_agents.check('staff', raw, staff)
            self.assertEqual([i['value'] for i in found], [{'name': 'Tyler Scarlett', 'role': 'Pastor-Teacher'},
                                                           {'name': 'Reed Hernandez'}], raw)
        self.assertEqual(builder_agents.check('staff', {'items': 'not json at all'}, staff), [])
        self.assertEqual(self.run.dropped, {'not in the expected shape': 1})
        self.assertEqual(builder._specialist_drops('staff', {'items': json.dumps(people)}, found), 0)

    def test_structured_output_reads_a_json_string_list(self):
        class Choice:
            finish_reason = 'stop'

            class message:
                content = json.dumps({'facts': json.dumps(self.FACTS[:2])})

        class Response:
            choices = [Choice]
        answer = builder._structured_answer(Response, builder.AI_TOOL)
        self.assertEqual([f['field'] for f in answer['facts']], ['about', 'first_visit'])
        Choice.message.content = json.dumps({'facts': 'nothing useful'})
        self.assertIsNone(builder._structured_answer(Response, builder.AI_TOOL))


class ServiceTimeTests(unittest.TestCase):
    """Forest Baptist: Sunday School's 9:45 was offered as a third service time. It came from the Youth page's
    "Sundays - 9:45am", which the next line explains is Sunday School."""

    def services(self, *paths):
        times = set()
        for n, path in enumerate(paths, 1):
            for claim in builder.pattern_claims(source('forest-baptist', path, f's{n}')):
                if claim['field'] == 'services':
                    times.add((claim['value']['day'], claim['value']['time']))
        return times

    def test_sunday_school_times_are_not_service_times(self):
        self.assertEqual(self.services('home', 'ministries/youth', 'ministries/sunday-school', 'gatherings'),
                         {('Sunday', '08:30'), ('Sunday', '11:00')})

    def test_a_list_of_times_keeps_the_services_and_leaves_out_sunday_school(self):
        found = builder.service_times('Sunday Services at 8:30am & 11:00am; Sunday School at 9:45am; Wednesday Evening at 6:30pm')
        self.assertEqual({day: [t for t, _ in times] for day, times in found.items()}, {'Sunday': ['08:30', '11:00']})
        self.assertEqual(found['Sunday'][0][1], 'Sunday Services at 8:30am & 11:00am')

    def test_the_import_offers_two_sunday_services(self):
        session = import_site('forest-baptist', 'home')
        self.assertEqual(session['fields']['services']['value'], [{'day': 'Sunday', 'time': '08:30'}, {'day': 'Sunday', 'time': '11:00'}])
        self.assertTrue(session['file_check']['valid'], session['file_check'])


if __name__ == '__main__':
    unittest.main()
