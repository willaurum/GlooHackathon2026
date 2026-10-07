"""Sermon highlights are tagged by Gloo (GLOO_NOTES_MODEL, else GLOO_MODEL), straight from the container.

A window Gloo can't tag (no key, an HTTP error, a timeout, a reply without the JSON) falls back to the
Worker's Workers AI /llm bridge; a window neither can tag is skipped. Highlights never fail a note, and
the note records which model tagged it (notes.highlight_engine).
"""

import json
import os
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

import httpx

from backend.app import db, pastor_notes
from backend.tests.test_churches import ChurchTestCase

NOTE = '11111111-2222-3333-4444-555555555555'
SEGMENTS = [{'start': 0.0, 'end': 9.0, 'text': 'Jesus said love your neighbor as yourself.'},
            {'start': 9.0, 'end': 18.0, 'text': 'When I was twelve my father took me fishing.'}]
GLOO_URL = 'https://platform.ai.gloo.com/ai/v2/guarded/chat/completions'
FALLBACK_TAG = 'workers-ai:@cf/meta/llama-3.1-8b-instruct-fp8'
TAGS = {'annotations': [
    {'seg_from': 0, 'seg_to': 0, 'category': 'bible_quote', 'label': 'Mark 12:31', 'confidence': 0.9},
    {'seg_from': 1, 'seg_to': 1, 'category': 'personal_story', 'label': 'fishing with his father', 'confidence': 0.8},
]}


def response(status=200, body=None, text=None):
    return mock.Mock(status_code=status, text=text if text is not None else json.dumps(body or {}), json=lambda: body)


def gloo_reply(content):
    return response(body={'choices': [{'message': {'role': 'assistant', 'content': content}}]})


def env(**values):
    """Only the given AI variables are set."""
    clean = {k: v for k, v in os.environ.items() if k not in ('GLOO_API_KEY', 'GLOO_MODEL', 'GLOO_NOTES_MODEL')}
    return mock.patch.dict(os.environ, {**clean, **values}, clear=True)


class GlooRequestTests(unittest.TestCase):
    def test_the_request_is_the_chat_completions_shape_gloo_documents(self):
        with env(GLOO_API_KEY='test-key'), \
                mock.patch.object(pastor_notes.httpx, 'post', return_value=gloo_reply(json.dumps(TAGS))) as post, \
                mock.patch.object(pastor_notes._ai, 'post') as bridge:
            annotations, engine = pastor_notes.categorize(SEGMENTS)
        bridge.assert_not_called()
        post.assert_called_once()
        url, kwargs = post.call_args.args[0], post.call_args.kwargs
        self.assertEqual(url, GLOO_URL)
        self.assertEqual(kwargs['headers']['Authorization'], 'Bearer test-key')
        body = kwargs['json']
        self.assertIs(body['auto_routing'], False)
        self.assertEqual(body['model'], 'gloo-qwen-3.7-flash')
        self.assertEqual(body['temperature'], 0)
        self.assertGreaterEqual(body['max_tokens'], 2048)  # a reasoning model's thinking counts toward it
        self.assertEqual(body['messages'][0]['role'], 'user')
        self.assertIn('[0] Jesus said love your neighbor', body['messages'][0]['content'])
        self.assertIn('[1] When I was twelve', body['messages'][0]['content'])
        self.assertEqual(kwargs['timeout'].read, 60)
        self.assertEqual(engine, 'gloo:gloo-qwen-3.7-flash')
        self.assertEqual([a['category'] for a in annotations], ['bible_quote', 'personal_story'])

    def test_gloo_notes_model_wins_then_gloo_model(self):
        cases = [({'GLOO_NOTES_MODEL': 'gloo-notes-x', 'GLOO_MODEL': 'gloo-chat-y'}, 'gloo-notes-x'),
                 ({'GLOO_NOTES_MODEL': ' ', 'GLOO_MODEL': 'gloo-chat-y'}, 'gloo-chat-y'),
                 ({}, 'gloo-qwen-3.7-flash')]
        for values, expected in cases:
            with self.subTest(values=values), env(GLOO_API_KEY='k', **values), \
                    mock.patch.object(pastor_notes.httpx, 'post', return_value=gloo_reply('{"annotations": []}')) as post:
                _, engine = pastor_notes.categorize(SEGMENTS)
            self.assertEqual(post.call_args.kwargs['json']['model'], expected)
            self.assertEqual(engine, f'gloo:{expected}')


class FallbackTests(unittest.TestCase):
    def fallback(self):
        return mock.patch.object(pastor_notes._ai, 'post', return_value=response(body={'text': json.dumps(TAGS), 'model': FALLBACK_TAG}))

    def test_without_a_key_gloo_is_not_called_and_workers_ai_tags_the_window(self):
        with env(), mock.patch.object(pastor_notes.httpx, 'post') as post, self.fallback() as bridge:
            annotations, engine = pastor_notes.categorize(SEGMENTS)
        post.assert_not_called()
        self.assertEqual(bridge.call_args.args[0], '/llm')
        self.assertEqual(engine, FALLBACK_TAG)
        self.assertEqual(len(annotations), 2)

    def test_a_gloo_error_timeout_or_unusable_reply_falls_back(self):
        failures = [{'return_value': response(502, text='bad gateway')},
                    {'side_effect': httpx.ReadTimeout('slow')},
                    {'return_value': gloo_reply('<think>long thoughts</think>I could not find anything.')},
                    {'return_value': gloo_reply('')}]
        for failure in failures:
            with self.subTest(failure=failure), env(GLOO_API_KEY='k'), \
                    mock.patch.object(pastor_notes.httpx, 'post', **failure), self.fallback() as bridge:
                annotations, engine = pastor_notes.categorize(SEGMENTS)
            bridge.assert_called_once()
            self.assertEqual(engine, FALLBACK_TAG)
            self.assertEqual(len(annotations), 2)

    def test_when_both_fail_the_window_is_skipped_without_raising(self):
        with env(GLOO_API_KEY='k'), mock.patch.object(pastor_notes.httpx, 'post', side_effect=httpx.ConnectError('down')), \
                mock.patch.object(pastor_notes._ai, 'post', return_value=response(502, text='Workers AI call failed')):
            self.assertEqual(pastor_notes.categorize(SEGMENTS), ([], 'none'))

    def test_long_transcripts_are_windowed_and_the_engine_names_every_model_used(self):
        segments = [{'start': i * 10.0, 'end': i * 10.0 + 10, 'text': ' '.join(['word'] * 500)} for i in range(9)]
        windows = list(pastor_notes._windows(segments))
        self.assertEqual(len(windows), 3)  # about CATEGORIZE_WORDS words each

        def gloo(url, **kwargs):
            prompt = kwargs['json']['messages'][0]['content']
            if '[3]' in prompt:  # the second window fails on Gloo
                return response(500, text='oops')
            first = int(prompt.split('Segments:\n[', 1)[1].split(']', 1)[0])
            return gloo_reply(json.dumps({'annotations': [
                {'seg_from': first, 'seg_to': first, 'category': 'bible_quote', 'label': f'w{first}', 'confidence': 0.9}]}))
        bridge_reply = response(body={'text': '{"annotations": [{"seg_from": 4, "seg_to": 99, "category": "recent_event", '
                                              '"label": "news", "confidence": 0.7}]}', 'model': FALLBACK_TAG})
        with env(GLOO_API_KEY='k'), mock.patch.object(pastor_notes.httpx, 'post', side_effect=gloo) as post, \
                mock.patch.object(pastor_notes._ai, 'post', return_value=bridge_reply):
            annotations, engine = pastor_notes.categorize(segments)
        self.assertEqual(post.call_count, 3)
        self.assertEqual(engine, f'gloo:gloo-qwen-3.7-flash+{FALLBACK_TAG}')
        # In transcript order, and the fallback's range is clamped to its window (segments 3..5).
        self.assertEqual([(a['seg_from'], a['seg_to'], a['label']) for a in annotations],
                         [(0, 0, 'w0'), (4, 5, 'news'), (6, 6, 'w6')])


class ParsingTests(unittest.TestCase):
    def test_reasoning_fences_and_prose_around_the_json_are_fine(self):
        payload = json.dumps(TAGS)
        replies = [
            payload,
            f'<think>The user wants {{"annotations"}}... segment [0] is a quote {{maybe}}.</think>\n{payload}',
            f'```json\n{payload}\n```',
            f'Here are the tags {{as requested}}:\n{payload}\nLet me know if you need more.',
        ]
        for reply in replies:
            with self.subTest(reply=reply[:40]):
                self.assertEqual(len(pastor_notes._parse_annotations(reply, 0, 1)), 2)

    def test_unusable_replies_give_nothing(self):
        for reply in ('', 'No passages fit.', '<think>cut off {"annotations": [', '{"tags": []}', '{"annotations": "none"}'):
            with self.subTest(reply=reply):
                self.assertIsNone(pastor_notes._annotation_items(reply))
                self.assertEqual(pastor_notes._parse_annotations(reply, 0, 1), [])

    def test_bad_items_are_dropped_and_ranges_clamped(self):
        reply = json.dumps({'annotations': [
            'not an object',
            {'seg_from': 'x', 'seg_to': 1, 'category': 'bible_quote'},
            {'seg_from': 0, 'seg_to': 1, 'category': 'made_up'},
            {'seg_from': 0, 'seg_to': 1, 'category': 'bible_quote', 'confidence': 0.2},
            {'seg_from': -5, 'seg_to': 50, 'category': 'inerrancy_claim', 'label': 'x' * 300, 'confidence': 1.5},
        ]})
        self.assertEqual(pastor_notes._parse_annotations(reply, 0, 1),
                         [{'seg_from': 0, 'seg_to': 1, 'category': 'inerrancy_claim', 'label': 'x' * 200, 'confidence': 1.0}])


class NoteTests(ChurchTestCase):
    def process(self, categorize):
        db.create_note(NOTE, 'Sunday', 'upload', r2_key=f'notes/{NOTE}/source')
        with mock.patch.object(pastor_notes, 'fetch_upload', return_value=Path('/tmp/x')), \
                mock.patch.object(pastor_notes, 'probe', return_value=(18.0, True)), \
                mock.patch.object(pastor_notes, 'split_audio', return_value=[Path('/tmp/part000.mp3')]), \
                mock.patch.object(pastor_notes, 'transcribe', return_value=list(SEGMENTS)), \
                mock.patch.object(pastor_notes, 'embed_chunks', return_value=False), \
                mock.patch.object(pastor_notes, 'categorize', **categorize):
            pastor_notes.process(NOTE)
        return db.get_note(NOTE)

    def test_the_note_records_which_model_tagged_it(self):
        annotations = pastor_notes._parse_annotations(json.dumps(TAGS), 0, 1)
        note = self.process({'return_value': (annotations, 'gloo:gloo-qwen-3.7-flash')})
        self.assertEqual((note['status'], note['highlight_engine']), ('ready', 'gloo:gloo-qwen-3.7-flash'))
        self.assertEqual(len(db.list_annotations(NOTE)), 2)

    def test_highlights_that_blow_up_never_fail_the_note(self):
        note = self.process({'side_effect': RuntimeError('boom')})
        self.assertEqual((note['status'], note['highlight_engine']), ('ready', 'none'))
        self.assertEqual(db.list_annotations(NOTE), [])

    def test_a_database_from_before_the_field_gets_it(self):
        conn = self.fake.databases.setdefault(db.DEMO_CHURCH, sqlite3.connect(':memory:', check_same_thread=False))
        conn.execute("""CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_kind TEXT NOT NULL,
            source_url TEXT, r2_key TEXT, status TEXT NOT NULL DEFAULT 'queued', error TEXT, duration REAL,
            word_count INTEGER, transcript TEXT, started_at TEXT, created_at TEXT NOT NULL DEFAULT '2026-01-01')""")
        conn.execute("INSERT INTO notes (id, title, source_kind, status) VALUES (?, 'Old', 'upload', 'ready')", (NOTE,))
        conn.commit()
        db.initialize()
        self.assertEqual(db.get_note(NOTE)['highlight_engine'], '')
        db._ready.clear()
        db.initialize()  # a restart runs it again
        self.assertEqual(db.get_note(NOTE)['highlight_engine'], '')


if __name__ == '__main__':
    unittest.main()
