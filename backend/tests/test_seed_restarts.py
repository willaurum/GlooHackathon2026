"""Startup seeding must not undo what staff changed. The container restarts on every deploy and whenever it
wakes after sleepAfter, and each start runs db.initialize() for the demo church again."""

import json
import unittest
from pathlib import Path
from unittest import mock

from backend.app import db
from backend.tests.test_churches import ChurchTestCase

APP = Path(__file__).resolve().parents[1] / 'app'


def restart():
    """What a new container does: forget which churches are open, then open the demo church again."""
    db._ready.clear()
    db.initialize()


NEWS_POSTS = json.loads((APP / 'news_posts.json').read_text(encoding='utf-8'))
SAMPLES = 2 + len(NEWS_POSTS)  # the two sample posts and the News posts


class BlogSeedTests(ChurchTestCase):
    def test_demo_church_starts_with_the_sample_posts(self):
        ids = sorted(p['id'] for p in db.list_blog_posts())
        self.assertEqual(ids[:2], [1, 2])
        self.assertEqual(len(ids), SAMPLES)

    def test_a_deleted_sample_post_stays_deleted_after_a_restart(self):
        self.assertTrue(db.delete_blog_post(1))
        restart()
        ids = [p['id'] for p in db.list_blog_posts()]
        self.assertNotIn(1, ids)
        self.assertEqual(len(ids), SAMPLES - 1)

    def test_a_deleted_news_post_stays_deleted_after_a_restart(self):
        post = next(p for p in db.list_blog_posts() if p['title'] == NEWS_POSTS[0]['title'])
        self.assertTrue(db.delete_blog_post(post['id']))
        restart()
        self.assertNotIn(NEWS_POSTS[0]['title'], [p['title'] for p in db.list_blog_posts()])
        self.assertEqual(len(db.list_blog_posts()), SAMPLES - 1)

    def test_a_church_seeded_before_the_news_posts_gets_them_once(self):
        db.run(("DELETE FROM blog_posts WHERE id > 2", ()), ("DELETE FROM config WHERE key = 'news_posts_seeded'", ()))
        restart()
        restart()
        self.assertEqual(len(db.list_blog_posts()), SAMPLES)

    def test_a_restart_keeps_staff_posts_and_adds_no_duplicates(self):
        db.create_blog_post('Staff post', 'Hello church', 'Pastor', ['Community'])
        restart()
        restart()
        self.assertEqual(sorted(p['title'] for p in db.list_blog_posts()).count('Staff post'), 1)
        self.assertEqual(len(db.list_blog_posts()), SAMPLES + 1)

    def test_a_new_church_gets_no_sample_posts(self):
        with db.use_church('hope-chapel', 'Hope Chapel'):
            self.assertEqual(db.list_blog_posts(), [])


class NewsSnapshotTests(ChurchTestCase):
    REFRESHED = {'id': 1001, 'country': 'Kenya', 'country_code': 'KEN', 'city': 'Nairobi', 'lat': -1.29,
                 'lng': 36.82, 'headline': 'Refreshed headline', 'source': 'Wire', 'date': '2026-10-06',
                 'summary': 'A description long enough to be used as the summary of this story.'}

    def test_a_restart_keeps_refreshed_news(self):
        db.list_news()
        db.replace_news([dict(self.REFRESHED)])  # what POST /api/news/refresh does
        restart()
        self.assertEqual([n['headline'] for n in db.list_news()], ['Refreshed headline'])

    def test_a_newer_shipped_snapshot_still_replaces_the_news(self):
        db.replace_news([dict(self.REFRESHED)])
        newer = [{**self.REFRESHED, 'id': 2002, 'headline': 'From the next deploy'}]
        with mock.patch.object(db, '_live_news', return_value=newer):
            restart()
        self.assertEqual([n['headline'] for n in db.list_news()], ['From the next deploy'])

    def test_an_existing_church_on_fictional_news_moves_to_the_snapshot(self):
        # The live demo church was created before news_live.json existed: fictional news, no marker.
        fictional = json.loads((APP / 'news.json').read_text(encoding='utf-8'))
        with mock.patch.object(db, '_live_news', return_value=[]):
            self.assertEqual({n['id'] for n in db.list_news()}, {n['id'] for n in fictional})
        restart()
        live = json.loads((APP / 'news_live.json').read_text(encoding='utf-8'))
        self.assertEqual({n['id'] for n in db.list_news()}, {n['id'] for n in live})


if __name__ == '__main__':
    unittest.main()
