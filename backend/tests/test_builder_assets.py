"""Images from the old site: referenced (never copied) and only shown once the church confirms it may use them."""
import json
import unittest

from backend.app import builder, builder_site, builder_theme, church_content
from backend.tests.test_builder_site import harvest


class AssetTests(unittest.TestCase):
    def test_logo_icon_and_share_image_await_permission(self):
        session, _ = harvest()
        self.assertEqual([(a['role'], a['url'], a['rights']) for a in session['site']['assets']], [
            ('logo', 'https://cdn.harvest.test/media/hp/logo.png', False),
            ('favicon', 'https://cdn.harvest.test/media/hp/touch-icon.png', False),
            ('share', 'https://cdn.harvest.test/media/hp/share.jpg', False)])

    def test_only_permitted_images_reach_the_theme_and_public_site(self):
        session, _ = harvest()
        site = json.loads(json.dumps(session['site']))
        content = builder_site.content(site, 'Harvest Point Church')
        self.assertEqual((content['site']['theme']['logo'], content['site']['theme']['favicon']), ('', ''))
        builder.apply_part({'site': site}, 'assets', 'a1', rights=True)
        builder.apply_part({'site': site}, 'assets', 'a3', include=False)
        content = builder_site.content(site, 'Harvest Point Church')
        self.assertEqual(content['site']['theme']['logo'], 'https://cdn.harvest.test/media/hp/logo.png')
        self.assertEqual([a['role'] for a in content['site']['assets']], ['logo', 'favicon'])
        public = church_content.public_church({'info': {}, **church_content.normalize(church_content.ChurchContent(
            site=content['site']))})
        self.assertEqual([a['role'] for a in public['site']['assets']], ['logo'])

    def test_asset_addresses_must_be_web_addresses(self):
        assets = builder_theme.assets({'logos': [('javascript:alert(1)', 'x')], 'icons': [('data:image/png;base64,AA', 'icon', '')],
                                       'meta': {'og:image': 'https://cdn.test/share.jpg'}})
        self.assertEqual([a['url'] for a in assets], ['https://cdn.test/share.jpg'])


if __name__ == '__main__':
    unittest.main()
