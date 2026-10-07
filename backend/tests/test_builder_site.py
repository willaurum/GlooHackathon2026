"""The site model: menu tree, page sections, classified links and calls to action, forms and media.

Runs offline against fixtures/builder/snappage-like, a fictional church site shaped like a hosted site builder's:
dropdown menus with label-only parents, off-site sign-ups and giving, embedded players, a sitemap of http://
addresses, many daily posts, robots.txt with Crawl-delay and wildcard rules, and hidden instructions.
"""
import json
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from backend.app import builder, builder_score, builder_site

FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'builder' / 'snappage-like'
EXPECTED = json.loads((FIXTURE / 'expected.json').read_text(encoding='utf-8'))
_SESSION = {}


def harvest():
    if 'session' not in _SESSION:
        fetched = []
        fetch, fetch_feed = builder_score.fixture_fetchers(FIXTURE)

        def recording(url):
            fetched.append(url)
            return fetch(url)
        with mock.patch.object(builder_score, 'fixture_fetchers', lambda root: (recording, fetch_feed)), \
                mock.patch.object(builder, '_ai_complete', side_effect=AssertionError('AI forbidden')):
            _SESSION['session'] = builder_score.import_fixture(FIXTURE)
        _SESSION['fetched'] = fetched
    return _SESSION['session'], _SESSION['fetched']


class SnappageFixtureTests(unittest.TestCase):
    def test_fields_lists_and_site_parts_score(self):
        session, _ = harvest()
        result = builder_score.score(session, EXPECTED)
        self.assertEqual(result['summary'], 'Harvest Point (Snappages-like): 5/5 fields correct, 0 false questions')
        lists = {name: (r['precision'], r['recall']) for name, r in builder_score.score_lists(session, EXPECTED).items()}
        self.assertEqual(lists, {'events': (1.0, 1.0), 'staff': (1.0, 1.0), 'sermons': (1.0, 1.0)})
        site = {name: r['recall'] for name, r in builder_score.score_site(session, EXPECTED).items()}
        self.assertEqual(set(site.values()), {1.0}, site)

    def test_crawl_is_polite_and_skips_what_it_should(self):
        session, fetched = harvest()
        self.assertNotIn('https://church.test/assets/internal', fetched)  # robots.txt: Disallow /assets/*
        self.assertTrue(all(url.startswith('https://') for url in fetched))  # the sitemap's http:// upgraded
        self.assertEqual(sum('/blog/' in url for url in fetched), 3)
        self.assertTrue(any('pause 0.02 seconds' in note for note in session['notes']))

    def test_hidden_instructions_change_nothing(self):
        session, _ = harvest()
        self.assertEqual(session['fields']['email']['value'], 'hello@harvestpoint.example.org')
        everything = json.dumps(session)
        self.assertNotIn('evil.example', everything)
        self.assertNotIn('Eve Mallory', everything)

    def test_dates_without_a_year_follow_their_weekday(self):
        session, _ = harvest()
        events = {e['value']['name']: e['value']['date'] for e in session['collections']['events']}
        self.assertEqual(events, {'Fall Festival': '2030-10-27', "Women's Retreat": '2030-11-08'})

    def test_menu_tree(self):
        session, _ = harvest()
        main = session['site']['navigation']['main']
        about = next(item for item in main if item['label'] == 'About')
        self.assertEqual(about['url'], '')  # a label that only opens its submenu
        self.assertEqual([(c['label'], c['page_id'] != '') for c in about['children']],
                         [('Who We Are', True), ('Our Team', True), ('Beliefs', True)])
        groups = next(c for item in main for c in item['children'] if c['label'] == 'Groups')
        self.assertEqual((groups['url'], groups['page_id']), ('https://harvestpoint.churchcenter.com/groups', ''))
        # The shorter mobile menu is a copy, not a second menu.
        self.assertEqual(sum(item['label'] == 'Give' for item in main), 1)
        self.assertEqual([f['label'] for f in session['site']['navigation']['footer']][:2], ['Facebook', 'Instagram'])

    def test_sections_keep_their_buttons_and_players_but_not_the_footer(self):
        session, _ = harvest()
        home = next(p for p in session['site']['pages'] if p['path'] == '/')
        sections = {s['heading']: s for s in home['sections']}
        self.assertEqual(sections['Welcome Home']['links'], ['https://church.test/visit', 'https://church.test/live'])
        self.assertEqual(sections['Latest Message']['embeds'], ['https://www.youtube.com/watch?v=HPmsg000001'])
        self.assertNotIn('4410 Orchard Hill Road', json.dumps(home['sections']))  # repeated footer text
        posts = [p for p in session['site']['pages'] if '/blog/' in p['path']]
        self.assertTrue(posts and not any(p['include'] for p in posts))

    def test_calls_to_action_have_context_and_forms_have_no_values(self):
        session, _ = harvest()
        links = {l['url']: l for l in session['site']['links']}
        rsvp = links['https://www.evite.com/event/harvestpoint-fall-fest']
        self.assertEqual((rsvp['kind'], rsvp['provider'], rsvp['cta'], rsvp['context']), ('form', 'Evite', True, 'Fall Festival'))
        forms = session['site']['forms']
        self.assertEqual(len(forms), 1)  # the search box is not a form to recreate
        self.assertEqual([(f['label'], f['type'], f['required']) for f in forms[0]['fields']],
                         [('Your name', 'text', True), ('Email', 'email', True), ('Phone', 'tel', False),
                          ('How can we pray for you?', 'textarea', False)])
        self.assertEqual(forms[0]['submit'], 'Send')
        self.assertNotIn('secret-token-123', json.dumps(session))
        self.assertNotIn('Type here', json.dumps(forms))


class ClassifyTests(unittest.TestCase):
    def test_providers(self):
        origin = 'church.test'
        for url, expected in [
                ('https://x.churchcenter.com/giving', ('giving', 'Church Center')),
                ('https://x.churchcenter.com/people/forms/1', ('form', 'Church Center')),
                ('https://subsplash.com/u/-ABC/give', ('giving', 'Subsplash')),
                ('https://player.castr.com/live_1', ('livestream', 'Castr')),
                ('https://www.youtube.com/@church/live', ('livestream', 'YouTube')),
                ('https://youtu.be/abcdefghijk', ('video', 'YouTube')),
                ('https://docs.google.com/forms/d/1/viewform', ('form', 'Google Forms')),
                ('https://maps.app.goo.gl/abc', ('map', 'Google Maps')),
                ('https://x.com/church', ('social', 'X')),
                ('https://church.test/files/bulletin.pdf', ('document', '')),
                ('https://church.test/give', ('giving', '')),
                ('https://church.test/about', ('page', '')),
                ('https://www.church.test/about', ('page', '')),
                ('https://other.example/donate', ('giving', 'other.example')),
                ('https://other.example/about', ('external', 'other.example'))]:
            with self.subTest(url=url):
                self.assertEqual(builder_site.classify(url, origin), expected)

    def test_only_web_addresses_are_kept(self):
        source = {'id': 's1', 'kind': 'page', 'url': 'https://church.test/', 'title': 'Home', 'text': 'Give now',
                  'anchors': [('javascript:alert(1)', 'Give now', False), ('data:text/html,hi', 'Give', False)],
                  'embeds': [('javascript:alert(1)', 'x')], 'nav': [(1, 'nav', 1, 'Home', 'javascript:void(0)')]}
        site = builder_site.build([source], 'https://church.test/')
        self.assertEqual((site['links'], site['media']), ([], []))
        self.assertEqual(site['navigation']['main'][0]['url'], '')

    def test_a_site_without_list_menus_uses_its_nav_links(self):
        page = builder.parse_html('<nav><a href="/">Home</a> <a href="/visit">Visit</a></nav><h1>Hi</h1><p>Welcome</p>')
        source = {'id': 's1', 'kind': 'page', 'url': 'https://church.test/', 'title': 'Home', 'text': page['text'],
                  'anchors': [(f'https://church.test{h}', t, n) for h, t, n in page['anchors']], 'nav': page['nav'],
                  'headings': page['headings']}
        menu = builder_site.build([source], 'https://church.test/')['navigation']['main']
        self.assertEqual([(m['label'], m['url']) for m in menu],
                         [('Home', 'https://church.test/'), ('Visit', 'https://church.test/visit')])


if __name__ == '__main__':
    unittest.main()
