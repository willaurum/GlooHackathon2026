"""The look of an imported site: colors and fonts from public styles, checked for contrast, never copied as CSS."""
import unittest

from backend.app import builder_theme
from backend.tests.test_builder_site import harvest


class ColorTests(unittest.TestCase):
    def test_color_forms(self):
        for value, expected in [('#ABC', '#aabbcc'), ('#1f4e5f', '#1f4e5f'), ('rgb(10, 80, 200)', '#0a50c8'),
                                ('rgba(10 80 200 / 1)', '#0a50c8'), ('rgba(10,80,200,.3)', ''), ('white', '#ffffff'),
                                ('red; background:url(x)', ''), ('#12345', ''), ('var(--x)', ''), ('', '')]:
            with self.subTest(value=value):
                self.assertEqual(builder_theme.color(value), expected)

    def test_contrast_and_readable_buttons(self):
        self.assertAlmostEqual(builder_theme.contrast('#000000', '#ffffff'), 21.0)
        gold = builder_theme.readable_on_white('#ffd700')
        self.assertGreaterEqual(builder_theme.contrast(gold, '#ffffff'), builder_theme.MIN_BUTTON_CONTRAST)
        self.assertEqual(builder_theme.readable_on_white('#1f4e5f'), '#1f4e5f')

    def test_fonts_are_plain_names(self):
        self.assertEqual(builder_theme.font('"Lato", Helvetica, sans-serif'), 'Lato')
        self.assertEqual(builder_theme.font('system-ui, sans-serif'), '')
        self.assertEqual(builder_theme.font('"x;}body{display:none", serif'), '')
        self.assertEqual(builder_theme.font('var(--font), serif'), '')


class ThemeTests(unittest.TestCase):
    def test_meta_variables_and_rules(self):
        css = ('/* brand */ @import url("https://fonts.example/css?family=A:wght@400;700"); :root{--brand-color:#1f4e5f;'
               '--secondary:#f4efe6;--link-color:var(--orange);--orange:#e07a2f} @media (min-width:600px){body{color:#2b2b2b}}'
               ' body{background-color:#fff;font-family:"Lato",sans-serif} h1, h2{font-family:"Playfair Display",serif}')
        look = builder_theme.theme({}, [css])
        self.assertEqual({k: look[k] for k in ('primary', 'accent', 'background', 'text', 'heading_font', 'body_font')},
                         {'primary': '#1f4e5f', 'accent': '#e07a2f', 'background': '#ffffff', 'text': '#2b2b2b',
                          'heading_font': 'Playfair Display', 'body_font': 'Lato'})
        self.assertEqual(builder_theme.theme({'theme-color': '#336699'}, [css])['primary'], '#336699')

    def test_unusable_colors_are_left_to_the_defaults(self):
        look = builder_theme.theme({}, ['body{background:#101010;color:#202020}'])
        self.assertEqual((look['background'], look['text']), ('', '#202020'))
        look = builder_theme.theme({}, ['body{background:#ffffff;color:#eeeeee}'])
        self.assertEqual(look['text'], '')  # too faint to read

    def test_stylesheets_follow_robots_and_failures_are_noted(self):
        home = {'css': '', 'meta': {}, 'styles': ['https://cdn.test/a.css', 'https://cdn.test/private/b.css',
                                                  'javascript:alert(1)', 'https://cdn.test/broken.css'],
                'logos': [], 'icons': []}
        read, notes = [], []

        def fetch_css(url):
            read.append(url)
            if 'broken' in url:
                raise ValueError('That page answered 500.')
            return ':root{--primary:#224466}'
        look, _ = builder_theme.read(home, fetch_css, lambda url: '/private/' not in url, notes)
        self.assertEqual(read, ['https://cdn.test/a.css'])  # three at most; disallowed and non-web ones skipped
        self.assertEqual(look['primary'], '#224466')
        self.assertEqual(len(notes), 1)


class FixtureThemeTests(unittest.TestCase):
    def test_harvest_point_look(self):
        session, _ = harvest()
        self.assertEqual(session['site']['theme'], {
            'primary': '#1f4e5f', 'accent': '#e07a2f', 'background': '#ffffff', 'text': '#2b2b2b',
            'heading_font': 'Playfair Display', 'body_font': 'Lato', 'logo': '', 'favicon': ''})


if __name__ == '__main__':
    unittest.main()
