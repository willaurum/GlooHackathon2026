"""The YouTube helper service itself (scripts/youtube-helper/helper.py): key check, URL allowlist,
the yt-dlp command, error codes, and temp file cleanup. yt-dlp is faked; nothing touches the network."""
import importlib.util
import json
import subprocess
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HELPER_PATH = Path(__file__).resolve().parents[2] / 'scripts' / 'youtube-helper' / 'helper.py'
spec = importlib.util.spec_from_file_location('youtube_helper', HELPER_PATH)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

KEY = 'k' * 48


class UrlAndKeyTests(unittest.TestCase):
    def test_youtube_video_links_are_allowed(self):
        for url in ('https://www.youtube.com/watch?v=abcdefghijk', 'http://youtube.com/watch?v=abcdefghijk&t=10',
                    'https://m.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk?si=x',
                    'https://www.youtube.com/shorts/abcdefghijk', 'https://www.youtube.com/live/abcdefghijk',
                    'https://www.youtube.com:443/watch?v=abcdefghijk'):
            with self.subTest(url=url):
                self.assertEqual(helper.video_id(url), 'abcdefghijk')

    def test_everything_else_is_refused(self):
        for url in ('http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:8096/health', 'file:///etc/passwd',
                    'https://evil.example/watch?v=abcdefghijk', 'https://youtube.com.evil.example/watch?v=abcdefghijk',
                    'https://evilyoutube.com/watch?v=abcdefghijk', 'https://user@www.youtube.com/watch?v=abcdefghijk',
                    'https://www.youtube.com:8080/watch?v=abcdefghijk', 'https://www.youtube.com/playlist?list=PL1',
                    'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/watch?v=abcdefghij!',
                    'ftp://youtu.be/abcdefghijk', '', None, 42, 'https://youtu.be/' + 'a' * 600):
            with self.subTest(url=url):
                self.assertIsNone(helper.video_id(url))

    def test_key_check(self):
        self.assertTrue(helper.key_matches('Bearer ' + KEY, KEY))
        self.assertFalse(helper.key_matches('Bearer ' + KEY[:-1], KEY))
        self.assertFalse(helper.key_matches(KEY, KEY))
        self.assertFalse(helper.key_matches('', KEY))
        self.assertFalse(helper.key_matches('Bearer ', ''))

    def test_ytdlp_gets_only_the_canonical_link_and_the_limits(self):
        config = helper.Config({'YT_HELPER_KEY': KEY, 'MAX_DURATION_SEC': '5400', 'MAX_BYTES': '99614720',
                                'YTDLP': 'yt-dlp', 'YTDLP_JS_RUNTIME': 'node:/usr/bin/node'})
        args = helper.ytdlp_args(config, 'abcdefghijk', Path('/tmp/w'))
        self.assertEqual(args[-2:], ['--', 'https://www.youtube.com/watch?v=abcdefghijk'])
        self.assertIn('--ignore-config', args)
        self.assertEqual(args[args.index('--use-extractors') + 1], 'youtube')
        self.assertEqual(args[args.index('--max-filesize') + 1], '99614720')
        self.assertIn('duration <= 5400', args[args.index('--match-filter') + 1])
        self.assertTrue(args[args.index('-f') + 1].startswith('bestaudio'))
        self.assertEqual(args[args.index('--js-runtimes') + 1], 'node:/usr/bin/node')

    def test_error_codes(self):
        self.assertEqual(helper.classify("Sign in to confirm you're not a bot"), 'youtube_blocked')
        self.assertEqual(helper.classify('HTTP Error 429: Too Many Requests'), 'youtube_blocked')
        self.assertEqual(helper.classify('abc does not pass filter (duration <= 5400), skipping'), 'too_long')
        self.assertEqual(helper.classify('File is larger than max-filesize (1 bytes > 0 bytes). Aborting.'), 'too_large')
        self.assertEqual(helper.classify('ERROR: Private video'), 'youtube_unavailable')
        self.assertEqual(helper.classify('something else'), 'download_failed')


class ServerTests(unittest.TestCase):
    """The real HTTP handler on a random local port, with yt-dlp faked."""

    def setUp(self):
        self.ytdlp_calls = []
        self.workdirs = []
        self.result = 'ok'

        def fake_run(args, **kwargs):
            self.ytdlp_calls.append(args)
            out = Path(args[args.index('-o') + 1]).parent
            self.workdirs.append(out)
            if self.result == 'ok':
                (out / 'audio.m4a').write_bytes(b'm4a-audio')
                return subprocess.CompletedProcess(args, 0, '', '')
            if self.result == 'timeout':
                raise subprocess.TimeoutExpired(args, 1)
            return subprocess.CompletedProcess(args, 1, '', self.result)

        config = helper.Config({'YT_HELPER_KEY': KEY, 'YTDLP': 'yt-dlp'})
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), helper.make_handler(config, run=fake_run))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def post(self, body, key=KEY, path='/fetch'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers = {'Content-Type': 'application/json'}
        if key is not None:
            headers['Authorization'] = f'Bearer {key}'
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as err:
            return err.code, err.headers, err.read()

    def test_returns_the_audio_and_cleans_up(self):
        status, headers, body = self.post({'url': 'https://youtu.be/abcdefghijk'})
        self.assertEqual((status, headers['Content-Type'], body), (200, 'audio/mp4', b'm4a-audio'))
        self.assertEqual(self.ytdlp_calls[0][-1], 'https://www.youtube.com/watch?v=abcdefghijk')
        # The temp folder goes once the last byte is written, just after the client has it.
        for _ in range(50):
            if not self.workdirs[0].exists():
                break
            time.sleep(0.02)
        self.assertFalse(self.workdirs[0].exists())

    def test_wrong_or_missing_key_is_401_before_anything_runs(self):
        for key in ('wrong', None, KEY + 'x'):
            with self.subTest(key=key):
                status, _, body = self.post({'url': 'https://youtu.be/abcdefghijk'}, key=key)
                self.assertEqual((status, json.loads(body)['error']), (401, 'unauthorized'))
        self.assertEqual(self.ytdlp_calls, [])

    def test_non_youtube_url_is_400(self):
        for url in ('http://169.254.169.254/latest', 'https://example.com/a.mp3', 'https://youtube.com.evil.example/watch?v=abcdefghijk'):
            with self.subTest(url=url):
                status, _, body = self.post({'url': url})
                self.assertEqual((status, json.loads(body)['error']), (400, 'bad_url'))
        self.assertEqual(self.ytdlp_calls, [])

    def test_bad_bodies(self):
        self.assertEqual(self.post(b'not json')[0], 400)
        self.assertEqual(self.post(['https://youtu.be/abcdefghijk'])[0], 400)
        self.assertEqual(self.post(b'x' * 5000)[0], 413)
        self.assertEqual(self.post({'url': 'https://youtu.be/abcdefghijk'}, path='/other')[0], 404)

    def test_failures_are_json_and_clean_up(self):
        cases = [("Sign in to confirm you're not a bot", 502, 'youtube_blocked'),
                 ('abc does not pass filter (duration <= 5400)', 422, 'too_long'),
                 ('ERROR: Private video', 422, 'youtube_unavailable'),
                 ('timeout', 504, 'timeout')]
        for result, status, code in cases:
            with self.subTest(code=code):
                self.result = result
                got, headers, body = self.post({'url': 'https://youtu.be/abcdefghijk'})
                self.assertEqual((got, headers['Content-Type'], json.loads(body)['error']), (status, 'application/json', code))
                self.assertFalse(self.workdirs[-1].exists())

    def test_health_is_open(self):
        with urllib.request.urlopen(self.base + '/health', timeout=5) as response:
            self.assertEqual(json.loads(response.read()), {'ok': True})


class LoggingTests(unittest.TestCase):
    def test_the_key_never_reaches_the_log(self):
        with self.assertLogs('youtube-helper', level='INFO') as logs:
            config = helper.Config({'YT_HELPER_KEY': KEY, 'YTDLP': 'yt-dlp'})
            server = ThreadingHTTPServer(('127.0.0.1', 0), helper.make_handler(
                config, run=lambda args, **kw: subprocess.CompletedProcess(args, 1, '', 'ERROR: Private video')))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_address[1]}/fetch',
                                             data=b'{"url":"https://youtu.be/abcdefghijk"}',
                                             headers={'Authorization': f'Bearer {KEY}'}, method='POST')
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(request, timeout=10)
            server.shutdown()
            server.server_close()
        self.assertFalse(any(KEY in line for line in logs.output))


if __name__ == '__main__':
    unittest.main()
