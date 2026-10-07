"""YouTube helper: downloads a sermon's audio from a home connection for Sermon Notes.

YouTube refuses downloads from Cloudflare's data-center IPs, so the Worker sends YouTube
links here first (api/ythelper.ts). This runs on Jaron's dev server, which is on a
residential ISP, and is exposed with Tailscale Funnel. See "YouTube links: the YouTube helper"
in the repo README.

POST /fetch {"url": "https://www.youtube.com/watch?v=..."} with
"Authorization: Bearer <YT_HELPER_KEY>" answers with the audio file (audio/mp4 or
audio/webm), or a JSON error {"error": "<code>", "detail": "..."}. GET /health is open.

Only the standard library, plus yt-dlp in a venv. Configuration is all environment:
  YT_HELPER_KEY or YT_HELPER_KEY_FILE   required; the shared key
  YT_HELPER_HOST, YT_HELPER_PORT        default 127.0.0.1:8096
  MAX_DURATION_SEC                      default 5400, as in the backend
  MAX_BYTES                             default 99614720, the Worker's MAX_UPLOAD_BYTES
  DOWNLOAD_TIMEOUT                      seconds for one yt-dlp run, default 600
  MAX_CONCURRENT                        downloads at once, default 2
  YTDLP                                 yt-dlp to run, default the one next to this Python
  YTDLP_JS_RUNTIME                      e.g. node:/usr/bin/node, for YouTube's JS challenges
"""

import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

log = logging.getLogger('youtube-helper')

YOUTUBE_HOSTS = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'}
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
MAX_REQUEST_BYTES = 4096
CONTENT_TYPES = {'.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg',
                 '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg'}

# Status for each error code. The backend reads the code, not the status.
STATUS = {'unauthorized': 401, 'not_found': 404, 'bad_request': 400, 'bad_url': 400, 'too_large_request': 413,
          'busy': 429, 'too_long': 422, 'too_large': 422, 'youtube_unavailable': 422, 'youtube_blocked': 502,
          'download_failed': 502, 'timeout': 504}


def video_id(url):
    """The 11-character video id of a youtube.com or youtu.be video link, or None.
    Same rules as backend/app/pastor_notes.py: anything else is refused."""
    if not isinstance(url, str) or len(url) > 500:
        return None
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return None
    host = (parsed.hostname or '').lower()
    if parsed.scheme not in ('http', 'https') or host not in YOUTUBE_HOSTS or parsed.username or parsed.password:
        return None
    try:
        if parsed.port not in (None, 80, 443):
            return None
    except ValueError:
        return None
    if host == 'youtu.be':
        candidate = parsed.path.lstrip('/').split('/')[0]
    elif parsed.path == '/watch':
        candidate = (parse_qs(parsed.query).get('v') or [''])[0]
    elif parsed.path.startswith(('/shorts/', '/live/', '/embed/')):
        parts = parsed.path.split('/')
        candidate = parts[2] if len(parts) > 2 else ''
    else:
        return None
    return candidate if VIDEO_ID.match(candidate) else None


def key_matches(header, key):
    """Constant-time check of an "Authorization: Bearer <key>" header."""
    if not key or not header or not header.startswith('Bearer '):
        return False
    return hmac.compare_digest(header[len('Bearer '):].strip().encode(), key.encode())


def classify(output):
    """An error code for a failed yt-dlp run, from its output."""
    text = output.lower()
    if 'does not pass filter' in text:
        return 'too_long'
    if 'larger than max-filesize' in text or 'file is larger than' in text:
        return 'too_large'
    if (('confirm you' in text and 'bot' in text) or 'sign in to confirm' in text
            or 'http error 429' in text or 'rate-limited' in text or 'try again later' in text):
        return 'youtube_blocked'
    if 'is unavailable' in text or 'video unavailable' in text or 'private video' in text:
        return 'youtube_unavailable'
    return 'download_failed'


class Config:
    def __init__(self, env=os.environ):
        key = env.get('YT_HELPER_KEY', '').strip()
        if not key and env.get('YT_HELPER_KEY_FILE'):
            key = Path(env['YT_HELPER_KEY_FILE']).expanduser().read_text(encoding='utf-8').strip()
        self.key = key
        self.host = env.get('YT_HELPER_HOST', '127.0.0.1')
        self.port = int(env.get('YT_HELPER_PORT') or 8096)
        self.max_duration = int(env.get('MAX_DURATION_SEC') or 5400)
        self.max_bytes = int(env.get('MAX_BYTES') or 99614720)
        self.timeout = int(env.get('DOWNLOAD_TIMEOUT') or 600)
        self.slots = threading.BoundedSemaphore(max(1, int(env.get('MAX_CONCURRENT') or 2)))
        self.ytdlp = env.get('YTDLP') or str(Path(sys.executable).with_name('yt-dlp'))
        self.js_runtime = env.get('YTDLP_JS_RUNTIME', '')


def ytdlp_args(config, vid, workdir):
    args = [config.ytdlp, '--ignore-config', '--no-playlist', '--no-progress', '--no-warnings',
            '--use-extractors', 'youtube',
            # Audio only: the smaller m4a (about 1 MB a minute) keeps a 90-minute sermon under the upload cap.
            '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
            '--max-filesize', str(config.max_bytes),
            '--match-filter', f'duration <= {config.max_duration} & !is_live',
            '--extractor-retries', '3', '--retry-sleep', 'http:exp=1:20',
            '-o', str(workdir / 'audio.%(ext)s')]
    if config.js_runtime:
        args += ['--js-runtimes', config.js_runtime]
    # Only the canonical link reaches yt-dlp, never the caller's text.
    return [*args, '--', f'https://www.youtube.com/watch?v={vid}']


def download(config, vid, workdir, run=subprocess.run):
    """Path of the downloaded audio, or raise HelperError."""
    try:
        result = run(ytdlp_args(config, vid, workdir), capture_output=True, text=True, timeout=config.timeout)
    except subprocess.TimeoutExpired:
        raise HelperError('timeout')
    files = [p for p in workdir.glob('audio.*') if not p.name.endswith(('.part', '.ytdl'))]
    output = (result.stderr or '') + (result.stdout or '')
    if result.returncode == 0 and files:
        if files[0].stat().st_size > config.max_bytes:
            raise HelperError('too_large')
        return files[0]
    code = classify(output)
    log.warning('yt-dlp failed for %s (%s, exit %s): %s', vid, code, result.returncode, output.strip()[-600:])
    raise HelperError(code)


class HelperError(Exception):
    def __init__(self, code, detail=''):
        super().__init__(code)
        self.code = code
        self.detail = detail


def make_handler(config, run=subprocess.run):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'youtube-helper'
        sys_version = ''
        # Seconds for any single socket read or write, so a stalled client cannot hold a slot.
        timeout = 60

        def log_message(self, fmt, *args):  # the request line only; headers (and the key) are never logged
            log.info('%s %s', self.address_string(), fmt % args)

        def send_json(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def fail(self, code, detail=''):
            self.send_json(STATUS.get(code, 502), {'error': code, 'detail': detail or code.replace('_', ' ')})

        def do_GET(self):
            if self.path == '/health':
                return self.send_json(200, {'ok': True})
            self.fail('not_found')

        def do_POST(self):
            if self.path != '/fetch':
                return self.fail('not_found')
            if not key_matches(self.headers.get('Authorization', ''), config.key):
                return self.fail('unauthorized')
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                return self.fail('bad_request')
            if length <= 0 or length > MAX_REQUEST_BYTES:
                return self.fail('too_large_request' if length > 0 else 'bad_request')
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError):
                return self.fail('bad_request', 'body must be JSON {"url": ...}')
            vid = video_id(body.get('url') if isinstance(body, dict) else None)
            if not vid:
                return self.fail('bad_url', 'only youtube.com and youtu.be video links are allowed')
            if not config.slots.acquire(timeout=30):
                return self.fail('busy', 'too many downloads at once; try again shortly')
            workdir = Path(tempfile.mkdtemp(prefix='yt-helper-'))
            try:
                path = download(config, vid, workdir, run)
            except HelperError as err:
                # Clean up before answering, so nothing is left behind once the caller has the error.
                config.slots.release()
                shutil.rmtree(workdir, ignore_errors=True)
                return self.fail(err.code, err.detail)
            try:
                size = path.stat().st_size
                self.send_response(200)
                self.send_header('Content-Type', CONTENT_TYPES.get(path.suffix, 'application/octet-stream'))
                self.send_header('Content-Length', str(size))
                self.send_header('Content-Disposition', f'attachment; filename="{vid}{path.suffix}"')
                self.send_header('X-Video-Id', vid)
                self.end_headers()
                with path.open('rb') as audio:
                    shutil.copyfileobj(audio, self.wfile, 1 << 20)
                log.info('sent %s (%d bytes)', vid, size)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                log.info('client went away while receiving %s', vid)
            finally:
                config.slots.release()
                shutil.rmtree(workdir, ignore_errors=True)

    return Handler


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    config = Config()
    if len(config.key) < 32:
        sys.exit('YT_HELPER_KEY (or YT_HELPER_KEY_FILE) must hold a key of at least 32 characters')
    server = ThreadingHTTPServer((config.host, config.port), make_handler(config))
    server.daemon_threads = True
    log.info('listening on http://%s:%d (max %ds, %d bytes)', config.host, config.port,
             config.max_duration, config.max_bytes)
    server.serve_forever()


if __name__ == '__main__':
    main()
