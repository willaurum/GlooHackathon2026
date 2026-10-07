"""Prayer map news: the live snapshot, the fictional fallback, and the refresh endpoint."""

import json
import os
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from backend.app import db, main, newsdata
from backend.tests.test_churches import ChurchTestCase

APP = Path(__file__).resolve().parents[1] / 'app'


class NewsSeedTests(ChurchTestCase):
    def test_demo_church_serves_the_live_snapshot_only(self):
        live = json.loads((APP / 'news_live.json').read_text(encoding='utf-8'))
        self.assertTrue(live)
        self.assertEqual({n['id'] for n in db.list_news()}, {n['id'] for n in live})

    def test_fictional_news_is_the_fallback_without_a_snapshot(self):
        fictional = json.loads((APP / 'news.json').read_text(encoding='utf-8'))
        with mock.patch.object(db, '_live_news', return_value=[]):
            self.assertEqual({n['id'] for n in db.list_news()}, {n['id'] for n in fictional})

    def test_a_new_church_gets_no_news(self):
        with db.use_church('hope-chapel', 'Hope Chapel'):
            self.assertEqual(db.list_news(), [])

    def test_news_matches_the_response_model(self):
        for item in db.list_news():
            main.NewsEventOut(**item)


class RefreshTests(ChurchTestCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)

    def test_refresh_needs_a_newsdata_key(self):
        with mock.patch.dict(os.environ, {'NEWSDATA_API_KEY': ''}):
            response = self.client.post('/api/news/refresh')
        self.assertEqual(response.status_code, 503)

    def test_refresh_replaces_the_news(self):
        item = {'id': 1001, 'country': 'Kenya', 'country_code': 'KEN', 'city': 'Nairobi', 'lat': -1.29,
                'lng': 36.82, 'headline': 'Kenya headline', 'source': 'Wire', 'date': '2026-10-05',
                'url': 'https://example.com/kenya-story'}
        with mock.patch.dict(os.environ, {'NEWSDATA_API_KEY': 'test'}), \
                mock.patch.object(newsdata, 'fetch_news', return_value=[dict(item)]):
            response = self.client.post('/api/news/refresh')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([n['headline'] for n in db.list_news()], ['Kenya headline'])


class NewsdataTests(unittest.TestCase):
    def test_items_keep_the_source_url(self):
        article = {'link': 'https://example.com/story', 'source_name': 'Wire', 'pubDate': '2026-10-05 10:00:00'}
        item = newsdata._item('NPL', article, 'Floods in Nepal close roads', 'A description.')
        self.assertEqual(item['url'], 'https://example.com/story')
        self.assertNotIn('summary', item)

    def test_usable_headlines_name_the_country(self):
        description = 'A long enough description of what happened in the country this week, with details.'
        self.assertTrue(newsdata.is_usable('Nepal', 'Floods in Nepal close roads', description))
        self.assertFalse(newsdata.is_usable('Nepal', 'Floods close roads', description))


if __name__ == '__main__':
    unittest.main()
