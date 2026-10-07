"""Blog categories come from the configured model (Gloo on Cloudflare), with the keyword rules as the fallback."""

import asyncio
import os
import unittest
from unittest import mock

from backend.app import ai_client, blog_ai

TITLE = 'Serving our neighbors'
CONTENT = 'Our outreach team packed food hampers for the neighborhood drive, and volunteers prayed together.'


def categorize(reply=None, error=None):
    generate = mock.AsyncMock(return_value=reply, side_effect=error)
    with mock.patch.object(blog_ai.ai_client, 'generate_text', generate):
        return asyncio.run(blog_ai.categorize_blog_post(TITLE, CONTENT)), generate


class BlogCategoryTests(unittest.TestCase):
    def test_the_model_reply_is_used_and_has_room_to_reason(self):
        categories, generate = categorize('["Local Outreach", "Community"]')
        self.assertEqual(categories, ['Local Outreach', 'Community'])
        self.assertGreaterEqual(generate.call_args.kwargs['max_tokens'], 1024)

    def test_reasoning_fences_and_prose_around_the_list_are_fine(self):
        for reply in ('<think>Maybe ["Prayer"]? No, outreach.</think> ["Local Outreach", "Community"]',
                      '```json\n["Local Outreach", "Community"]\n```',
                      'Categories [best guess]: ["Local Outreach", "Community"]. Hope that helps.',
                      '["Local Outreach", "Community", "Local Outreach"]'):
            with self.subTest(reply=reply[:30]):
                self.assertEqual(categorize(reply)[0], ['Local Outreach', 'Community'])

    def test_at_most_four_short_categories(self):
        categories, _ = categorize('["A", "B", "' + 'x' * 80 + '", "C", "D", "E"]')
        self.assertEqual(categories, ['A', 'B', 'C', 'D'])

    def test_no_model_or_no_usable_list_falls_back_to_the_keyword_rules(self):
        expected = blog_ai._heuristic_nlp_categories(f'{TITLE} {CONTENT}')
        self.assertIn('Local Outreach', expected)
        for kwargs in ({'error': RuntimeError('Cannot connect to AI endpoint')}, {'reply': 'I am not sure.'},
                       {'reply': '[1, 2]'}, {'reply': '<think>["Prayer"] cut off'}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(categorize(**kwargs)[0], expected)


class TimeoutTests(unittest.TestCase):
    def test_gloo_gets_the_chat_limit_and_local_models_the_ollama_limit(self):
        with mock.patch.object(ai_client, 'endpoint', return_value={'provider': 'gloo'}):
            self.assertEqual(ai_client.get_timeout(), 60.0)
        with mock.patch.dict(os.environ, {'OLLAMA_TIMEOUT': '90'}):
            for provider in ('ollama', 'local', 'custom'):
                with mock.patch.object(ai_client, 'endpoint', return_value={'provider': provider}):
                    self.assertEqual(ai_client.get_timeout(), 90.0)


if __name__ == '__main__':
    unittest.main()
