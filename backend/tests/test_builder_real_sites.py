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


class OccasionTests(unittest.TestCase):
    """Forest Baptist's Children page lists its yearly events (Easter Eggstravaganza, Vacation Bible School, Fall
    Festival); the ministries reader called them groups."""

    def test_yearly_occasions_become_events(self):
        page = source('forest-baptist', 'ministries/children')
        answer = {'items': [
            {'name': 'Easter Eggstravaganza', 'kind': 'group', 'when': 'Every Spring, the Saturday before Easter',
             'quote': 'Every Spring, the Saturday before Easter, we host an Easter egg hunt'},
            {'name': 'Vacation Bible School', 'kind': 'ministry', 'when': 'Last full week of June',
             'quote': 'Each Summer, during the mornings of last full week of June, we have Vacation Bible School (Lifeway)'},
            {'name': 'Fall Festival', 'kind': 'group', 'when': 'October 31st', 'where': '',
             'quote': 'Our annual Fall Festival takes place every October 31st.'},
            {'name': 'Children', 'kind': 'ministry', 'when': 'Wednesdays 6:30p',
             'quote': 'Wednesdays: 6:30p (Adult, Children, and Youth activities)'},
        ]}
        found = {i['value']['name']: (i['collection'], i['value'].get('when')) for i in builder_agents.check('ministries', answer, page)}
        self.assertEqual(found['Easter Eggstravaganza'], ('events', 'Every Spring, the Saturday before Easter'))
        self.assertEqual(found['Vacation Bible School'], ('events', 'Last full week of June'))
        self.assertEqual(found['Fall Festival'], ('events', 'October 31st'))

    def test_weekly_meetings_stay_groups(self):
        for when in ('Wednesdays 6:30p', 'Every Sunday in October', 'Tuesdays, September through May', ''):
            self.assertFalse(builder_agents.occasion(when), when)
        for when in ('Every Spring, the Saturday before Easter', 'Last full week of June', 'October 31st', 'Each Christmas Eve'):
            self.assertTrue(builder_agents.occasion(when), when)


class PageLabelTests(unittest.TestCase):
    """Crosspoint (SnapPages): every title is "Crosspoint Church - <page>", so the progress feed said "Read
    “Crosspoint Church” (ministries)" for every page, and the beliefs were labeled with a home-page sentence that
    says "believers"."""

    @classmethod
    def setUpClass(cls):
        cls.progress, token = builder_run.start()
        try:
            cls.session = import_site('crosspoint', '')
        finally:
            builder_run.finish(token)
        cls.steps = [s['text'] for s in cls.progress.steps]

    def test_the_progress_feed_names_each_page(self):
        for name in ("Men's", 'Seniors', 'Small Groups', 'Downtown Missional Community', 'Values & Beliefs', 'Contact Us'):
            self.assertTrue(any(t.startswith(f'Read “{name}”') for t in self.steps), name)
        self.assertIn('Read “Home” (home page)', self.steps)
        self.assertFalse([t for t in self.steps if t.startswith('Read “Crosspoint Church”')])

    def test_beliefs_and_pages_are_named_by_their_page(self):
        self.assertEqual(self.session['beliefs']['title'], 'Values & Beliefs')
        titles = {p['url'].rsplit('/', 1)[-1]: builder_site.page_title(p, 'Crosspoint Church') for p in self.session['site']['pages']}
        self.assertEqual((titles[''], titles['men-s'], titles['downtownmissions']), ('Home', "Men's", 'Downtown Missional Community'))

    def test_names_fall_back_to_the_heading_then_the_address(self):
        self.assertEqual(builder._page_name({'title': 'A place the body of believers gather in corporate worship, disciple making.',
                                             'headings': [(1, 'OUR VALUES & BELIEFS')], 'url': 'https://c.test/our-values'}),
                         'OUR VALUES & BELIEFS')
        self.assertEqual(builder._page_name({'title': 'Grace Chapel', 'url': 'https://c.test/small-groups'}, 'Grace Chapel'), 'Small groups')
        self.assertEqual(builder._page_name({'title': 'Plan a Visit | Cedar Hollow Church', 'url': 'https://c.test/visit'}), 'Plan a Visit')
        self.assertFalse(builder.BELIEFS_RE.search('A place the body of believers gather'))
        self.assertTrue(builder.BELIEFS_RE.search('What We Believe'))


class MinistryContactTests(unittest.TestCase):
    """Crosspoint: the phone question offered (607) 425-9569 (only on the Men's page) and (540) 874-4442 (only on
    Seniors). Neither is the church's: they are ministry leaders' numbers."""

    @staticmethod
    def ministries(messages, tools):
        tool, page = tools[0]['function']['name'], messages[1]['content']
        if tool == 'record_ministries' and 'Morning Study' in page:
            return {'items': [{'name': 'Morning Study', 'kind': 'group', 'when': 'Fridays 6:30 AM',
                               'quote': 'Join the men every Friday morning from 6:30-7:30 for fellowship'}]}
        return {'facts': []} if tool == 'record_church_facts' else {'items': []}

    def import_pages(self, *paths, complete=None):
        fetch, fetch_feed = builder_score.fixture_fetchers(REAL / 'crosspoint')

        def only(url):
            if url.removeprefix('https://church.test/') not in paths:
                raise FileNotFoundError(url)
            return fetch(url)
        with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
            return builder.new_session('https://church.test/', fetch=only, fetch_feed=fetch_feed,
                                       complete=complete or (lambda m, t: None), describe=False)

    def test_ministry_numbers_are_hints_not_the_church_phone(self):
        session = self.import_pages('', 'men-s', 'seniors', complete=self.ministries)
        self.assertEqual(session['fields']['phone']['status'], 'missing')
        question = next(q for q in session['questions'] if q['field'] == 'phone')
        self.assertEqual(question['candidates'], [])
        self.assertIn("What is your church's phone number?", question['prompt'])
        self.assertIn("The Men's page lists (607) 425-9569.", question['prompt'])
        self.assertIn('The Seniors page lists (540) 874-4442.', question['prompt'])
        group = next(g for g in session['collections']['groups'] if g['value']['name'] == 'Morning Study')
        self.assertIn('Contact: (607) 425-9569', group['value']['description'])
        self.assertEqual(session['fields']['email']['value'], 'info@crosspointonline.com')  # in every page's footer
        self.assertTrue(session['file_check']['valid'], session['file_check'])

    def test_the_contact_page_number_is_the_church_phone(self):
        session = import_site('crosspoint', '')
        self.assertEqual((session['fields']['phone']['status'], session['fields']['phone']['value']), ('prefilled', '4349444967'))
        self.assertFalse([q for q in session['questions'] if q['field'] == 'phone'])

    def test_a_footer_number_beats_a_leader_number(self):
        footer = '\nGrace Chapel\n(802) 555-0142\ninfo@grace.test'
        pages = [('', 'Home', 'Welcome to Grace Chapel.'), ('kids', 'Kids', 'Sunday classes for kids.'),
                 ('youth', 'Youth', 'Questions? Call our youth leader at (802) 555-0199.'), ('men', 'Men', 'Breakfast monthly.')]
        sources = [{'id': f's{n}', 'kind': 'page', 'url': 'https://church.test/' + path, 'title': f'Grace Chapel - {title}',
                    'text': text + footer, 'page_type': builder_crawl.page_type('https://church.test/' + path, title)}
                   for n, (path, title, text) in enumerate(pages, 1)]
        session = builder.session_from_sources('https://church.test/', sources)
        self.assertEqual((session['fields']['phone']['status'], session['fields']['phone']['value']), ('prefilled', '8025550142'))


class AddressTests(unittest.TestCase):
    """Crosspoint's home page says "Join us this sunday at: 150 Alum springs road, lynchburg, va 24502" (lower case);
    the address reader wanted capitalized words and missed it."""

    def addresses(self, path):
        return [(c['value'], c['quote']) for c in builder.pattern_claims(source('crosspoint', path)) if c['field'] == 'address']

    def test_a_lower_case_address_is_found_and_shown_title_cased(self):
        self.assertEqual(self.addresses(''), [('150 Alum Springs Road, Lynchburg, VA 24502', '150 Alum springs road, lynchburg, va 24502')])
        session = import_site('crosspoint', '')
        self.assertEqual(session['fields']['address']['value'], '150 Alum Springs Road, Lynchburg, VA 24502')
        self.assertTrue(session['file_check']['valid'], session['file_check'])

    def test_lower_case_prose_is_not_an_address(self):
        page = {'id': 's1', 'url': 'https://church.test/', 'title': 'Home',
                'text': 'We have 2 services on the way in, and 3 more down the road by the lake drive.'}
        self.assertEqual([c for c in builder.pattern_claims(page) if c['field'] == 'address'], [])


class GenericLinkAndFormTests(unittest.TestCase):
    """Crosspoint: the Serve page has a dozen "Sign up here." links to Church Center forms, all listed as "Sign up
    here.", and its footer contact form was listed on every page as "Message, Message, Message, Message" (SnapPages
    puts each <label> beside its input, with no for= or id)."""

    @classmethod
    def setUpClass(cls):
        site = import_site('crosspoint', '')['site']
        cls.links = {l['url'].rsplit('/', 1)[-1]: l['text'] for l in site['links']}
        cls.forms = site['forms']

    def test_generic_links_are_named_by_what_they_sign_up_for(self):
        self.assertEqual(self.links['991533'], 'Connect Team sign-up')
        self.assertEqual(self.links['991524'], 'Coffee sign-up')
        self.assertEqual(self.links['776740'], 'Parking sign-up')
        self.assertEqual(self.links['1275323'], 'CP Kids sign-up')  # "Apply HERE today!"
        self.assertEqual(self.links['1294788'], 'CP Youth sign-up')  # "Apply to serve HERE."
        self.assertEqual(self.links['1211774'], 'Monthly Connections sign-up')  # "Click for Details"
        self.assertFalse([t for t in self.links.values() if builder_site._generic(t)], self.links)
        self.assertFalse([t for t in self.links.values() if len(t.split()) > 12])

    def test_snappages_form_labels_and_one_footer_form(self):
        contact = [f for f in self.forms if [x['label'] for x in f['fields']] == ['First Name', 'Last Name', 'Email', 'Message']]
        self.assertEqual(len(contact), 1)
        self.assertGreater(len(contact[0]['pages']), 1)
        online = next(f for f in self.forms if len(f['fields']) > 4)
        self.assertEqual([x['label'] for x in online['fields']][4:],
                         ['Checkboxes', 'Prayer Request', 'Get Baptized', 'Join a Discipleship Group', 'Become a Member'])

    def test_labels_beside_wrapping_and_for(self):
        page = builder.parse_html('<form><label>Name</label><input type="text"><label>Phone <input name="p"></label>'
                                  '<label for="e">Email</label><input id="e" name="email"><input name="x" placeholder="Note">'
                                  '<input type="checkbox" name="c"><input type="checkbox" name="c"></form>')
        self.assertEqual([f['label'] for f in page['forms'][0]['fields']], ['Name', 'Phone', 'Email', 'Note', 'c'])


class PagePriorityTests(unittest.TestCase):
    """Crosspoint: of 271 pages found, the import spent its pages on app-only copies ("Kids - App only", "Staff (App)",
    "Volunteer - App Only") and sermon-library index pages (/media/topic, /media/speaker, /media/scripture)."""

    def test_app_copies_and_sermon_indexes_are_read_last(self):
        for url, anchor in (('https://church.test/staff-app', ''), ('https://church.test/kidsandfamily-app', ''),
                            ('https://church.test/kids', 'Kids - App only'), ('https://church.test/team2', 'Staff (App)'),
                            ('https://church.test/media/topic', ''), ('https://church.test/media/speaker/', ''),
                            ('https://church.test/sermons/scripture', ''), ('https://church.test/media/series', '')):
            self.assertLess(builder_crawl.score(url, anchor), builder_crawl.score('https://church.test/blog/2022/02/17/february-17'), url)
        for url in ('https://church.test/team', 'https://church.test/kids', 'https://church.test/apple-festival',
                    'https://church.test/media/topic/grace', 'https://church.test/happy'):
            self.assertGreater(builder_crawl.score(url), -10, url)

    def test_a_limited_import_reads_distinct_pages_first(self):
        with mock.patch.object(builder, 'MAX_PAGES', 20):
            session = import_site('crosspoint', '')
        read = [s['url'] for s in session['sources'] if s.get('kind') == 'page']
        self.assertEqual(len(read), 20)
        self.assertFalse([u for u in read if u.endswith('-app')], read)
        self.assertIn('https://church.test/contactus', read)
        self.assertIn('https://church.test/our-values', read)


if __name__ == '__main__':
    unittest.main()
