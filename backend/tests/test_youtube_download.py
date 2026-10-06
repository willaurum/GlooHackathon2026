import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.app import pastor_notes
from backend.app.pastor_notes import NoteError, download_youtube

BOT_CHECK = "ERROR: [youtube] abc: Sign in to confirm you're not a bot."
RATE_LIMIT = "ERROR: [youtube] abc: Video unavailable. This content isn't available, try again later."
PRIVATE = 'ERROR: [youtube] abc: Private video. Sign in if you have been granted access.'


def failed(stderr):
    return subprocess.CompletedProcess([], 1, stdout='', stderr=stderr)


class YouTubeDownloadTests(unittest.TestCase):
    def setUp(self):
        self.workdir = Path(tempfile.mkdtemp())
        self.sleeps = []

    def run_with(self, results, delays='5,10'):
        """Run download_youtube with yt-dlp faked by `results`, one per call."""
        calls = iter(results)

        def fake_tool(args, timeout):
            result = next(calls)
            if result == 'ok':
                (self.workdir / 'src.webm').write_bytes(b'audio')
                return subprocess.CompletedProcess(args, 0, stdout='', stderr='')
            return result

        with mock.patch.object(pastor_notes, 'run_tool', side_effect=fake_tool) as tool, \
                mock.patch.dict(os.environ, {'YOUTUBE_RETRY_DELAYS': delays}):
            try:
                return download_youtube('https://www.youtube.com/watch?v=abcdefghijk', self.workdir,
                                        sleep=self.sleeps.append)
            finally:
                self.calls = tool.call_count

    def test_bot_check_is_retried_with_backoff(self):
        self.assertEqual(self.run_with([failed(BOT_CHECK), failed(BOT_CHECK), 'ok']).name, 'src.webm')
        self.assertEqual(self.sleeps, [5, 10])
        self.assertEqual(self.calls, 3)

    def test_gives_up_after_the_last_retry(self):
        with self.assertRaises(NoteError) as err:
            self.run_with([failed(BOT_CHECK)] * 3)
        self.assertEqual(err.exception.code, 'youtube_blocked')
        self.assertEqual(self.calls, 3)

    def test_rate_limit_counts_as_blocked_not_unavailable(self):
        with self.assertRaises(NoteError) as err:
            self.run_with([failed(RATE_LIMIT)], delays='')
        self.assertEqual(err.exception.code, 'youtube_blocked')

    def test_other_errors_are_not_retried(self):
        with self.assertRaises(NoteError) as err:
            self.run_with([failed(PRIVATE)])
        self.assertEqual(err.exception.code, 'youtube_unavailable')
        self.assertEqual((self.calls, self.sleeps), (1, []))

    def test_yt_dlp_paces_and_retries_its_own_requests(self):
        with mock.patch.object(pastor_notes, 'run_tool', return_value=failed(PRIVATE)) as tool:
            with self.assertRaises(NoteError):
                download_youtube('https://youtu.be/abcdefghijk', self.workdir, sleep=self.sleeps.append)
        args = tool.call_args.args[0]
        self.assertIn('--extractor-retries', args)
        self.assertIn('--sleep-requests', args)
        self.assertEqual(args[-2:], ['--', 'https://youtu.be/abcdefghijk'])


if __name__ == '__main__':
    unittest.main()
