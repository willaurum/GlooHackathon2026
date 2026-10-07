"""YouTube links go through the YouTube helper first (scripts/youtube-helper, api/ythelper.ts),
then a direct yt-dlp download, then fail with a code the page turns into "upload the file"."""
import contextlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

from backend.app import pastor_notes
from backend.app.pastor_notes import NoteError, download_youtube

URL = 'https://www.youtube.com/watch?v=abcdefghijk'
BOT_CHECK = "ERROR: [youtube] abc: Sign in to confirm you're not a bot."


class FakeHelper:
    """Stands in for httpx.stream against the helper; records each request."""

    def __init__(self, status=200, body=b'audio-bytes', content_type='audio/mp4', error=None):
        self.status, self.body, self.content_type, self.error = status, body, content_type, error
        self.calls = []

    def __call__(self, method, url, **kwargs):
        self.calls.append({'method': method, 'url': url, **kwargs})
        if self.error:
            raise self.error
        request = httpx.Request(method, url)
        return contextlib.nullcontext(httpx.Response(self.status, headers={'content-type': self.content_type},
                                                     content=self.body, request=request))


class YouTubeHelperTests(unittest.TestCase):
    def setUp(self):
        self.workdir = Path(tempfile.mkdtemp())
        self.direct_calls = 0

    def run_download(self, helper, env, direct='ok'):
        def fake_tool(args, timeout):
            self.direct_calls += 1
            if direct == 'ok':
                (self.workdir / 'src.webm').write_bytes(b'direct')
                return subprocess.CompletedProcess(args, 0, stdout='', stderr='')
            return subprocess.CompletedProcess(args, 1, stdout='', stderr=direct)

        base = {'YOUTUBE_RETRY_DELAYS': '', 'YT_HELPER_URL': '', 'YT_HELPER_KEY': ''}
        with mock.patch.object(pastor_notes.httpx, 'stream', side_effect=helper), \
                mock.patch.object(pastor_notes, 'run_tool', side_effect=fake_tool), \
                mock.patch.dict(os.environ, {**base, **env}):
            return download_youtube(URL, self.workdir, sleep=lambda s: None)

    def test_helper_call_shape_on_cloudflare(self):
        helper = FakeHelper()
        path = self.run_download(helper, {'YT_HELPER_URL': 'http://youtube-helper/'})
        self.assertEqual(path.name, 'src.m4a')
        self.assertEqual(path.read_bytes(), b'audio-bytes')
        self.assertEqual(self.direct_calls, 0)
        call = helper.calls[0]
        self.assertEqual((call['method'], call['url']), ('POST', 'http://youtube-helper/fetch'))
        self.assertEqual(call['json'], {'url': URL})
        # On Cloudflare the Worker adds the key; the container sends none.
        self.assertNotIn('Authorization', call['headers'])
        self.assertGreaterEqual(call['timeout'].read, 600)

    def test_local_runs_send_the_key(self):
        helper = FakeHelper(content_type='audio/webm')
        path = self.run_download(helper, {'YT_HELPER_URL': 'https://helper.example:8443', 'YT_HELPER_KEY': 'secret'})
        self.assertEqual(path.name, 'src.webm')
        self.assertEqual(helper.calls[0]['url'], 'https://helper.example:8443/fetch')
        self.assertEqual(helper.calls[0]['headers']['Authorization'], 'Bearer secret')

    def test_no_helper_means_direct_download_only(self):
        helper = FakeHelper()
        self.assertEqual(self.run_download(helper, {}).read_bytes(), b'direct')
        self.assertEqual((helper.calls, self.direct_calls), ([], 1))

    def test_helper_failures_fall_back_to_direct_download(self):
        failures = [
            FakeHelper(status=502, body=json.dumps({'error': 'youtube_blocked'}).encode(), content_type='application/json'),
            FakeHelper(status=503, body=b'{"error":"helper_not_configured"}', content_type='application/json'),
            FakeHelper(status=401, body=b'{"error":"unauthorized"}', content_type='application/json'),
            FakeHelper(status=500, body=b'<html>oops</html>', content_type='text/html'),
            FakeHelper(body=b''),
            FakeHelper(error=httpx.ConnectError('down')),
            FakeHelper(error=httpx.ReadTimeout('slow')),
        ]
        for helper in failures:
            with self.subTest(status=helper.status, error=helper.error):
                self.direct_calls = 0
                path = self.run_download(helper, {'YT_HELPER_URL': 'http://youtube-helper'})
                self.assertEqual(path.read_bytes(), b'direct')
                self.assertEqual(self.direct_calls, 1)
                path.unlink()

    def test_the_videos_own_problems_do_not_fall_back(self):
        for code in ('too_long', 'youtube_unavailable'):
            with self.subTest(code=code):
                helper = FakeHelper(status=422, body=json.dumps({'error': code}).encode(), content_type='application/json')
                with self.assertRaises(NoteError) as err:
                    self.run_download(helper, {'YT_HELPER_URL': 'http://youtube-helper'})
                self.assertEqual(err.exception.code, code)
                self.assertEqual(self.direct_calls, 0)

    def test_both_failing_ends_in_youtube_blocked(self):
        helper = FakeHelper(error=httpx.ConnectError('down'))
        with self.assertRaises(NoteError) as err:
            self.run_download(helper, {'YT_HELPER_URL': 'http://youtube-helper'}, direct=BOT_CHECK)
        self.assertEqual(err.exception.code, 'youtube_blocked')
        self.assertEqual(self.direct_calls, 1)

    def test_an_oversized_helper_response_falls_back(self):
        helper = FakeHelper(body=b'x' * 64)
        with mock.patch.object(pastor_notes, 'HELPER_MAX_BYTES', 16):
            path = self.run_download(helper, {'YT_HELPER_URL': 'http://youtube-helper'})
        self.assertEqual(path.read_bytes(), b'direct')
        self.assertEqual(sorted(p.name for p in self.workdir.iterdir()), ['src.webm'])


if __name__ == '__main__':
    unittest.main()
