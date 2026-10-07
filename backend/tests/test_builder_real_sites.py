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

from backend.app import builder, builder_agents, builder_crawl, builder_run, builder_score, builder_site, builder_structured

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


class OfficeHoursTests(unittest.TestCase):
    """Forest Baptist: the info reader offered the Sunday service times as office hours. The site gives none."""

    def setUp(self):
        self.run, self.token = builder_run.start()
        self.addCleanup(builder_run.finish, self.token)

    def office_hours(self, path, value, quote):
        answer = {'facts': [{'field': 'office_hours', 'value': value, 'quote': quote}]}
        return [c['value'] for c in builder.ai_claims(source('forest-baptist', path), lambda m, t: answer)]

    def test_service_times_and_an_office_phone_are_not_office_hours(self):
        self.assertEqual(self.office_hours('home', 'Sundays 8:30a & 11:00a', 'Sundays: 8:30a & 11:00a (Nursery: birth - 4 years old)'), [])
        self.assertEqual(self.office_hours('home', 'Wednesdays 6:30p', 'Wednesday Evening 6:30pm'), [])
        self.assertEqual(self.office_hours('contact-us', 'Church Office', 'Church Office 434.525.4841'), [])
        self.assertEqual(self.run.dropped, {'not office hours': 3})

    def test_real_office_hours_are_kept(self):
        page = {'id': 's1', 'url': 'https://church.test/contact', 'title': 'Contact',
                'text': 'Church Office\nOffice hours: Monday - Thursday, 9:00 AM - 4:00 PM\nClosed Fridays'}
        for quote in ('Office hours: Monday - Thursday, 9:00 AM - 4:00 PM', 'Church Office Office hours: Monday - Thursday, 9:00 AM - 4:00 PM'):
            answer = {'facts': [{'field': 'office_hours', 'value': 'Monday - Thursday, 9:00 AM - 4:00 PM', 'quote': quote}]}
            self.assertEqual([c['value'] for c in builder.ai_claims(page, lambda m, t: answer)], ['Monday - Thursday, 9:00 AM - 4:00 PM'])


class StaffTests(unittest.TestCase):
    """Forest Baptist: "Deacon of" lost the second line of its role ("New Member Assimilation", which looks like a
    name), and the Missions page's "World Changers" / "Student Missions" was listed as a person."""

    def staff(self, path):
        return {i['value']['name']: i['value'].get('role') for i in builder_structured.staff_cards(source('forest-baptist', path))}

    def test_wrapped_deacon_roles_are_whole(self):
        deacons = self.staff('about/deacons')
        self.assertEqual(deacons['Mark Eckels'], 'Deacon of New Member Assimilation')
        self.assertEqual(deacons['Bruno Andrade'], 'Deacon of Member Care')
        self.assertEqual(deacons['Owen Fahy'], 'Deacon of Music & AV')
        self.assertEqual(deacons['Craig Asprey'], 'Deacon of Building & Grounds')
        self.assertFalse(any(role.endswith(' of') for role in deacons.values()), deacons)

    def test_a_ministry_is_not_a_person(self):
        missions = self.staff('ministries/missions')
        self.assertNotIn('World Changers', missions)
        self.assertEqual(missions.get('Tyler Scarlett'), 'Pastor-Teacher')
        run, token = builder_run.start()
        try:
            found = builder_agents.check('staff', {'items': [
                {'name': 'World Changers', 'role': 'Student Missions', 'quote': 'World Changers Student Missions'},
                {'name': 'Tyler Scarlett', 'role': 'Pastor-Teacher', 'quote': 'Tyler Scarlett Pastor-Teacher'}]},
                source('forest-baptist', 'ministries/missions'))
        finally:
            builder_run.finish(token)
        self.assertEqual([i['value']['name'] for i in found], ['Tyler Scarlett'])
        self.assertEqual(run.dropped, {'not a person': 1})

    def test_the_longer_role_wins_when_readers_disagree(self):
        page = source('forest-baptist', 'about/deacons')
        items = [{'collection': 'staff', 'value': {'name': 'Mark Eckels', 'role': 'Deacon of'}, 'quote': 'Mark Eckels Deacon of',
                  'source_id': 's1', 'method': 'pattern'},
                 {'collection': 'staff', 'value': {'name': 'Mark Eckels', 'role': 'Deacon of New Member Assimilation'},
                  'quote': 'Mark Eckels Deacon of New Member Assimilation', 'source_id': 's1', 'method': 'ai'}]
        self.assertEqual(builder.collect(items, [page])['staff'][0]['value']['role'], 'Deacon of New Member Assimilation')


class LinkTests(unittest.TestCase):
    """Forest Baptist (Google Sites): every outside link went through https://www.google.com/url?q=..., so Give was
    an "external" link to www.google.com, links were listed twice and icon links had no words."""

    @classmethod
    def setUpClass(cls):
        cls.session = import_site('forest-baptist', 'home')
        cls.links = cls.session['site']['links']

    def test_google_redirects_are_unwrapped(self):
        self.assertFalse([l['url'] for l in self.links if 'google.com/url' in l['url']])
        give = next(l for l in self.links if l['text'] == 'Give')
        self.assertEqual((give['url'], give['kind']), ('https://giving.ncsservices.org/App/Giving/ncs-2095', 'giving'))
        self.assertTrue(give['in_menu'])
        menu = [item['url'] for item in self.session['site']['navigation']['main']]
        self.assertIn('https://giving.ncsservices.org/App/Giving/ncs-2095', menu)

    def test_each_link_once_with_a_label(self):
        keys = [builder_site._link_key(l['url']) for l in self.links]
        self.assertEqual(len(keys), len(set(keys)))
        by_url = {l['url']: l for l in self.links}
        self.assertEqual(by_url['https://www.facebook.com/ForestBaptist']['text'], 'Facebook')
        self.assertEqual(by_url['https://www.facebook.com/ForestBaptist']['pages'], ['s1', 's6'])
        self.assertEqual(by_url['https://www.imb.org']['text'], 'imb.org')
        self.assertEqual(by_url['https://podcasts.apple.com/us/podcast/forest-baptist-church-podcast/id1596222749']['kind'], 'podcast')
        self.assertTrue(all(l['text'] for l in self.links))

    def test_unwrap(self):
        self.assertEqual(builder_crawl.unwrap('https://www.google.com/url?q=https%3A%2F%2Fwww.imb.org&sa=D&sntz=1&usg=x'),
                         'https://www.imb.org')
        self.assertEqual(builder_crawl.unwrap('https://www.google.com/url?url=https://grace.test/give#top'), 'https://grace.test/give')
        for url in ('https://www.google.com/url?q=javascript:alert(1)', 'https://www.google.com/maps?q=x', 'https://grace.test/url?q=https://a.test'):
            self.assertEqual(builder_crawl.unwrap(url), url)


class PodcastTests(unittest.TestCase):
    """Forest Baptist's Media page links its sermon podcast through Google Podcasts
    (podcasts.google.com/feed/<base64 of its Spreaker feed>) and Apple Podcasts; no sermons were read."""

    SPREAKER = 'https://www.spreaker.com/show/5253062/episodes/feed'

    def test_podcast_links_name_their_feed(self):
        google = ('https://podcasts.google.com/feed/aHR0cHM6Ly93d3cuc3ByZWFrZXIuY29tL3Nob3cvNTI1MzA2Mi9lcGlzb2Rlcy9mZWVk'
                  '?sa=X&ved=0CBoQ27cFahcKEwi4u8T107KDAxUAAAAAHQAAAAAQBg')
        self.assertEqual(builder_crawl.podcast_feed(google), self.SPREAKER)
        self.assertEqual(builder_crawl.podcast_feed('https://www.spreaker.com/show/5253062'), self.SPREAKER)
        for url in ('https://anchor.fm/s/abc123/podcast/rss', 'https://feeds.buzzsprout.com/12345.rss',
                    'https://feeds.captivate.fm/grace-sermons/', 'https://feed.podbean.com/grace/feed.xml',
                    'https://gracechurch.podbean.com/feed.xml', 'https://rss.libsyn.com/shows/123/destinations/456.xml',
                    'https://feeds.simplecast.com/AbC123', 'https://feeds.subsplash.com/abc/podcast.rss'):
            self.assertEqual(builder_crawl.podcast_feed(url), url)
        for url in ('https://podcasts.apple.com/us/podcast/forest-baptist-church-podcast/id1596222749',
                    'https://open.spotify.com/show/1FG3BwqoREPN7Lv7i5bDr8', 'https://podcasts.google.com/feed/!!!',
                    'https://podcasts.google.com/feed/amF2YXNjcmlwdDphbGVydCgxKQ', 'https://www.spreaker.com/user/x/episodes/feed'):
            self.assertEqual(builder_crawl.podcast_feed(url), '', url)

    def test_the_import_reads_the_sermon_podcast(self):
        fetch, fixture_feed = builder_score.fixture_fetchers(FBC)
        read = []

        def fetch_feed(url):
            read.append(url)
            return fixture_feed(url + '.xml' if url == self.SPREAKER else url)
        with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
            session = builder.new_session('https://church.test/home', fetch=fetch, fetch_feed=fetch_feed,
                                          complete=lambda m, t: None, describe=False)
        self.assertIn('https://www.spreaker.com/robots.txt', read)
        self.assertIn(self.SPREAKER, read)
        titles = [e['value'].get('title') for e in session['collections'].get('sermons', [])]
        self.assertIn('Luke 20:20-26', titles)
        self.assertIn('Summer In The Psalms: Psalm 88', titles)
        self.assertFalse([u for u in read if 'apple.com' in u])
        self.assertTrue(session['file_check']['valid'], session['file_check'])


if __name__ == '__main__':
    unittest.main()
