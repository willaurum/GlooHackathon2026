"""Pastor Notes: turn a sermon video into a stored, searchable transcript.

A note comes from a YouTube URL (downloaded here with yt-dlp) or an uploaded file
(the Worker streams it to R2; we read it back through the `notes-media` host).
ffmpeg cuts the audio into 10-minute mono parts, Workers AI transcribes each part
(`workers-ai` host, whisper-large-v3-turbo), and the segments are grouped into
chunks and embedded (bge-base-en-v1.5) so the Worker can answer questions later.
Finally an LLM (`/llm`) tags passages by category (Bible quotes, personal stories, ...)
so the transcript can highlight them.

One background worker runs one job at a time. Jobs are claimed atomically in the
database, so a note is never processed twice at once.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import db

log = logging.getLogger(__name__)

MEDIA_URL = os.environ.get('NOTES_MEDIA_URL', 'http://notes-media')
AI_URL = os.environ.get('WORKERS_AI_URL', 'http://workers-ai')
MAX_DURATION_SEC = int(os.environ.get('MAX_DURATION_SEC') or 5400)
PART_SECONDS = 600
CHUNK_WORDS = 50
CHUNK_SECONDS = 30
EMBED_BATCH = 50
CATEGORIZE_WORDS = 1500
MIN_CONFIDENCE = 0.5

YOUTUBE_HOSTS = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'}
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')


class NoteError(Exception):
    """A failure we can show the user. `code` is stored as the note's error."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# --- Input checks ---

def youtube_id(url):
    """The 11-character video id of a YouTube watch/short/share URL, or None."""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return None
    host = (parsed.hostname or '').lower()
    if parsed.scheme not in ('http', 'https') or host not in YOUTUBE_HOSTS:
        return None
    if host == 'youtu.be':
        candidate = parsed.path.lstrip('/').split('/')[0]
    elif parsed.path == '/watch':
        candidate = (parse_qs(parsed.query).get('v') or [''])[0]
    elif parsed.path.startswith(('/shorts/', '/live/', '/embed/')):
        candidate = parsed.path.split('/')[2] if len(parsed.path.split('/')) > 2 else ''
    else:
        return None
    return candidate if VIDEO_ID.match(candidate) else None


def canonical_youtube_url(video_id):
    return f'https://www.youtube.com/watch?v={video_id}'


# --- Getting the audio ---

def run_tool(args, timeout):
    """Run a command-line tool (never through a shell)."""
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def youtube_retry_delays():
    """Seconds to wait before each extra attempt when YouTube refuses a download.
    YOUTUBE_RETRY_DELAYS is a comma-separated list; empty means no retries."""
    raw = os.environ.get('YOUTUBE_RETRY_DELAYS', '30,120')
    delays = []
    for part in raw.split(','):
        try:
            delays.append(max(0, int(part.strip())))
        except ValueError:
            continue
    return delays


def download_youtube(url, workdir, sleep=time.sleep):
    """Download the audio, trying again with backoff when YouTube rate-limits or bot-checks
    the request. That refusal is per-IP and often temporary, so a spaced-out retry can
    recover the link; any other error fails right away."""
    delays = youtube_retry_delays()
    for attempt in range(len(delays) + 1):
        try:
            return _download_youtube_once(url, workdir)
        except NoteError as err:
            if err.code != 'youtube_blocked' or attempt == len(delays):
                raise
            log.info('YouTube refused the download (attempt %d); retrying in %ds', attempt + 1, delays[attempt])
            sleep(delays[attempt])


def _download_youtube_once(url, workdir):
    args = ['yt-dlp', '--no-playlist', '--no-progress', '-f', 'bestaudio/best',
            '--max-filesize', '200M', '--match-filter', f'duration <= {MAX_DURATION_SEC}',
            # Pace the extraction requests and let yt-dlp retry its own transient
            # failures with exponential backoff instead of failing on the first 429.
            '--sleep-requests', '1', '--extractor-retries', '3',
            '--retry-sleep', 'extractor:exp=2:30', '--retry-sleep', 'http:exp=1:30',
            '-o', str(workdir / 'src.%(ext)s')]
    cookies = os.environ.get('YTDLP_COOKIES', '').strip()
    if cookies:
        # yt-dlp rewrites its cookie file, so give each job its own copy.
        cookie_file = workdir / 'cookies.txt'
        cookie_file.write_text(cookies + '\n', encoding='utf-8')
        args += ['--cookies', str(cookie_file)]
    result = run_tool([*args, '--', url], timeout=900)
    output = (result.stderr + result.stdout).lower()
    files = [p for p in workdir.glob('src.*') if not p.name.endswith('.part')]
    if result.returncode == 0 and files:
        return files[0]
    log.warning('yt-dlp failed (%s): %s', result.returncode, (result.stderr or result.stdout)[-1500:])
    # YouTube's rate limit reads "Video unavailable. This content isn't available, try again
    # later.", so it must be checked before the real "unavailable" case below.
    if (('confirm you' in output and 'bot' in output) or 'sign in to confirm' in output
            or 'http error 429' in output or 'rate-limited' in output or 'try again later' in output):
        raise NoteError('youtube_blocked')
    if 'does not pass filter' in output:
        raise NoteError('too_long')
    if 'is unavailable' in output or 'video unavailable' in output or 'private video' in output:
        raise NoteError('youtube_unavailable')
    raise NoteError('download_failed')


def fetch_upload(r2_key, workdir):
    target = workdir / 'src.upload'
    with httpx.stream('GET', f'{MEDIA_URL}/{r2_key}', timeout=httpx.Timeout(60, read=300)) as response:
        if response.status_code != 200:
            raise NoteError('upload_missing')
        with target.open('wb') as out:
            for block in response.iter_bytes(1 << 20):
                out.write(block)
    return target


def probe(path):
    """(duration_seconds, has_audio) from ffprobe."""
    result = run_tool(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
                       '-of', 'json', str(path)], timeout=120)
    if result.returncode != 0:
        raise NoteError('unreadable_media')
    info = json.loads(result.stdout or '{}')
    has_audio = any(s.get('codec_type') == 'audio' for s in info.get('streams', []))
    try:
        duration = float(info.get('format', {}).get('duration'))
    except (TypeError, ValueError):
        duration = 0.0
    return duration, has_audio


def split_audio(path, workdir):
    """16 kHz mono mp3 parts of PART_SECONDS each (about 2.4 MB per part)."""
    result = run_tool(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '16000',
                       '-b:a', '32k', '-f', 'segment', '-segment_time', str(PART_SECONDS),
                       str(workdir / 'part%03d.mp3')], timeout=1800)
    parts = sorted(workdir.glob('part*.mp3'))
    if result.returncode != 0 or not parts:
        log.warning('ffmpeg failed: %s', result.stderr[-1500:])
        raise NoteError('transcode_failed')
    return parts


# --- Transcribing and embedding (Workers AI, through the Worker) ---

_ai = httpx.Client(base_url=AI_URL, timeout=httpx.Timeout(30, read=300))


def transcribe(part, offset):
    response = _ai.post('/asr', content=part.read_bytes(), headers={'Content-Type': 'audio/mpeg'})
    if response.status_code != 200:
        log.warning('asr failed: %s %s', response.status_code, response.text[:500])
        raise NoteError('transcription_failed')
    result = response.json()
    segments = result.get('segments') or []
    if not segments and (result.get('text') or '').strip():
        segments = [{'start': 0, 'end': result.get('duration') or PART_SECONDS, 'text': result['text']}]
    return [{'start': round(offset + float(s['start']), 2), 'end': round(offset + float(s['end']), 2),
             'text': ' '.join(str(s.get('text', '')).split())} for s in segments]


def clean_segments(segments):
    """Drop empty segments and whisper's repeated-line loops."""
    cleaned = []
    for s in segments:
        if not s['text'] or (cleaned and s['text'].lower() == cleaned[-1]['text'].lower()):
            continue
        cleaned.append(s)
    return cleaned


def make_chunks(segments):
    """Group consecutive segments into chunks of about CHUNK_WORDS words or CHUNK_SECONDS seconds,
    never splitting a segment. Each chunk starts with the previous chunk's last segment as overlap."""
    chunks, first = [], 0
    while first < len(segments):
        last, words = first, 0
        while last < len(segments):
            words += len(segments[last]['text'].split())
            if words >= CHUNK_WORDS or segments[last]['end'] - segments[first]['start'] >= CHUNK_SECONDS:
                break
            last += 1
        last = min(last, len(segments) - 1)
        chunks.append({'start': segments[first]['start'], 'end': segments[last]['end'],
                       'seg_from': first, 'seg_to': last,
                       'text': ' '.join(s['text'] for s in segments[first:last + 1])})
        if last == len(segments) - 1:
            break
        first = last if last > first else last + 1
    return chunks


def embed(texts):
    vectors = []
    for i in range(0, len(texts), EMBED_BATCH):
        response = _ai.post('/embed', json={'texts': texts[i:i + EMBED_BATCH]})
        if response.status_code != 200:
            log.warning('embed failed: %s %s', response.status_code, response.text[:500])
            raise NoteError('embedding_failed')
        vectors += response.json()['vectors']
    return [[round(x, 5) for x in v] for v in vectors]


CATEGORIZE_PROMPT = """You tag passages in a sermon transcript. Each line is one segment: [index] text.

Categories:
- bible_quote: the speaker reads or quotes Bible text directly
- bible_paraphrase: retells or refers to a Bible story, character or teaching without quoting it
- recent_event: mentions a recent or current news event
- political_event: mentions politics, elections, government or politicians
- personal_story: the speaker tells a personal anecdote or story from their own life
- inerrancy_claim: claims the Bible is accurate, without error, or divinely authored

Tag only passages that clearly fit. A passage is a run of consecutive segments (seg_from to seg_to, inclusive).
label is a short description, with the verse reference when there is one (e.g. "Luke 10:25-37, the Good Samaritan").
confidence is 0 to 1.

Return JSON only: {"annotations": [{"seg_from": 0, "seg_to": 2, "category": "bible_quote", "label": "...", "confidence": 0.9}]}
If nothing fits, return {"annotations": []}.

Segments:
"""


def _windows(segments):
    """Consecutive (first_index, segments) runs of about CATEGORIZE_WORDS words, so each prompt fits a small model."""
    first, words = 0, 0
    for i, s in enumerate(segments):
        words += len(s['text'].split())
        if words >= CATEGORIZE_WORDS:
            yield first, segments[first:i + 1]
            first, words = i + 1, 0
    if first < len(segments):
        yield first, segments[first:]


def _parse_annotations(text, first, last):
    """Valid annotations from a model reply, clamped to segments first..last. Bad items are dropped."""
    start, end = text.find('{'), text.rfind('}')
    try:
        items = json.loads(text[start:end + 1]).get('annotations') if 0 <= start < end else None
    except (ValueError, AttributeError):
        items = None
    out = []
    for a in items if isinstance(items, list) else []:
        try:
            seg_from, seg_to = int(a['seg_from']), int(a['seg_to'])
            confidence = float(a.get('confidence', 1.0))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if a.get('category') not in db.ANNOTATION_CATEGORIES or confidence < MIN_CONFIDENCE:
            continue
        seg_from, seg_to = max(seg_from, first), min(seg_to, last)
        if seg_from > seg_to:
            continue
        out.append({'seg_from': seg_from, 'seg_to': seg_to, 'category': a['category'],
                    'label': str(a.get('label') or '')[:200], 'confidence': round(min(confidence, 1.0), 2)})
    return out


def categorize(segments):
    """Tag passages by category. Best effort: a failed window is logged and skipped, never fails the note."""
    annotations = []
    for first, window in _windows(segments):
        numbered = '\n'.join(f'[{first + i}] {s["text"]}' for i, s in enumerate(window))
        try:
            response = _ai.post('/llm', json={'prompt': CATEGORIZE_PROMPT + numbered})
            if response.status_code != 200:
                log.warning('categorize failed: %s %s', response.status_code, response.text[:300])
                continue
            text = response.json().get('text') or ''
        except (httpx.HTTPError, ValueError, AttributeError) as err:
            log.warning('categorize failed: %s', err)
            continue
        annotations += _parse_annotations(str(text), first, first + len(window) - 1)
    return merge_annotations(annotations)


def merge_annotations(annotations):
    """One annotation per passage: the model sometimes tags the same claim twice, over the same or touching segments."""
    merged = []
    for a in sorted(annotations, key=lambda a: (a['category'], a['label'].strip().lower(), a['seg_from'])):
        last = merged[-1] if merged else None
        if (last and last['category'] == a['category'] and last['label'].strip().lower() == a['label'].strip().lower()
                and a['seg_from'] <= last['seg_to'] + 1):
            last['seg_to'] = max(last['seg_to'], a['seg_to'])
            last['confidence'] = max(last['confidence'], a['confidence'])
        else:
            merged.append(dict(a))
    return sorted(merged, key=lambda a: (a['seg_from'], a['seg_to']))


# --- The job ---

def process(note_id):
    if not db.claim_note(note_id):
        return
    note = db.get_note(note_id)
    workdir = Path(tempfile.mkdtemp(prefix='note-'))
    try:
        if note['source_kind'] == 'youtube':
            source = download_youtube(note['source_url'], workdir)
        else:
            source = fetch_upload(note['r2_key'], workdir)
        duration, has_audio = probe(source)
        if not has_audio:
            raise NoteError('no_audio')
        if duration > MAX_DURATION_SEC:
            raise NoteError('too_long')
        segments = []
        for i, part in enumerate(split_audio(source, workdir)):
            segments += transcribe(part, i * PART_SECONDS)
        segments = clean_segments(segments)
        if not segments:
            raise NoteError('no_speech')
        chunks = make_chunks(segments)
        for chunk, vector in zip(chunks, embed([c['text'] for c in chunks])):
            chunk['embedding'] = vector
        annotations = categorize(segments)
        db.save_transcript(note_id, segments, chunks, round(duration, 2), annotations)
        log.info('note %s ready: %d segments, %d chunks, %d annotations',
                 note_id, len(segments), len(chunks), len(annotations))
    except NoteError as err:
        db.fail_note(note_id, err.code)
    except subprocess.TimeoutExpired:
        db.fail_note(note_id, 'timeout')
    except Exception:
        log.exception('note %s failed', note_id)
        db.fail_note(note_id, 'processing_failed')
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


_wake = threading.Event()


def _worker():
    while True:
        _wake.wait(timeout=60)
        _wake.clear()
        # Each church has its own notes; check every church this process has opened.
        for slug in sorted({db.DEMO_CHURCH, *db.ready_churches()}):
            try:
                with db.use_church(slug):
                    for note_id in db.queued_note_ids():
                        process(note_id)
            except Exception:
                log.exception('notes worker loop failed for %s', slug)


def start_worker():
    threading.Thread(target=_worker, name='notes-worker', daemon=True).start()
    _wake.set()


def kick():
    _wake.set()


# --- Routes ---

router = APIRouter()


class YouTubeNote(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    youtube_url: str = Field(min_length=1, max_length=500)


class UploadedNote(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    r2_key: str = Field(pattern=r'^notes/[0-9a-f-]{36}/source$')
    note_id: str = Field(pattern=r'^[0-9a-f-]{36}$')


class ConfigUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra='forbid')
    name: str | None = Field(default=None, min_length=1, max_length=200)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    default_language: str | None = Field(default=None, min_length=2, max_length=16)


def _public(note):
    return {k: v for k, v in note.items() if k != 'r2_key'}


def _ready_note(note_id):
    note = db.get_transcript(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail='Note not found')
    if note['status'] != 'ready':
        raise HTTPException(status_code=409, detail=f"Note is {note['status']}, not ready")
    return note


def timestamp(seconds):
    seconds = int(seconds)
    h, rest = divmod(seconds, 3600)
    return f'{h}:{rest // 60:02d}:{rest % 60:02d}' if h else f'{rest // 60:02d}:{rest % 60:02d}'


@router.get('/api/config')
def church():
    return db.get_config()


@router.post('/api/notes', status_code=202)
def create_youtube_note(body: YouTubeNote):
    video_id = youtube_id(body.youtube_url)
    if video_id is None:
        raise HTTPException(status_code=400, detail='youtube_url must be a single YouTube video link')
    note = db.create_note(str(uuid.uuid4()), body.title, 'youtube', canonical_youtube_url(video_id))
    kick()
    return note


@router.get('/api/notes')
def list_notes():
    return db.list_notes()


@router.get('/api/notes/{note_id}')
def get_note(note_id: str):
    note = db.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail='Note not found')
    return _public(note)


@router.get('/api/notes/{note_id}/transcript')
def transcript(note_id: str):
    note = _ready_note(note_id)
    return {k: note[k] for k in ('id', 'title', 'text', 'word_count', 'duration')}


@router.get('/api/notes/{note_id}/segments')
def segments(note_id: str):
    _ready_note(note_id)
    return [{**s, 'timestamp': timestamp(s['start'])} for s in db.list_segments(note_id)]


@router.get('/api/notes/{note_id}/annotations')
def annotations(note_id: str):
    _ready_note(note_id)
    return db.list_annotations(note_id)


@router.post('/api/notes/{note_id}/retry', status_code=202)
def retry(note_id: str):
    note = db.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail='Note not found')
    if not db.queue_note(note_id):
        raise HTTPException(status_code=409, detail=f"Note is {note['status']}; only failed notes can be retried")
    kick()
    return {'id': note_id, 'status': 'queued'}


# Internal routes: the Worker blocks /api/internal/* from outside and calls these itself.

@router.post('/api/internal/notes', status_code=202)
def register_upload(body: UploadedNote):
    note = db.create_note(body.note_id, body.title, 'upload', r2_key=body.r2_key)
    kick()
    return note


@router.put('/api/internal/config')
def set_config(body: ConfigUpdate):
    return db.update_config(body.model_dump(exclude_none=True))


@router.delete('/api/internal/notes/{note_id}')
def delete_note(note_id: str):
    note, busy = db.delete_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail='Note not found')
    if busy:
        raise HTTPException(status_code=409, detail='Note is being processed')
    return {'id': note_id, 'r2_key': note['r2_key']}
