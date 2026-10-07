"""Calendars a church's site embeds: finding them, reading iCal feeds with repeating events, and importing one only
when the church asks (docs/agentic-builder.md, "Calendars: ask the church first").

Fixtures (fixtures/builder/calendars/): fbc-calendar.html is Forest Baptist's real calendar page, trimmed (a Google
Calendar iframe on Google Sites); synthetic.ics is a small made-up feed; site/ is a made-up church whose calendar
hosts block crawlers in robots.txt.

    python -m unittest backend.tests.test_builder_calendar
"""
import os
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

import httpx
from fastapi.testclient import TestClient

from backend.app import builder, builder_calendar, builder_json, builder_score, builder_structured, main
from backend.tests.test_churches import ChurchTestCase

FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'builder' / 'calendars'
TODAY = date(2030, 1, 6)
SOURCE = {'id': 'calendar-cal1', 'kind': 'feed', 'url': 'https://church.test/calendar', 'title': 'Grace Chapel (iCal)'}
FBC_FEED = 'https://calendar.google.com/calendar/ical/fbc.schedule%40gmail.com/public/basic.ics'


def page(path, url):
    parsed = builder.parse_html(Path(path).read_text(encoding='utf-8'))
    return {'id': 's1', 'kind': 'page', 'url': url, 'title': parsed['title'], 'embeds': parsed['embeds'],
            'anchors': parsed.get('anchors', []), 'links': parsed.get('links', []), 'calendar_hints': parsed['calendar_hints']}


def anchors(*pairs):
    return {'kind': 'page', 'url': 'https://church.test/events', 'title': 'Events | Grace', 'embeds': [],
            'anchors': [(href, text) for href, text in pairs]}


def synthetic():
    return builder_calendar.events(SOURCE, (FIXTURE / 'synthetic.ics').read_text(encoding='utf-8'), TODAY, 183, 200)


def dated(items, name):
    return [(i['value']['date'], i['value'].get('time', '')) for i in items if i['value']['name'] == name and i['value'].get('date')]


def import_site(**kwargs):
    fetch, fetch_feed = builder_score.fixture_fetchers(FIXTURE / 'site')
    with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}), \
            mock.patch.object(builder_structured, '_today', lambda: TODAY):
        return builder.new_session('https://church.test/', fetch=fetch, fetch_feed=kwargs.get('fetch_feed', fetch_feed),
                                   complete=lambda m, t: None, describe=False)


class DetectionTests(unittest.TestCase):
    def test_forest_baptist_google_calendar_iframe(self):
        found = builder_calendar.detect([page(FIXTURE / 'fbc-calendar.html', 'https://www.forestbaptistchurch.org/ministries/calendar')])
        self.assertEqual(len(found), 1)
        entry = found[0]
        self.assertEqual((entry['provider'], entry['name'], entry['feed_url'], entry['status']),
                         ('Google Calendar', 'FBC Schedule', FBC_FEED, 'found'))
        self.assertTrue(entry['embed_url'].startswith('https://www.google.com/calendar/embed?'))
        self.assertEqual(builder_calendar.label(entry), 'FBC Schedule (Google Calendar)')

    def test_providers(self):
        cid = 'Y19hYmMxMjNAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ'  # base64 of c_abc123@group.calendar.google.com
        found = builder_calendar.detect([anchors(
            ('https://calendar.google.com/calendar/u/0?cid=' + cid, 'Add to Google'),
            ('https://calendar.google.com/calendar/embed?src=en.usa%23holiday%40group.v.calendar.google.com&src=youth%40grace.test', 'Calendar'),
            ('webcal://grace.test/events/feed.ics', 'Subscribe'),
            ('https://tockify.com/gracechapel', 'Our calendar'),
            ('https://outlook.office365.com/owa/calendar/abc@grace.test/def/calendar.html', 'Office calendar'),
            ('https://teamup.com/ksabc123def', 'Room bookings'),
            ('https://grace.test/events/?ical=1', 'Export events'),
            ('https://grace.churchcenter.com/calendar', 'Church Center'),
            ('https://grace.test/about', 'About'),
        )]) + builder_calendar.detect([anchors(
            ('https://grace.churchsuite.com/events', 'ChurchSuite'),
            ('https://grace.elvanto.net/calendar/', 'Elvanto'),
            ('https://grace.breezechms.com/events', 'Breeze'),
            ('https://subsplash.com/grace/events', 'Subsplash'),
            ('https://grace.elexio.com/calendar', 'Elexio'),
        )])
        by_provider = {}
        for entry in found:
            by_provider.setdefault(entry['provider'], []).append(entry['feed_url'])
        self.assertEqual(by_provider['Google Calendar'], [  # the US holidays calendar beside it is Google's, not the church's
            'https://calendar.google.com/calendar/ical/c_abc123%40group.calendar.google.com/public/basic.ics',
            'https://calendar.google.com/calendar/ical/youth%40grace.test/public/basic.ics'])
        self.assertIn('https://grace.test/events/feed.ics', by_provider['iCal'])
        self.assertIn('https://grace.test/events/?ical=1', by_provider['iCal'])
        self.assertEqual(by_provider['Tockify'], ['https://tockify.com/api/feeds/ics/gracechapel'])
        self.assertEqual(by_provider['Outlook'], ['https://outlook.office365.com/owa/calendar/abc@grace.test/def/calendar.ics'])
        self.assertEqual(by_provider['Teamup'], ['https://ics.teamup.com/feed/ksabc123def/0.ics'])
        for provider in ('Church Center (Planning Center)', 'ChurchSuite', 'Elvanto', 'Breeze', 'Subsplash', 'Elexio'):
            self.assertEqual(by_provider[provider], [''], provider)
        self.assertTrue(all(e['status'] == ('found' if e['feed_url'] else 'link') for e in found))
        self.assertTrue(all(builder_calendar.is_feed_url(e['feed_url']) for e in found if e['feed_url']))
        many = anchors(*[(f'https://grace.test/c{n}.ics', 'Calendar') for n in range(15)])
        self.assertEqual(len(builder_calendar.detect([many])), builder_calendar.MAX_CALENDARS)

    def test_only_derived_shapes_are_feed_urls(self):
        self.assertTrue(builder_calendar.is_feed_url(FBC_FEED))
        for url in ('https://calendar.google.com/calendar/embed?src=x', 'http://grace.test/a.ics', 'https://grace.test/about',
                    'https://calendar.google.com/calendar/u/0/r', 'file:///etc/passwd.ics'):
            self.assertFalse(builder_calendar.is_feed_url(url), url)


class RecurrenceTests(unittest.TestCase):
    def setUp(self):
        self.items = synthetic()

    def test_weekly_events_become_one_highlight(self):
        supper = [i['value'] for i in self.items if i['value']['name'] == 'Wednesday Supper']
        self.assertEqual(supper, [{'name': 'Wednesday Supper', 'location': 'Fellowship Hall',
                                   'when': 'Weekly on Wednesday at 6:30 PM'}])
        self.assertNotIn('Alarm text is not an event', [i['value']['name'] for i in self.items])

    def test_ended_and_counted_rules(self):
        self.assertEqual(dated(self.items, 'Old Tuesday Study'), [])  # UNTIL 2017
        self.assertEqual(dated(self.items, 'Membership Class'), [('2030-01-06', '12:00 PM'), ('2030-01-13', '12:00 PM')])

    def test_monthly_yearly_and_interval(self):
        self.assertEqual([d for d, _ in dated(self.items, 'Communion Sunday')][:3], ['2030-01-06', '2030-02-03', '2030-03-03'])
        self.assertEqual([d for d, _ in dated(self.items, 'Food Pantry')][:2], ['2030-01-15', '2030-02-15'])
        self.assertEqual(dated(self.items, 'Food Pantry')[0][1], '')  # all day
        self.assertEqual(dated(self.items, 'Church Anniversary'), [('2030-03-01', '4:00 PM')])
        self.assertEqual([d for d, _ in dated(self.items, 'Youth Night')][:3], ['2030-01-17', '2030-01-31', '2030-02-14'])

    def test_exdate_and_moved_occurrence(self):
        elders = [d for d, _ in dated(self.items, 'Elders Meeting')]
        self.assertNotIn('2030-01-29', elders)  # moved
        self.assertNotIn('2030-02-26', elders)  # EXDATE
        self.assertIn('2030-03-26', elders)
        self.assertEqual(dated(self.items, 'Elders Meeting (moved)'), [('2030-01-30', '7:00 PM')])

    def test_times_dates_and_cancelled(self):
        self.assertEqual(dated(self.items, 'Winter Concert'), [('2030-02-14', '7:00 PM')])  # 00:00Z is 7 PM in New York
        self.assertEqual(dated(self.items, "Women's Retreat"), [('2030-03-20', '')])
        names = {i['value']['name'] for i in self.items}
        self.assertNotIn('Cancelled Breakfast', names)
        self.assertNotIn('Past Event', names)
        self.assertTrue(all((i['value'].get('date') or '') <= '2030-07-08' for i in self.items))

    def test_limit_and_unsupported_rules(self):
        self.assertEqual(len(builder_calendar.events(SOURCE, (FIXTURE / 'synthetic.ics').read_text(), TODAY, 183, 5)), 5)
        rule = builder_calendar._rule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')
        self.assertEqual(builder_calendar.occurrences(date(2030, 1, 31), rule, date(2030, 6, 1)), [date(2030, 1, 31)])


class CrawlTests(unittest.TestCase):
    def test_the_crawl_never_reads_a_blocked_feed_and_lists_what_it_found(self):
        log = []
        _, fixture_feed = builder_score.fixture_fetchers(FIXTURE / 'site')

        def fetch_feed(url):
            log.append(url)
            return fixture_feed(url)
        session = import_site(fetch_feed=fetch_feed)
        self.assertNotIn('https://events.example.org/grace/events.ics', log)
        self.assertFalse(any('calendar.google.com' in u and not u.endswith('/robots.txt') for u in log), log)
        calendars = {c['provider']: c for c in session['site']['calendars']}
        self.assertEqual(calendars['Google Calendar']['feed_url'], FBC_FEED)
        self.assertEqual((calendars['Google Calendar']['status'], calendars['Google Calendar']['robots_allowed']), ('found', False))
        self.assertEqual((calendars['iCal']['status'], calendars['iCal']['robots_allowed']), ('found', False))
        self.assertEqual(calendars['Church Center (Planning Center)']['status'], 'link')
        self.assertEqual(calendars['Tockify']['feed_url'], 'https://tockify.com/api/feeds/ics/gracechapel')
        self.assertEqual(session['collections'].get('events', []), [])
        self.assertTrue(session['file_check']['valid'], session['file_check'])
        site_file = builder_json.files(session)['site']
        self.assertEqual(builder_json.validate('site', site_file), [])
        self.assertEqual(len(site_file['calendars']), 4)

    def test_import_adds_events_once_and_keeps_the_files_valid(self):
        session = import_site()
        text = (FIXTURE / 'synthetic.ics').read_text(encoding='utf-8')
        fetched = []

        def fetch(url):
            fetched.append(url)
            return url, text
        with mock.patch.object(builder_structured, '_today', lambda: TODAY):
            added = builder.import_calendar(session, 'cal1', fetch=fetch)
            again = builder.import_calendar(session, 'cal1', fetch=fetch)
        self.assertEqual(fetched, [FBC_FEED, FBC_FEED])
        self.assertGreater(added, 20)
        self.assertEqual(again, 0)
        entry = session['site']['calendars'][0]
        self.assertEqual((entry['status'], entry['count']), ('imported', 0))
        names = [e['value']['name'] for e in session['collections']['events']]
        self.assertEqual(names.count('Wednesday Supper'), 1)
        self.assertTrue(any(n.startswith('Imported ') for n in session['notes']))
        check = builder_json.check(session)
        self.assertTrue(check['valid'], check['errors'])

    def test_a_feed_that_fails_is_marked(self):
        session = import_site()
        with self.assertRaises(ValueError):
            builder.import_calendar(session, 'cal1', fetch=mock.Mock(side_effect=httpx.ConnectError('down')))
        self.assertEqual(session['site']['calendars'][0]['status'], 'failed')
        builder.decline_calendar(session, 'cal2')
        self.assertEqual(session['site']['calendars'][1]['status'], 'declined')


class ConsentFetchTests(unittest.TestCase):
    def test_only_derived_feeds_are_fetched_and_redirects_stay_on_them(self):
        with self.assertRaises(ValueError):
            builder._http_calendar('https://grace.test/about')
        seen = []

        def handler(request):
            seen.append(str(request.url))
            if request.url.path.endswith('/moved.ics'):
                return httpx.Response(302, headers={'location': 'https://grace.test/admin'})
            return httpx.Response(200, text='BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
        real = httpx.Client
        with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1', 'BUILDER_FETCH_URL': ''}), \
                mock.patch.object(builder.httpx, 'Client', lambda **kw: real(transport=httpx.MockTransport(handler), **kw)):
            self.assertEqual(builder._http_calendar(FBC_FEED), (FBC_FEED, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'))
            with self.assertRaises(ValueError):
                builder._http_calendar('https://grace.test/moved.ics')
        self.assertEqual(seen, [FBC_FEED, 'https://grace.test/moved.ics'])


class RouteTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        fetch, fetch_feed = builder_score.fixture_fetchers(FIXTURE / 'site')
        for patcher in (mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1', 'BUILDER_AI': '0'}),
                        mock.patch.object(builder, '_http_fetch', fetch),
                        mock.patch.object(builder, '_http_feed', fetch_feed),
                        mock.patch.object(builder, '_http_css', mock.Mock(side_effect=FileNotFoundError)),
                        mock.patch.object(builder, '_ai_complete', None),
                        mock.patch.object(builder, '_ai_describe', None),
                        mock.patch.object(builder_structured, '_today', lambda: TODAY)):
            patcher.start()
            self.addCleanup(patcher.stop)
        builder.import_limiter.reset()
        self.addCleanup(builder.import_limiter.reset)
        response = self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'})
        self.assertEqual(response.status_code, 202, response.text)
        builder.wait_for_imports()
        self.sid = response.json()['id']

    def test_import_reads_only_the_stored_feed(self):
        text = (FIXTURE / 'synthetic.ics').read_text(encoding='utf-8')
        calendar = mock.Mock(return_value=(FBC_FEED, text))
        with mock.patch.object(builder, '_http_calendar', calendar):
            response = self.client.post(f'/api/builder/drafts/{self.sid}/calendars/cal1/import',
                                        json={'url': 'https://evil.test/x.ics'})
            self.assertEqual(response.status_code, 200, response.text)
            calendar.assert_called_once_with(FBC_FEED)
            draft = response.json()
            self.assertEqual(draft['site']['calendars'][0]['status'], 'imported')
            self.assertGreater(draft['site']['calendars'][0]['count'], 20)
            self.assertEqual(self.client.post(f'/api/builder/drafts/{self.sid}/calendars/nope/import').status_code, 404)
            self.assertEqual(self.client.post(f'/api/builder/drafts/{self.sid}/calendars/cal9/import').status_code, 404)
        site_file = self.client.get(f'/api/builder/drafts/{self.sid}/site.json').json()
        self.assertEqual(site_file['calendars'][0]['status'], 'imported')
        self.assertEqual(builder_json.validate('site', site_file), [])

    def test_a_failed_import_and_decline(self):
        with mock.patch.object(builder, '_http_calendar', mock.Mock(side_effect=ValueError('down'))):
            response = self.client.post(f'/api/builder/drafts/{self.sid}/calendars/cal2/import')
        self.assertEqual(response.status_code, 400)
        self.assertIn('public', response.json()['detail'])
        self.assertEqual(builder._load(self.sid)['site']['calendars'][1]['status'], 'failed')
        response = self.client.post(f'/api/builder/drafts/{self.sid}/calendars/cal1/decline')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['site']['calendars'][0]['status'], 'declined')


if __name__ == '__main__':
    unittest.main()
