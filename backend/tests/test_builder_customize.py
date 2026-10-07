"""The preview's Ask Tekton bar: plain-word changes to a draft's content, checked, undoable and visible on /site."""
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import builder, builder_customize, main
from backend.tests.test_builder_json_import import FILES
from backend.tests.test_churches import ChurchTestCase


class CustomizeTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        for limiter in (builder.import_limiter, builder.customize_limiter):
            limiter.reset()
            self.addCleanup(limiter.reset)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        response = self.client.post('/api/builder/drafts/json', json=FILES)
        self.assertEqual(response.status_code, 201, response.text)
        self.base = '/api/builder/drafts/' + response.json()['id']

    def ask(self, request, viewing='Home'):
        return self.client.post(self.base + '/customize', json={'request': request, 'viewing': viewing})

    def site(self):
        return self.client.get(self.base + '/site').json()

    def test_rules_change_theme_layout_and_details_and_undo_one_step_at_a_time(self):
        with mock.patch.object(builder, '_ai_available', return_value=False):
            navy = self.ask('Make the main color navy and gold')
            self.assertEqual(navy.status_code, 200, navy.text)
            self.assertEqual(navy.json()['changes'], ['Changed the main color to #1f3a5f, button color to #b8860b'])
            self.assertEqual(self.ask('put service times at the top', 'Plan your visit').json()['changes'],
                             ['Moved “Service times” on Plan your visit'])
            self.assertEqual(self.ask('hide the map').status_code, 200)
            self.assertEqual(self.ask('change the phone number to (555) 010-9999').status_code, 200)
        site = self.site()
        theme, layout = site['church']['site']['theme'], site['church']['site']['layout']
        self.assertEqual((theme['primary'], theme['accent']), ('#1f3a5f', '#b8860b'))
        self.assertEqual(layout['visit'][0], 'service_times')
        self.assertIn('visit:map', layout['hidden'])
        self.assertEqual(site['info']['phone'], '(555) 010-9999')
        # The JSON files a church downloads carry the same changes.
        files = self.client.get(self.base + '/files').json()['files']
        self.assertEqual(files['church.json']['info']['phone'], '(555) 010-9999')
        undone = self.client.post(self.base + '/customize/undo')
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertNotEqual(self.site()['info']['phone'], '(555) 010-9999')
        self.assertIn('visit:map', self.site()['church']['site']['layout']['hidden'])

    def test_unreadable_colors_and_unknown_changes_are_refused(self):
        with mock.patch.object(builder, '_ai_available', return_value=False):
            dark = self.ask('make the background color black')
            self.assertEqual(dark.status_code, 400)
            self.assertIn('light page background', dark.json()['detail'])
            vague = self.ask('can you change the colors')
            self.assertEqual(vague.status_code, 200)
            self.assertTrue(vague.json()['asking'])
            self.assertEqual(vague.json()['changes'], [])
            self.assertEqual(self.ask('do a backflip').status_code, 400)
        self.assertEqual(self.client.post(self.base + '/customize/undo').status_code, 400)

    def test_the_ai_plans_checked_operations_and_can_ask_back(self):
        plans = iter([
            {'reply': 'Done.', 'operations': [
                {'op': 'set_theme', 'primary': '#2f5d34', 'heading_font': 'Georgia'},
                {'op': 'add_faq', 'question': 'Where do I park?', 'answer': 'In the lot behind the building.'},
                {'op': 'set_theme', 'background': '#000000'},  # refused: the site stays light
                {'op': 'write_new_page', 'title': 'x'}]},  # refused: not an operation
            {'reply': 'Which color should the buttons be?', 'needs_answer': True, 'operations': []},
        ])
        seen = []

        def complete(messages, tools):
            seen.append(messages)
            self.assertEqual(tools, [builder_customize.TOOL])
            return next(plans)

        with mock.patch.object(builder, '_completer', return_value=complete), \
             mock.patch.object(builder, '_ai_available', return_value=True):
            made = self.ask('make it feel more like a forest, and tell people where to park')
            self.assertEqual(made.status_code, 200, made.text)
            self.assertEqual(len(made.json()['changes']), 2)
            self.assertEqual(len(made.json()['refused']), 2)
            asked = self.ask('and the buttons too')
            self.assertTrue(asked.json()['asking'])
        self.assertIn('make it feel more like a forest, and tell people where to park', [m['content'] for m in seen[1]])
        site = self.site()
        self.assertEqual(site['church']['site']['theme']['heading_font'], 'Georgia')
        self.assertIn('Where do I park?', [f['question'] for f in site['church']['faqs']])
        self.assertNotEqual(site['church']['site']['theme'].get('background'), '#000000')

    def test_hide_and_show_whole_parts_of_the_site(self):
        with mock.patch.object(builder, '_ai_available', return_value=False):
            hid = self.ask('can you hide the calendar our church does not have one')
            self.assertEqual(hid.status_code, 200, hid.text)
            self.assertEqual(hid.json()['changes'], ['Hid Calendar on your site'])
            self.assertEqual(self.ask("we don't have a prayer map").json()['changes'], ['Hid Prayer map on your site'])
            self.assertEqual(self.ask('hide the map').json()['changes'], ['Hid “Where we meet” on Plan your visit'])
        layout = self.site()['church']['site']['layout']
        self.assertEqual(layout['hidden_pages'], ['calendar', 'prayer'])  # a Home section change keeps them
        with mock.patch.object(builder, '_ai_available', return_value=False):
            self.assertEqual(self.ask('show the calendar again').json()['changes'], ['Showed Calendar on your site'])
            self.assertEqual(self.ask('hide the home page').status_code, 400)
        self.assertEqual(self.site()['church']['site']['layout']['hidden_pages'], ['prayer'])
        files = self.client.get(self.base + '/site.json').json()
        self.assertEqual(files['site']['layout']['hidden_pages'], ['prayer'])

    def test_the_headline_at_the_top_of_home(self):
        # Ben's test case: the wording to replace contains "to", and the new wording is the last quoted part.
        with mock.patch.object(builder, '_ai_available', return_value=False):
            made = self.ask('Could you change the top of the home page from "A place to belong, grow and give" to '
                            '"A place to grow in your relationship with the Church"?')
            self.assertEqual(made.status_code, 200, made.text)
            self.assertEqual(made.json()['changes'], ['Changed the headline at the top of Home'])
            # Built-in wording on other pages is the template's, and the refusal says what can change.
            built_in = self.ask('rename the Give with confidence heading to Generosity')
            self.assertEqual(built_in.status_code, 400)
        self.assertEqual(self.site()['info']['tagline'], 'A place to grow in your relationship with the Church')

    def test_stored_changes_that_no_longer_fit_are_skipped(self):
        content = {'info': {'name': 'Example Chapel'}, 'faqs': [{'question': 'Kids?', 'answer': 'Yes.'}]}
        out = builder_customize.apply(content, [{'op': 'remove_faq', 'question': 'Kids?'},
                                                {'op': 'remove_faq', 'question': 'Kids?'},
                                                {'op': 'set_detail', 'field': 'email', 'value': 'hello@example.org'}])
        self.assertEqual(out['faqs'], [])
        self.assertEqual(out['info']['email'], 'hello@example.org')
