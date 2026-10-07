"""The demo's "outdated website" (cedar-hollow-millbrook): a one-page church site with traps planted on purpose."""

import os
import unittest
from unittest import mock

from backend.app import builder, builder_agents, builder_structured
from backend.tests.test_builder import site


class DemoSiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with mock.patch.dict(os.environ, {'BUILDER_ALLOW_PRIVATE': '1'}):
            cls.session = builder.new_session('https://church.test/', fetch=site('cedar-hollow-millbrook'),
                                              complete=lambda m, t: None, describe=False)

    def test_website_and_bulletin_service_times_are_asked(self):
        services = self.session['fields']['services']
        self.assertEqual(services['status'], 'conflict')
        self.assertEqual(sorted(c['value'][0]['time'] for c in services['candidates']), ['09:00', '10:00'])
        quotes = {c['quote'] for c in self.session['claims'] if c['field'] == 'services'}
        self.assertIn('Sunday, October 4, 2026 Worship — 10:00 AM', quotes)

    def test_youth_group_is_not_a_service_time(self):
        times = {c['value']['time'] for c in self.session['claims'] if c['field'] == 'services'}
        self.assertNotIn('18:00', times)
        self.assertEqual(builder.service_times('Youth Group\nSundays, 6:00 PM'), {})
        self.assertEqual(builder.service_times('Sunday Worship\nSundays, 9:00 AM')['Sunday'][0][0], '09:00')

    def test_staff_is_the_pastor_not_menu_or_order_of_worship(self):
        staff = builder_structured.staff_cards(self.session['sources'][0])
        self.assertEqual([s['value'] for s in staff], [{'name': 'Dan Whitfield', 'role': 'Pastor'}])
        lines = {'id': 's', 'text': 'What We Believe\nMinistries\nPastor Dan Whitfield\nCall to Worship\nJane Smith\nYouth Pastor'}
        self.assertEqual([s['value']['name'] for s in builder_structured.staff_cards(lines)], ['Jane Smith'])

    def test_colors_come_from_the_header_menu_and_page(self):
        theme = self.session['site']['theme']
        self.assertEqual(theme['primary'], '#3e5631')  # the header gradient's deeper green
        self.assertEqual(theme['background'], '#ffffff')  # the page, not the patterned backdrop around it
        self.assertNotEqual(theme['accent'], '#3e6fa8')  # the menu's gold highlight, not the plain link blue
        self.assertTrue(theme['accent'])

    def test_a_one_page_site_gets_its_list_readers(self):
        self.assertEqual(builder_agents.specialists_for(self.session['sources'][0]), ('events', 'ministries'))
        self.assertEqual(builder_agents.specialists_for({'kind': 'page', 'page_type': 'home', 'text': 'Welcome\nService Times'}), ())


if __name__ == '__main__':
    unittest.main()
