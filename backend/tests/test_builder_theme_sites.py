"""Colors from site builders that name their parts their own way."""

import unittest

from backend.app import builder_theme

# Trimmed from Crosspoint Church's SnapPages theme (crosspointonline.com): the brand orange is only on
# "#sp-header", "#sp-nav" and ".sp-scheme-0 .sp-button", never on header, nav, .btn or a.
SNAPPAGES = ('body{background-color:#cccccc}'
             '#sp-header{flex-wrap:wrap;background-color:#f16938}#sp-nav{padding:20px;color:#ffffff;background-color:#f16938}'
             '#sp-nav-links>ul>li>a:hover{color:#1d2529}#sp-nav-links>ul>li>ul>li>a:hover{color:#FFF;background:#1d2529}'
             '.sp-scheme-0{color:#595959;background-color:#FFFFFF}'
             '.sp-scheme-0 a:not(.sp-button):link{color:#f16938}.sp-scheme-0 .sp-button{color:#ffffff;background-color:#f16938}'
             'h1,h2,h3{font-family:"Lato",Arial,sans-serif}')


class SiteBuilderThemeTests(unittest.TestCase):
    def test_snappages_header_and_buttons(self):
        theme = builder_theme.theme({}, [SNAPPAGES])
        self.assertEqual(theme['primary'], '#f16938')
        self.assertEqual(theme['accent'], '#f16938')
        self.assertEqual(theme['heading_font'], 'Lato')

    def test_hover_states_are_not_the_brand(self):
        theme = builder_theme.theme({}, ['.site-header:hover{background:#123456}.site-header{background:#2a7ab0}'])
        self.assertEqual(theme['primary'], builder_theme.readable_on_white('#2a7ab0'))

    def test_most_used_saturated_color_when_nothing_names_one(self):
        css = ('body{background:#ffffff;color:#333333}.a{color:#2a7ab0}.b{border-color:#2a7ab0}.c{fill:#2a7ab0}'
               '.d{color:#888888}.e{background:#e55555}')
        theme = builder_theme.theme({}, [css])
        self.assertEqual(theme['accent'], builder_theme.readable_on_white('#2a7ab0'))  # used three times
        self.assertEqual(theme['primary'], builder_theme.readable_on_white('#e55555'))
        self.assertEqual(builder_theme.theme({}, ['body{color:#333;background:#fff}.x{color:#777}'])['accent'], '')


if __name__ == '__main__':
    unittest.main()
