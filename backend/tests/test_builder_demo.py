"""Tekton's fictional Cedar Hollow Millbrook demo site, read offline as of October 7, 2026.

Planted problems: site worship at 9 AM disagrees with the October 4 bulletin's 10 AM;
the Events section is still Easter 2025; beliefs are under construction; College &
Young Adults' Wednesday 7 PM/Fellowship Hall details appear only in the bulletin.
Sunday School and Youth Group are activities, not worship services.

Expected failures today: rules count an unlabeled Youth Group time as worship;
both modes miss the bulletin's day context and separate service_group; the home
page never gets events/ministries specialists; missing beliefs never become a
question or note. The fake AI supplies grounded prose and list items through the
normal reader interface, without patching routing, claims or reconciliation.

    python -m unittest backend.tests.test_builder_demo
"""
import json
import os
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from backend.app import builder, builder_agents, builder_score, builder_structured

FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'builder' / 'cedar-hollow-millbrook'
EXPECTED = json.loads((FIXTURE / 'expected.json').read_text(encoding='utf-8'))
TODAY = date.fromisoformat(EXPECTED['today'])
URL = 'https://church.test/'
SITE_WORSHIP = 'Join us every Sunday for worship at 9:00 AM'
BULLETIN_WORSHIP = 'Worship — 10:00 AM'
COLLEGE_QUOTE = ('College & Young Adults meet every Wednesday at 7:00 PM in the Fellowship Hall. '
                 'New faces welcome. Look for Jake and Megan at the door.')
FESTIVAL_QUOTE = ('Fall Festival is Saturday, October 24, from 4:00–7:00 PM. Volunteers needed for games '
                  'and the chili cook-off. Sign up in the lobby.')
PAST_EVENTS = {'Good Friday Service', 'Community Easter Egg Hunt', 'Easter Sunrise Service'}


def specialist_fake(calls=None):
    """Grounded answers, available only when the orchestrator actually calls that reader."""
    def complete(messages, tools):
        tool = tools[0]['function']['name']
        if calls is not None:
            calls.append(tool)
        if tool == 'record_church_facts':
            # Services are currently rules-only; do not smuggle in unsupported AI service claims.
            return {'facts': [
                {'field': 'name', 'value': EXPECTED['name'], 'quote': EXPECTED['name']},
                {'field': 'office_hours', 'value': EXPECTED['office_hours'],
                 'quote': 'Office Hours: Tuesday–Thursday, 9:00 AM – 2:00 PM'},
                {'field': 'about',
                 'value': 'Cedar Hollow Community Church is a small, friendly congregation of about 110 people.',
                 'quote': 'Cedar Hollow Community Church is a small, friendly congregation of about 110 people.'},
            ]}  # No beliefs statement exists to copy; the builder must recognize the construction notice.
        if tool == 'record_events':
            return {'items': [
                {'name': 'Fall Festival', 'date': '2026-10-24', 'time': '4:00–7:00 PM',
                 'quote': FESTIVAL_QUOTE},
                {'name': 'Good Friday Service', 'date': '2025-04-18', 'time': '7:00 PM',
                 'quote': 'Friday, April 18, 2025 — Good Friday Service, 7:00 PM in the Sanctuary'},
                {'name': 'Community Easter Egg Hunt', 'date': '2025-04-19', 'time': '10:00 AM',
                 'quote': 'Saturday, April 19, 2025 — Community Easter Egg Hunt, 10:00 AM on the front lawn.'},
                {'name': 'Easter Sunrise Service', 'date': '2025-04-20', 'time': '6:30 AM',
                 'quote': 'Sunday, April 20, 2025 — Easter Sunrise Service, 6:30 AM at the outdoor cross,'},
            ]}
        if tool == 'record_ministries':
            return {'items': [
                {'name': "Children's Ministry (Nursery – 5th Grade)", 'kind': 'ministry',
                 'where': "Children's Wing", 'quote': "Kids' Sunday School meets in the Children's Wing."},
                {'name': 'Youth Group (Grades 6–12)', 'kind': 'ministry', 'when': 'Sundays 6:00 PM',
                 'where': 'Youth Room', 'leader': 'Pastor Kyle',
                 'quote': 'Sunday evenings at 6:00 PM in the Youth Room. Led by Pastor Kyle.'},
                {'name': 'College & Young Adults', 'kind': 'ministry', 'when': 'Wednesdays 7:00 PM',
                 'where': 'Fellowship Hall', 'quote': COLLEGE_QUOTE},
                {'name': "Women's Bible Study", 'kind': 'ministry', 'when': 'Tuesdays 10:00 AM',
                 'where': 'Library', 'quote': 'Tuesday mornings at 10:00 AM in the Library.'},
                {'name': "Men's Breakfast", 'kind': 'ministry', 'when': 'First Saturday of the month, 8:00 AM',
                 'where': 'Fellowship Hall', 'quote': 'First Saturday of the month, 8:00 AM, Fellowship Hall.'},
                {'name': 'Music Ministry', 'kind': 'ministry', 'when': 'Wednesdays',
                 'quote': 'Choir practice Wednesdays. New voices always welcome!'},
                {'name': 'Food Pantry', 'kind': 'ministry',
                 'quote': 'Food Pantry donations of canned goods can be left in the bin by the front doors.'},
                {'name': 'Sunday School', 'kind': 'group', 'when': 'Sundays 9:00 AM, before worship',
                 'quote': 'Sunday School for all ages meets at 9:00 AM, before worship.'},
            ]}
        if tool == 'record_staff':
            return {'items': [
                {'name': 'Dan Whitfield', 'role': 'Pastor', 'quote': 'Pastor Dan Whitfield'},
                {'name': 'Pastor Kyle', 'role': 'Youth pastor',
                 'quote': 'Youth Group (Grades 6–12) Sunday evenings at 6:00 PM in the Youth Room. Led by Pastor Kyle.'},
            ]}
        return {'items': []}
    return complete


def import_demo(complete=None):
    fetch, fetch_feed = builder_score.fixture_fetchers(FIXTURE)
    with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}), \
            mock.patch.object(builder, '_ai_complete', None), \
            mock.patch.object(builder, '_ai_describe', None):
        return builder.new_session(URL, fetch=fetch, fetch_feed=fetch_feed, complete=complete, describe=False,
                                   fetch_css=lambda url: (url, 'text/css', fetch.asset(url)[2].decode('utf-8')))


class DemoTestCase(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(builder_structured, '_today', lambda: TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def assert_no_stale_events(self, session, content):
        names = {e['value']['name'] for e in session['collections'].get('events', [])}
        self.assertFalse(names & PAST_EVENTS)
        self.assertTrue(all(e['date'] >= TODAY.isoformat() for e in content.get('calendar', [])))
        self.assertFalse({e['title'] for e in content.get('calendar', [])} & PAST_EVENTS)

    def assert_services_conflict(self, session):
        info = session['fields']['services']
        self.assertEqual(info['status'], 'conflict')
        self.assertIsNone(info['value'])
        questions = [q for q in session['questions'] if q['field'] == 'services']
        self.assertEqual(len(questions), 1)
        question = questions[0]
        self.assertEqual(question['kind'], 'conflict')
        candidates = {c['display']: c for c in question['candidates']}
        self.assertEqual(set(candidates), {'Sunday 9:00 AM', 'Sunday 10:00 AM'})
        for display, clock, quotes in [
            ('Sunday 9:00 AM', '09:00', (SITE_WORSHIP, 'Our worship service begins at 9:00 AM every Sunday morning')),
            ('Sunday 10:00 AM', '10:00', (BULLETIN_WORSHIP,)),
        ]:
            candidate = candidates[display]
            self.assertEqual(candidate['value'], [{'day': 'Sunday', 'time': clock}])
            self.assertTrue(any(quote in e['quote'] for quote in quotes for e in candidate['evidence']))
            for evidence in candidate['evidence']:
                self.assertEqual(evidence['url'], URL)
                source = next(s for s in session['sources'] if s['id'] == evidence['source_id'])
                self.assertTrue(builder.grounded(evidence['quote'], source['text']))


class RulesOnlyTests(DemoTestCase):
    def setUp(self):
        super().setUp()
        self.session = import_demo()
        self.content = builder.build_content(self.session, allow_unanswered=True)

    def test_name_address_phone_and_email(self):
        result = builder_score.score(self.session, EXPECTED)
        for field in ('name', 'address', 'phone', 'email'):
            with self.subTest(field=field):
                self.assertEqual(result['fields'][field], 'correct')
                self.assertFalse(any(q['field'] == field for q in self.session['questions']))
        self.assertTrue(all(c['method'] != 'ai' for c in self.session['claims']))
        # Office hours are prose: today's pattern reader does not extract them.

    def test_past_2025_events_stay_off_the_calendar(self):
        self.assert_no_stale_events(self.session, self.content)

    def test_sunday_school_is_not_a_worship_service(self):
        services = [c for c in self.session['claims'] if c['field'] == 'services']
        self.assertTrue(services)
        self.assertFalse(any(c['quote'].lower().startswith('sunday school') for c in services))
        self.assertFalse(any(c['value']['time'] == '10:30' for c in services))

    # Keep the Youth Group heading with its following "Sundays, 6:00 PM" line and exclude it from worship.
    @unittest.expectedFailure
    def test_youth_group_6_pm_is_not_a_worship_service(self):
        services = [c['value'] for c in self.session['claims'] if c['field'] == 'services']
        self.assertNotIn({'day': 'Sunday', 'time': '18:00'}, services)
        self.assertFalse(any(s['time'] == '6:00 PM' for s in self.content['info']['services']))

    # Read the bulletin's Sunday context and give its worship block its own service_group to ask both quotes.
    @unittest.expectedFailure
    def test_bulletin_and_site_worship_become_a_conflict(self):
        self.assert_services_conflict(self.session)


class FakeAITests(DemoTestCase):
    def setUp(self):
        super().setUp()
        self.calls = []
        self.session = import_demo(specialist_fake(self.calls))
        self.content = builder.build_content(self.session, allow_unanswered=True)

    def test_office_hours_are_grounded_and_kept_in_preview(self):
        self.assertIn('record_church_facts', self.calls)
        self.assertEqual(self.session['fields']['office_hours']['value'], EXPECTED['office_hours'])
        self.assertEqual(self.content['info']['office_hours'], EXPECTED['office_hours'])
        claims = [c for c in self.session['claims'] if c['field'] == 'office_hours']
        self.assertTrue(claims)
        for claim in claims:
            source = next(s for s in self.session['sources'] if s['id'] == claim['source_id'])
            self.assertTrue(builder.grounded(claim['quote'], source['text']))

    def test_fake_specialist_answers_are_grounded_and_old_events_are_filtered(self):
        # Check the stand-in separately; acceptance tests below still use unmodified production routing.
        source = self.session['sources'][0]
        fake = specialist_fake()
        for name in ('events', 'ministries', 'staff'):
            raw = fake(builder_agents.messages(name, source), [builder_agents.SPECIALISTS[name]['tool']])
            for item in raw['items']:
                with self.subTest(reader=name, item=item['name']):
                    self.assertTrue(builder.grounded(item['quote'], source['text']))
            checked = builder_agents.check(name, raw, source, TODAY)
            if name == 'events':
                self.assertEqual([e['value']['name'] for e in checked], EXPECTED['lists']['events'])
                self.assertEqual(checked[0]['value']['date'], '2026-10-24')
            else:
                self.assertEqual(len(checked), len(raw['items']))

    def test_past_2025_events_stay_off_the_calendar(self):
        self.assert_no_stale_events(self.session, self.content)

    # Read the bulletin's Sunday context and give its worship block its own service_group to ask both quotes.
    @unittest.expectedFailure
    def test_services_conflict_question_has_both_grounded_candidates(self):
        self.assert_services_conflict(self.session)

    # Route the single home page's bulletin/events sections to the events reader, retaining inferred year and time range.
    @unittest.expectedFailure
    def test_bulletin_fall_festival_reaches_the_calendar(self):
        festival = [e for e in self.content.get('calendar', []) if e['title'] == 'Fall Festival']
        self.assertEqual(len(festival), 1)
        self.assertEqual((festival[0]['date'], festival[0]['time']), ('2026-10-24', '4:00–7:00 PM'))  # 16:00–19:00 local.
        entries = [e for e in self.session['collections'].get('events', []) if e['value']['name'] == 'Fall Festival']
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0]['include'])
        self.assertTrue(any(e['quote'] == FESTIVAL_QUOTE for e in entries[0]['evidence']))
        self.assert_no_stale_events(self.session, self.content)

    # Route the home page's ministries/bulletin sections to the ministries reader and retain when/where in preview.
    @unittest.expectedFailure
    def test_college_ministry_keeps_bulletin_only_details(self):
        entries = [e for e in self.session['collections'].get('ministries', [])
                   if e['value']['name'] == 'College & Young Adults']
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual((entry['value']['when'], entry['value']['where']), ('Wednesdays 7:00 PM', 'Fellowship Hall'))
        self.assertTrue(entry['include'])
        self.assertTrue(any(e['quote'] == COLLEGE_QUOTE for e in entry['evidence']))
        ministry = next(m for m in self.content['ministries'] if m['name'] == 'College & Young Adults')
        self.assertEqual((ministry['day'], ministry['note']), ('Wednesdays 7:00 PM', 'Fellowship Hall'))

    # Recognize "What We Believe" under construction and ask the pastor for beliefs or add a missing-beliefs note.
    @unittest.expectedFailure
    def test_missing_beliefs_are_handed_back_to_the_pastor(self):
        questions = [q for q in self.session['questions']
                     if q['kind'] == 'missing' and q['field'] in ('beliefs', 'statement_of_faith')]
        notes = [n for n in self.session['notes']
                 if any(term in n.lower() for term in ('beliefs', 'statement of faith', 'what we believe'))
                 and any(term in n.lower() for term in ('missing', 'under construction', 'pastor', 'could not find'))]
        self.assertTrue(questions or notes, 'The pastor needs a missing-beliefs question or note.')
        self.assertFalse(self.session['fields'].get('beliefs', {}).get('value'))
        self.assertFalse(self.session['fields'].get('statement_of_faith', {}).get('value'))


if __name__ == '__main__':
    unittest.main()
