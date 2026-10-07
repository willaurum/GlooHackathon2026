"""The site model: menu tree, page sections, classified links and calls to action, forms and media.

Runs offline against fixtures/builder/snappage-like, a fictional church site shaped like a hosted site builder's:
dropdown menus with label-only parents, off-site sign-ups and giving, embedded players, a sitemap of http://
addresses, many daily posts, robots.txt with Crawl-delay and wildcard rules, and hidden instructions.
"""
import json
import os
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, builder_score, builder_site, builder_structured, church_content, db, main
from backend.tests.test_churches import ChurchTestCase

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
        self.assertEqual(sections['Welcome Home']['links'], [{'text': 'Plan Your Visit', 'url': 'https://church.test/visit'},
                                                             {'text': 'Watch Live', 'url': 'https://church.test/live'}])
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



class SiteRouteTests(ChurchTestCase):
    HOPE = {'X-Church': 'hope-chapel', 'X-Church-Name': 'Hope%20Chapel', 'X-Church-City': 'Austin'}

    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        builder.import_limiter.reset()
        self.addCleanup(builder.import_limiter.reset)
        fetch, fetch_feed = builder_score.fixture_fetchers(FIXTURE)
        for patcher in (mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1', 'BUILDER_AI': '0'}),
                        mock.patch.object(builder, '_http_fetch', fetch),
                        mock.patch.object(builder, '_http_feed', fetch_feed),
                        mock.patch.object(builder, '_ai_complete', None),
                        mock.patch.object(builder, '_ai_describe', None),
                        mock.patch.object(builder_structured, '_today', lambda: date(2030, 9, 1))):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(builder.wait_for_imports)

    def imported(self):
        response = self.client.post('/api/builder/drafts', json={'url': 'https://church.test/'})
        self.assertEqual(response.status_code, 202, response.text)
        builder.wait_for_imports()
        draft = self.client.get('/api/builder/drafts/' + response.json()['id']).json()
        self.assertEqual(draft['status'], 'review', draft.get('error'))
        return draft

    def test_review_pages_and_parts_then_apply_the_site(self):
        draft = self.imported()
        sid = draft['id']
        pages = {p['path']: p for p in draft['site']['pages']}
        self.assertNotIn('sections', pages['/team'])  # the draft row stays small; sections are their own rows
        team = self.client.get(f"/api/builder/drafts/{sid}/pages/{pages['/team']['id']}").json()
        self.assertEqual([s['heading'] for s in team['sections']], ['Our Team', 'Staff', 'Elders', 'Deacons'])
        self.assertEqual(self.client.get(f'/api/builder/drafts/{sid}/pages/nope').status_code, 404)

        beliefs = pages['/beliefs']['id']
        evite = next(l['id'] for l in draft['site']['links'] if 'evite' in l['url'])
        for body in ({'part': 'pages', 'id': beliefs, 'include': False}, {'part': 'links', 'id': evite, 'include': False}):
            self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/parts', json=body).status_code, 200)
        for bad in ({'part': 'sources', 'include': False}, {'part': 'pages', 'id': 'zzz', 'include': False},
                    {'part': 'links', 'id': evite, 'rights': True}):
            self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/parts', json=bad).status_code, 400, bad)

        content = self.client.post(f'/api/builder/drafts/{sid}/preview').json()['content']
        slugs = [p['slug'] for p in content['pages']]
        self.assertIn('team', slugs)
        self.assertNotIn('beliefs', slugs)
        self.assertFalse(any(slug.startswith('blog-') for slug in slugs))  # posts are left out unless kept
        about = next(item for item in content['site']['navigation']['main'] if item['label'] == 'About')
        self.assertEqual([(c['label'], c['page']) for c in about['children']], [('Who We Are', 'about'), ('Our Team', 'team')])
        events = next(p for p in content['pages'] if p['slug'] == 'events')
        self.assertNotIn('evite', json.dumps(events))
        self.assertEqual(next(p for p in content['pages'] if p['slug'] == 'visit')['title'], 'Plan a Visit')

        self.assertEqual(self.client.post(f'/api/builder/drafts/{sid}/apply', headers=self.HOPE).status_code, 200)
        church = self.client.get('/api/church', headers=self.HOPE).json()
        self.assertEqual(church['site']['navigation']['main'][0], {'label': 'Home', 'page': 'home', 'url': '', 'children': []})
        self.assertIn({'id': 1, 'slug': 'team', 'title': 'Our Team', 'page_type': 'staff'}, church['pages'])
        self.assertNotIn('sections', json.dumps(church['pages']))
        team_page = self.client.get('/api/church/pages/team', headers=self.HOPE).json()
        self.assertEqual(team_page['sections'][2]['text'], 'Tom Baker\nLuis Romero\nGrace Kim')
        self.assertEqual(self.client.get('/api/church/pages/missing', headers=self.HOPE).status_code, 404)
        with db.use_church(builder.DRAFT_SPACE):
            left = db.query("SELECT key FROM config WHERE key LIKE ?", (f'draft:{sid}%',))
        self.assertEqual(left, [])  # applying consumes the draft and its page rows


class ContentModelTests(unittest.TestCase):
    def test_only_web_addresses_and_valid_theme_values(self):
        for bad in ({'site': {'links': [{'url': 'javascript:alert(1)'}]}},
                    {'site': {'media': [{'url': 'data:text/html,hi'}]}},
                    {'site': {'theme': {'primary': 'red; background:url(x)'}}},
                    {'site': {'theme': {'body_font': 'x;}body{display:none'}}},
                    {'pages': [{'slug': '../admin', 'title': 'X'}]},
                    {'site': {'navigation': {'main': [{'label': 'X', 'url': 'javascript:void(0)'}]}}}):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                church_content.ChurchContent(**bad)
        page = church_content.ChurchContent(pages=[{'slug': 'a', 'title': 'A', 'sections': [
            {'heading': 'H', 'embeds': ['https://www.youtube.com/watch?v=abcdefghijk', 'javascript:alert(1)']}]}])
        self.assertEqual(page.pages[0].sections[0].embeds, ['https://www.youtube.com/watch?v=abcdefghijk'])
        with self.assertRaises(church_content.ContentError):
            church_content.normalize(church_content.ChurchContent(pages=[{'slug': 'a', 'title': 'A'}, {'slug': 'a', 'title': 'B'}]))

    def test_images_without_permission_are_not_public(self):
        site = {'assets': [{'url': 'https://cdn.test/a.png', 'rights': False}, {'url': 'https://cdn.test/b.png', 'rights': True}]}
        public = church_content.public_church({'info': {}, 'site': site})
        self.assertEqual([a['url'] for a in public['site']['assets']], ['https://cdn.test/b.png'])


if __name__ == '__main__':
    unittest.main()
