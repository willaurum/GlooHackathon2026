"""Sermon-note embeddings come from Gloo through the Worker's /embed bridge, tagged with their model.

If embeddings fail, the note still becomes ready with its transcript and unembedded chunks (the Worker
embeds them later). Databases made before the tag existed are migrated: their chunks are tagged as the
old Workers AI model, so the Worker re-embeds them from the stored text instead of comparing them.
"""

import json
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

from backend.app import db, pastor_notes
from backend.tests.test_churches import ChurchTestCase

GLOO_TAG = 'gloo:gloo-baai-bge-base-en-v1.5'
NOTE = '11111111-2222-3333-4444-555555555555'
SEGMENTS = [{'start': 0.0, 'end': 9.0, 'text': 'Forgiveness is a choice you make every day.'},
            {'start': 9.0, 'end': 18.0, 'text': 'Generosity flows from a grateful heart.'}]


def response(status=200, body=None):
    return mock.Mock(status_code=status, text=json.dumps(body or {}), json=lambda: body)


def chunk_rows(slug=db.DEMO_CHURCH):
    with db.use_church(slug):
        return db.query('SELECT idx, embedding, embed_model FROM chunks WHERE note_id = ? ORDER BY idx', (NOTE,))


class EmbedTests(unittest.TestCase):
    def test_vectors_are_tagged_with_the_model_the_bridge_reports(self):
        chunks = [{'text': 'a'}, {'text': 'b'}]
        reply = response(body={'vectors': [[0.123456, 1.0], [0.5, 0.25]], 'model': GLOO_TAG})
        with mock.patch.object(pastor_notes._ai, 'post', return_value=reply) as post:
            self.assertTrue(pastor_notes.embed_chunks(chunks))
        post.assert_called_once_with('/embed', json={'texts': ['a', 'b']})
        self.assertEqual(chunks[0], {'text': 'a', 'embedding': [0.12346, 1.0], 'embed_model': GLOO_TAG})

    def test_a_failed_bridge_leaves_the_chunks_unembedded(self):
        for reply in (response(503), response(502), response(body={'vectors': [[1.0]]})):
            chunks = [{'text': 'a'}]
            with mock.patch.object(pastor_notes._ai, 'post', return_value=reply):
                self.assertFalse(pastor_notes.embed_chunks(chunks))
            self.assertEqual(chunks, [{'text': 'a'}])

    def test_a_model_change_between_batches_is_refused(self):
        chunks = [{'text': str(i)} for i in range(pastor_notes.EMBED_BATCH + 1)]
        replies = [response(body={'vectors': [[1.0]] * pastor_notes.EMBED_BATCH, 'model': GLOO_TAG}),
                   response(body={'vectors': [[1.0]], 'model': 'gloo:other'})]
        with mock.patch.object(pastor_notes._ai, 'post', side_effect=replies):
            self.assertFalse(pastor_notes.embed_chunks(chunks))
        self.assertNotIn('embedding', chunks[0])


class StorageTests(ChurchTestCase):
    def test_a_database_from_before_the_tag_is_migrated_to_the_old_model(self):
        conn = self.fake.databases.setdefault(db.DEMO_CHURCH, sqlite3.connect(':memory:', check_same_thread=False))
        conn.execute("""CREATE TABLE chunks (note_id TEXT, idx INTEGER, start REAL, "end" REAL, seg_from INTEGER,
            seg_to INTEGER, text TEXT NOT NULL, embedding TEXT NOT NULL, PRIMARY KEY (note_id, idx))""")
        conn.execute("INSERT INTO chunks VALUES (?, 0, 0, 9, 0, 0, 'old', '[0.1, 0.2]')", (NOTE,))
        conn.commit()
        db.initialize()
        self.assertEqual(chunk_rows(), [{'idx': 0, 'embedding': '[0.1, 0.2]', 'embed_model': db.LEGACY_EMBED_TAG}])
        db._ready.clear()
        db.initialize()  # a restart runs it again
        self.assertEqual(chunk_rows()[0]['embed_model'], db.LEGACY_EMBED_TAG)

    def test_save_transcript_stores_the_tag_or_marks_chunks_unembedded(self):
        db.create_note(NOTE, 'Sunday', 'upload', r2_key=f'notes/{NOTE}/source')
        chunks = pastor_notes.make_chunks(SEGMENTS)
        chunks[0].update(embedding=[0.5, 0.5], embed_model=GLOO_TAG)
        db.save_transcript(NOTE, SEGMENTS, chunks, 18.0)
        rows = chunk_rows()
        self.assertEqual((rows[0]['embedding'], rows[0]['embed_model']), ('[0.5, 0.5]', GLOO_TAG))
        self.assertTrue(all(r['embedding'] == '' and r['embed_model'] == '' for r in rows[1:]))
        self.assertEqual(db.get_note(NOTE)['status'], 'ready')


class ProcessTests(ChurchTestCase):
    def test_a_note_is_ready_with_its_transcript_when_embeddings_are_down(self):
        db.create_note(NOTE, 'Sunday', 'upload', r2_key=f'notes/{NOTE}/source')
        with mock.patch.object(pastor_notes, 'fetch_upload', return_value=Path('/tmp/x')), \
                mock.patch.object(pastor_notes, 'probe', return_value=(18.0, True)), \
                mock.patch.object(pastor_notes, 'split_audio', return_value=[Path('/tmp/part000.mp3')]), \
                mock.patch.object(pastor_notes, 'transcribe', return_value=list(SEGMENTS)) as transcribe, \
                mock.patch.object(pastor_notes, 'categorize', return_value=([], 'none')), \
                mock.patch.object(pastor_notes._ai, 'post', return_value=response(503)):
            pastor_notes.process(NOTE)
        transcribe.assert_called_once()
        note = db.get_note(NOTE)
        self.assertEqual(note['status'], 'ready')
        self.assertIsNone(note['error'])
        self.assertTrue(db.get_transcript(NOTE)['text'].startswith('Forgiveness'))
        self.assertTrue(chunk_rows())
        self.assertTrue(all(r['embed_model'] == '' and r['embedding'] == '' for r in chunk_rows()))


if __name__ == '__main__':
    unittest.main()
