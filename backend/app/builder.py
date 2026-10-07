"""Agentic builder: turn an existing church website into a church profile, with every value traced to its source.

    1. Import   fetch the site (same-site pages) into sources: [{id, url, title, text}]
    2. Extract  read each source into claims: {field, value, quote, source_id, method}. Pattern rules catch
                phones, emails, addresses and service times; the AI (when configured) adds the name, prose and
                FAQs. Every AI claim must quote its source exactly, or it is dropped.
    3. Clarify  plain code compares the claims field by field: one agreeing value is prefilled, different
                values are a conflict, nothing found for a required field is missing. Nothing is decided by
                the AI, and a conflict is never resolved without the church's answer.
    4. Confirm  the church answers the questions and reviews the profile.
    5. Build    the confirmed profile becomes ChurchContent JSON (church_content.py) and can be loaded into a
                church, whose own site is then the preview.

Public drafts live in the reserved platform space 'builder' as 'draft:<id>', expire after 24 hours,
and can be applied once by staff into a new church.
"""
import asyncio
import io
import ipaddress
import json
import logging
import multiprocessing
import os
import re
import secrets
import socket
import threading
import time
import zipfile
import xml.etree.ElementTree as ET
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urldefrag, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException

from . import church_content, db

log = logging.getLogger(__name__)
router = APIRouter()

MAX_PAGES = 12
MAX_PAGE_BYTES = 1_000_000
MAX_SOURCE_CHARS = 20_000
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_FILES = 5
FETCH_TIMEOUT = 10.0
IMPORT_BUDGET = float(os.environ.get('BUILDER_IMPORT_BUDGET', '75.0'))
CRAWL_BUDGET = 30.0
DOCUMENT_TIMEOUT = 20.0
DOCUMENT_MEMORY = 1024 * 1024 * 1024  # address space, which includes the app the child imports
_WORKERS = ThreadPoolExecutor(max_workers=12, thread_name_prefix='builder')
_now = time.monotonic
# Fields the builder asks about when nothing is found. Optional fields are simply left empty.
REQUIRED = ('name', 'address', 'phone', 'email', 'services')
FIELD_LABELS = {'name': 'Church name', 'address': 'Street address', 'phone': 'Phone number', 'email': 'Email',
                'services': 'Service times', 'office_hours': 'Office hours', 'about': 'About the church',
                'first_visit': 'What to expect on a first visit'}
DAYS = ('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')
# "Wednesday", "Wednesdays", "Wed", "Weds": whole words only, any case.
DAY_RE = {d: re.compile(rf'\b(?:{d}|{d[:3]})s?\b', re.I) for d in DAYS}


# ---------------------------------------------------------------- 1. Import

def _parallel(items, read, deadline, workers=4):
    """Collect in source order; never join work that outlives the deadline."""
    if not items or _now() >= deadline:
        return [None] * len(items), len(items)

    def run(item):
        if _now() >= deadline:
            return None, deadline + 1
        value = read(item)
        return value, _now()

    values, pending, pos, skipped = [None] * len(items), {}, 0, len(items)
    try:
        while pending or pos < len(items):
            while pos < len(items) and len(pending) < min(workers, 4) and _now() < deadline:
                pending[_WORKERS.submit(run, items[pos])] = pos
                pos += 1
            if not pending:
                break
            done, _ = wait(pending, timeout=max(0.0, deadline - _now()), return_when=FIRST_COMPLETED)
            for future in done:
                index = pending.pop(future)
                value, finished = future.result()
                if finished <= deadline:
                    values[index] = value
                    skipped -= 1
            if not done or _now() >= deadline:
                break
        return values, skipped
    finally:
        for future in pending:
            future.cancel()


class _PageText(HTMLParser):
    """Visible text (with images as [image: alt]), the <title>, and the links of one HTML page."""
    # Form dropdowns are choices, not content (a "Which service?" list would read as service times).
    SKIP = {'script', 'style', 'noscript', 'template', 'svg', 'select', 'textarea'}
    BLOCK = {'p', 'div', 'br', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
             'header', 'footer', 'nav', 'main', 'aside', 'dt', 'dd', 'table', 'form', 'blockquote', 'label', 'button'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.images, self.title, self._skip, self._in_title = [], [], [], '', 0, False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in self.SKIP:
            self._skip += 1
        elif tag == 'title':
            self._in_title = True
        elif tag == 'a' and attrs.get('href'):
            self.links.append(attrs['href'])
        elif tag == 'img':
            if attrs.get('src'):
                self.images.append(attrs['src'])
            if attrs.get('alt'):
                self.parts.append(f" [image: {attrs['alt']}] ")
        if tag in self.BLOCK:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag == 'title':
            self._in_title = False
        if tag in self.BLOCK:
            self.parts.append('\n')

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)

    def text(self):
        lines = (re.sub(r'[ \t\r\f\v]+', ' ', line).strip() for line in ''.join(self.parts).split('\n'))
        return '\n'.join(line for line in lines if line)


def parse_html(html):
    page = _PageText()
    page.feed(html)
    page.close()
    return {'title': page.title.strip(), 'text': page.text(), 'links': page.links, 'images': page.images}


def _check_public(url):
    """Refuse URLs that would make the server fetch its own network (SSRF), unless BUILDER_ALLOW_PRIVATE=1."""
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('Enter a website address starting with http:// or https://')
    if os.environ.get('BUILDER_ALLOW_PRIVATE') == '1':
        return
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80))
    except socket.gaierror as error:
        raise ValueError('That website address could not be found.') from error
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError('That address is on a private network and cannot be imported.')


def crawl(start_url, fetch=None, max_pages=MAX_PAGES, deadline=None, notes=None):
    """Breadth-first over same-site HTML pages. `fetch(url) -> (final_url, content_type, text)` can be injected."""
    start_url = urldefrag(start_url.strip())[0]
    deadline = deadline if deadline is not None else _now() + min(CRAWL_BUDGET, IMPORT_BUDGET)
    _, skipped = _parallel([start_url], _check_public, deadline, workers=1)
    if skipped:
        if notes is not None:
            notes.append('Stopped reading before the first page to stay within the time limit.')
        return []
    origin = urlparse(start_url).netloc
    fetch = fetch or _http_fetch
    queue, seen, sources = [start_url], {start_url}, []
    while queue and len(sources) < max_pages:
        if _now() >= deadline:
            break
        url = queue.pop(0)
        try:
            results, skipped = _parallel([url], fetch, deadline, workers=1)
            if skipped:
                queue.insert(0, url)
                break
            final_url, content_type, body = results[0]
        except Exception as error:  # one broken page must not stop the import
            log.info('builder: skipped %s (%s)', url, error)
            continue
        if 'html' not in content_type:
            continue
        page = parse_html(body)
        # The same page under two addresses ("/" and "/index.html") is one source, or it would count twice.
        if any(s['text'] == page['text'][:MAX_SOURCE_CHARS] for s in sources):
            continue
        images = [urldefrag(urljoin(final_url, src))[0] for src in page['images']]
        sources.append({'id': f's{len(sources) + 1}', 'kind': 'page', 'url': final_url, 'title': page['title'],
                        'text': page['text'][:MAX_SOURCE_CHARS],
                        'images': [i for i in images if urlparse(i).netloc == origin and IMAGE_RE.search(i)]})
        for href in page['links']:
            link = urldefrag(urljoin(final_url, href))[0]
            if urlparse(link).netloc == origin and link not in seen and not re.search(r'\.(pdf|jpe?g|png|gif|zip|docx?)$', link, re.I):
                seen.add(link)
                queue.append(link)
    if queue and len(sources) < max_pages and notes is not None:
        total = min(max_pages, len(sources) + len(queue))
        notes.append(f'Stopped reading after {len(sources)} of {total} pages to stay within the time limit.')
    return sources


IMAGE_RE = re.compile(r'\.(png|jpe?g|gif|webp)$', re.I)
MAX_IMAGES = 5
MAX_IMAGE_BYTES = 4_000_000


def read_images(sources, fetch_bytes=None, describe=None, deadline=None, notes=None):
    """Image sources: a bulletin or flyer often holds the only copy of a service time. Each same-site image
    (at most MAX_IMAGES) is transcribed by a vision model into text that the same rules then read. With no
    vision model, images are skipped."""
    describe = describe if describe is not None else _ai_describe
    if not describe:
        return []
    deadline = deadline if deadline is not None else _now() + IMPORT_BUDGET
    fetch_bytes = fetch_bytes or _http_fetch_bytes
    out, seen, images = [], set(), []
    for page in sources:
        for url in page.get('images', []):
            if url in seen:
                continue
            seen.add(url)
            images.append((page, url))

    def read(image):
        page, url = image
        try:
            content_type, data = fetch_bytes(url)
            if _now() >= deadline:
                return None
            text = (describe(data, content_type) or '').strip()
        except Exception as error:
            log.info('builder: skipped image %s (%s)', url, error)
            return None
        if len(text) >= 20:
            return {'kind': 'image', 'url': url, 'title': f"Image on {page.get('title') or page['url']}",
                    'text': text[:MAX_SOURCE_CHARS]}

    pos = 0
    while pos < len(images) and len(out) < MAX_IMAGES:
        batch = images[pos:pos + MAX_IMAGES - len(out)]
        results, skipped = _parallel(batch, read, deadline)
        pos += len(batch)
        for source in results:
            if source:
                out.append({'id': f's{len(sources) + len(out) + 1}', **source})
        if skipped or _now() >= deadline:
            skipped += min(len(images) - pos, MAX_IMAGES - len(out))
            if skipped and notes is not None:
                subject = '1 image was' if skipped == 1 else f'{skipped} images were'
                notes.append(f'{subject} skipped because reading took too long.')
            break
    return out


def _http_fetch_bytes(url):
    _check_public(url)
    with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False, headers={'User-Agent': 'TektonBuilder/0.1'}) as client:
        response = client.get(url)
        response.raise_for_status()
        content_type = response.headers.get('content-type', '').split(';')[0]
        if not content_type.startswith('image/') or len(response.content) > MAX_IMAGE_BYTES:
            raise ValueError('not a small image')
        return content_type, response.content


def _ai_describe_impl(data, content_type):
    """Transcribe an image's words with the first configured model that accepts images."""
    import base64
    from . import chat
    clients = chat.make_clients()
    if not clients:
        return ''
    name, model, extra_body, client = clients[0]
    url = f'data:{content_type};base64,' + base64.b64encode(data).decode()
    attachment = ({'type': 'file', 'file': {'filename': 'material.pdf', 'file_data': url}}
                  if content_type == 'application/pdf' else {'type': 'image_url', 'image_url': {'url': url}})
    response = client.chat.completions.create(model=model, temperature=0, max_tokens=800, messages=[
        {'role': 'user', 'content': [
            {'type': 'text', 'text': 'Copy out every word printed in this image, line by line, exactly as written. '
                                     'No commentary. If there is no text, reply with nothing.'},
            attachment]}], **({'extra_body': extra_body} if extra_body else {}))
    return response.choices[0].message.content or ''


_ai_describe = _ai_describe_impl if os.environ.get('BUILDER_VISION', '1') != '0' and os.environ.get('BUILDER_AI', '1') != '0' else None


def _file_title(filename):
    title = re.split(r'[/\\]', filename or '')[-1]
    return re.sub(r'[\x00-\x1f\x7f]', '', title).strip()[:120] or 'Church material'


def _file_type(data):
    if data.startswith(b'%PDF-'):
        return 'application/pdf'
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'
    if data.startswith(b'PK\x03\x04'):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if 'word/document.xml' in archive.namelist():
                    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        except zipfile.BadZipFile:
            pass
        raise ValueError('That archive is not a Word document. Upload a DOCX file.')
    sample = data[:8192].decode('utf-8', errors='replace')
    if any(ord(c) < 32 and c not in '\t\n\r\f' for c in sample) or sum(
            c.isprintable() or c in '\t\n\r\f' for c in sample if c != '\ufffd') < len(sample) * 0.95:
        raise ValueError('Unsupported file type. Upload PDF, plain text, HTML, DOCX, PNG, JPEG or WebP files.')
    return 'text/html' if re.search(r'<(?:!doctype\s+html|html|head|body|title|p|div|h[1-6]|br)\b', sample, re.I) else 'text/plain'


def _docx_text(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(item.file_size for item in archive.infolist()) > MAX_FILE_BYTES:
            raise ValueError('The Word document expands beyond the 5 MB limit.')
        with archive.open('word/document.xml') as document:
            xml = document.read(MAX_FILE_BYTES + 1)
        if len(xml) > MAX_FILE_BYTES:
            raise ValueError('The Word document expands beyond the 5 MB limit.')
    declarations = xml.upper().replace(b'\x00', b'')
    if b'<!DOCTYPE' in declarations or b'<!ENTITY' in declarations:
        raise ValueError('That Word document is not supported.')
    root = ET.fromstring(xml)
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    parts, size = [], 0
    for p in root.iter(ns + 'p'):
        if parts and size < MAX_SOURCE_CHARS:
            parts.append('\n')
            size += 1
        for t in p.iter(ns + 't'):
            part = (t.text or '')[:MAX_SOURCE_CHARS - size]
            parts.append(part)
            size += len(part)
            if size >= MAX_SOURCE_CHARS:
                break
        if size >= MAX_SOURCE_CHARS:
            break
    return ''.join(parts)


def _document_text(data, content_type):
    if content_type != 'application/pdf':
        return _docx_text(data)
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError
    try:
        parts, size = [], 0
        for page in PdfReader(io.BytesIO(data)).pages:
            if size >= MAX_SOURCE_CHARS:
                break
            parts.append((page.extract_text() or '')[:MAX_SOURCE_CHARS - size])
            size += len(parts[-1]) + 1
        return '\n'.join(parts)[:MAX_SOURCE_CHARS]
    except PdfReadError as error:
        raise ValueError('Upload a valid, unlocked PDF file.') from error


def _document_child(connection, data, content_type):
    try:
        try:
            import resource
        except ImportError:  # Windows development.
            pass
        else:
            resource.setrlimit(resource.RLIMIT_AS, (DOCUMENT_MEMORY, DOCUMENT_MEMORY))
        text = _document_text(data, content_type)
        connection.send(('ok', text[:MAX_SOURCE_CHARS]))
    except ValueError as error:
        connection.send(('invalid', str(error)))
    except (ET.ParseError, zipfile.BadZipFile, KeyError):
        connection.send(('invalid', 'Upload a valid, unlocked file.'))
    except Exception:
        connection.send(('failed', None))
    finally:
        connection.close()


def _parse_document(data, content_type, deadline):
    """Only the child touches document parsers; bound its memory and lifetime."""
    timeout = min(DOCUMENT_TIMEOUT, max(0.0, deadline - _now()))
    if not timeout:
        return 'timeout', None
    context = multiprocessing.get_context('spawn')
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_document_child, args=(sender, data, content_type))
    stop = _now() + timeout
    try:
        process.start()
        sender.close()
        if not receiver.poll(max(0.0, stop - _now())):
            return 'timeout', None
        result = receiver.recv()
        process.join(max(0.0, stop - _now()))
        return result if not process.is_alive() else ('timeout', None)
    except Exception as error:
        log.info('builder: document parser failed (%s)', error)
        return 'failed', None
    finally:
        sender.close()
        receiver.close()
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
                process.join(0.2)
                if process.is_alive():
                    process.kill()
                    process.join()
            process.close()


def read_files(files, describe=None, deadline=None, notes=None):
    """Sniff uploaded bytes; transcriptions use the same vision reader as crawled images."""
    deadline = deadline if deadline is not None else _now() + IMPORT_BUDGET
    notes = notes if notes is not None else []
    describe = describe if describe is not None else (_ai_describe if _ai_available() else None)
    typed = [(title, data, _file_type(data)) for title, data in files]

    def read(item):
        title, data, content_type = item
        kind = 'file'
        try:
            if content_type == 'application/pdf' or content_type.endswith('document'):
                status, text = _parse_document(data, content_type, deadline)
                if status == 'invalid':
                    raise ValueError(text)
                if status != 'ok':
                    reason = 'it took too long to read' if status == 'timeout' else 'it could not be read'
                    return None, f'{title} was skipped because {reason}.'
            elif content_type.startswith('text/'):
                text = data.decode('utf-8', errors='replace')
                if content_type == 'text/html':
                    text = parse_html(text)['text']
            else:
                text = ''
            if content_type.startswith('image/') or content_type == 'application/pdf' and not text.strip():
                kind = 'image'
                if not describe:
                    return None, f'{title} was skipped because no vision model is available to read it.'
                try:
                    text = describe(data, content_type) or ''
                except Exception as error:
                    log.info('builder: skipped file %s (%s)', title, error)
                    return None, f'{title} was skipped because the vision model could not read it.'
            source = {'kind': kind, 'url': None, 'title': title, 'text': text.strip()[:MAX_SOURCE_CHARS]}
            return source, None
        except ValueError:
            raise
        except Exception as error:
            raise ValueError(f'{title} could not be read. Upload a valid, unlocked file.') from error

    results, _ = _parallel(typed, read, deadline)
    sources = []
    for (title, _, _), result in zip(typed, results):
        if result is None:
            notes.append(f'{title} was skipped because reading took too long.')
            continue
        source, note = result
        if note:
            notes.append(note)
        if source:
            sources.append({'id': f's{len(sources) + 1}', **source})
    return sources


def _http_fetch(url):
    _check_public(url)
    with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False, headers={'User-Agent': 'TektonBuilder/0.1'}) as client:
        response = client.get(url)
        hops = 0
        while response.is_redirect and hops < 5:
            url = urljoin(url, response.headers['location'])
            _check_public(url)  # a redirect must not lead into a private network either
            response = client.get(url)
            hops += 1
        response.raise_for_status()
        return str(response.url), response.headers.get('content-type', ''), response.text[:MAX_PAGE_BYTES]


# ---------------------------------------------------------------- 2. Extract

PHONE_RE = re.compile(r'\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}\b')
EMAIL_RE = re.compile(r'\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b')
STREET_RE = re.compile(r'\b\d{1,6}\s+(?:[A-Z][\w.\'-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Circle|Terrace)\b\.?(?:,?\s+[A-Z][\w\s.\'-]{1,40},\s*[A-Z]{2}\b)?')
TIME_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b', re.I)
BARE_TIMES_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*(?:&|and|\+)\s*(\d{1,2})(?::(\d{2}))?\b')
WORSHIP_WORDS = re.compile(r'\b(worship|service|services|gathering|mass|traditional|contemporary|join us)\b', re.I)
NOT_WORSHIP = re.compile(r'\b(sunday school|office|youth|kids|nursery|rehears|breakfast|study|potluck|dinner|lunch|fish fry)\b', re.I)
# A calendar date ("Sunday, November 1, 2026") is a one-off event, not a weekly service time.
DATED = re.compile(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b', re.I)


def _digits(phone):
    return re.sub(r'\D', '', phone)[-10:]


def _clock(hour, minute, ampm):
    """24-hour 'HH:MM'. With no am/pm, 7–11 read as morning and 1–6 as afternoon (church times)."""
    hour, minute = int(hour), int(minute or 0)
    if ampm:
        hour = hour % 12 + (12 if ampm.lower() == 'p' else 0)
    elif 1 <= hour <= 6:
        hour += 12
    return f'{hour:02d}:{minute:02d}'


def _sentences(text):
    for line in text.split('\n'):
        yield from (s.strip() for s in re.split(r'(?<=[.!?])\s+', line) if s.strip())


def service_times(text):
    """{day: [(clock, quote)]} for sentences that talk about worship and name a day and times."""
    found = {}
    lines = text.split('\n')
    for i, sentence in enumerate(_sentences(text)):
        days = [d for d in DAYS if DAY_RE[d].search(sentence)]
        if not days or NOT_WORSHIP.search(sentence) or DATED.search(sentence):
            continue
        times = [_clock(h, m, ap) for h, m, ap in TIME_RE.findall(sentence)]
        if not times and WORSHIP_WORDS.search(sentence) or re.search(r'\bsundays?\b\s+\d', sentence, re.I):
            for h1, m1, h2, m2 in BARE_TIMES_RE.findall(sentence):
                times += [_clock(h1, m1, None), _clock(h2, m2, None)]
        if not times or not (WORSHIP_WORDS.search(sentence) or len(days) == 1 and re.search(r'\bsundays?\b', sentence, re.I)):
            continue
        for day in days[:1]:
            found.setdefault(day, [])
            found[day] += [(t, sentence) for t in times if t not in [x for x, _ in found[day]]]
    # Tables and footers: a "Sunday" cell or heading followed by times on the next lines.
    for i, line in enumerate(lines):
        day = next((d for d in DAYS if re.fullmatch(rf'{d}s?( services?| worship)?', line.strip(), re.I)), None)
        if not day:
            continue
        for nxt in lines[i + 1:i + 4]:
            if NOT_WORSHIP.search(nxt) or DATED.search(nxt) or any(re.match(rf'{d}\b', nxt) for d in DAYS):
                break
            for h, m, ap in TIME_RE.findall(nxt):
                clock = _clock(h, m, ap)
                found.setdefault(day, [])
                if clock not in [x for x, _ in found[day]]:
                    found[day].append((clock, f'{line} {nxt}'.strip()))
    return found


def pattern_claims(source):
    """Claims from plain rules: no AI involved, so they work offline and are easy to explain."""
    text, sid, claims = source['text'], source['id'], []
    for match in sorted(set(EMAIL_RE.findall(text))):
        claims.append({'field': 'email', 'value': match.lower(), 'quote': match, 'source_id': sid, 'method': 'pattern'})
    for match in sorted(set(PHONE_RE.findall(text))):
        claims.append({'field': 'phone', 'value': _digits(match), 'quote': match, 'source_id': sid, 'method': 'pattern'})
    for match in sorted(set(m.group(0).strip(' ,.') for m in STREET_RE.finditer(text.replace('\n', ', ')))):
        claims.append({'field': 'address', 'value': match, 'quote': match, 'source_id': sid, 'method': 'pattern'})
    title = source.get('title', '')
    if source.get('kind', 'page') == 'page' and ' | ' in title:  # "Plan a Visit | Cedar Hollow Community Church"
        name = title.rsplit(' | ', 1)[1].strip()
        claims.append({'field': 'name', 'value': name, 'quote': title, 'source_id': sid, 'method': 'pattern'})
    for day, times in service_times(text).items():
        for clock, quote in times:
            claims.append({'field': 'services', 'value': {'day': day, 'time': clock}, 'quote': quote,
                           'source_id': sid, 'method': 'pattern', **({'service_group': quote} if source.get('url') is None else {})})
    return claims


AI_FIELDS = {
    'name': 'The church\'s name as the site states it.',
    'about': 'A short description of the church (history, beliefs), copied from the page.',
    'first_visit': 'What a first-time visitor should expect (dress, length, greeters, kids).',
    'office_hours': 'Church office hours.',
}
AI_TOOL = {
    'type': 'function',
    'function': {
        'name': 'record_church_facts',
        'description': 'Record facts about the church found on this page. Only facts the page states; each with an exact quote copied from the page.',
        'parameters': {
            'type': 'object',
            'properties': {
                'facts': {'type': 'array', 'items': {
                    'type': 'object',
                    'properties': {
                        'field': {'type': 'string', 'enum': list(AI_FIELDS) + ['faq']},
                        'value': {'type': 'string', 'description': 'The fact. For faq: "Question? || Answer".'},
                        'quote': {'type': 'string', 'description': 'Exact text copied from the page that supports the value.'},
                    },
                    'required': ['field', 'value', 'quote'],
                }},
            },
            'required': ['facts'],
        },
    },
}


def _normalize_space(s):
    return re.sub(r'\s+', ' ', s).strip().lower()


def grounded(quote, text):
    """True when the quote really appears in the source (ignoring whitespace and case)."""
    q = _normalize_space(quote)
    return len(q) >= 3 and q in _normalize_space(text)


def ai_claims(source, complete=None):
    """Claims from the AI. `complete(messages, tools) -> tool arguments dict` can be injected for tests.
    Any claim whose quote is not found in the source is dropped: the AI can propose, never invent."""
    complete = complete or _ai_complete
    if not complete:
        return []
    fields = '\n'.join(f'- {k}: {v}' for k, v in AI_FIELDS.items())
    messages = [
        {'role': 'system', 'content': 'You read one page of a church website and record facts with record_church_facts. '
                                      'Only record what the page says. Every fact needs an exact quote copied from the page. '
                                      f'Fields:\n{fields}\n- faq: a question and answer the page gives (value "Question? || Answer").'},
        {'role': 'user', 'content': f"Page: {source['url']}\nTitle: {source.get('title', '')}\n\n{source['text'][:12000]}"},
    ]
    try:
        args = complete(messages, [AI_TOOL]) or {}
    except Exception as error:
        log.warning('builder: AI extraction failed for %s: %s', source['url'], error)
        return []
    claims = []
    for fact in args.get('facts', []) if isinstance(args, dict) else []:
        field, value, quote = fact.get('field'), str(fact.get('value', '')).strip(), str(fact.get('quote', '')).strip()
        if field not in AI_FIELDS and field != 'faq' or not value or not grounded(quote, source['text']):
            continue
        if field == 'faq':
            if '||' not in value:
                continue
            q, a = (part.strip() for part in value.split('||', 1))
            value = {'question': q, 'answer': a}
        claims.append({'field': field, 'value': value, 'quote': quote, 'source_id': source['id'], 'method': 'ai'})
    return claims


def _ai_complete_impl(messages, tools):
    from . import chat
    clients = chat.make_clients()
    if not clients:
        return None
    name, model, extra_body, client = clients[0]
    response = client.chat.completions.create(model=model, messages=messages, tools=tools,
                                              tool_choice={'type': 'function', 'function': {'name': 'record_church_facts'}},
                                              temperature=0, **({'extra_body': extra_body} if extra_body else {}))
    calls = response.choices[0].message.tool_calls or []
    return json.loads(calls[0].function.arguments) if calls else None


def _ai_available():
    try:
        from . import chat
        return bool(chat.provider_chain())
    except Exception:
        return False


_ai_complete = _ai_complete_impl if os.environ.get('BUILDER_AI', '1') != '0' else None


def extract(sources, complete=None, deadline=None, notes=None):
    claims = []
    use_ai = complete is not None or (_ai_complete is not None and _ai_available())
    deadline = deadline if deadline is not None else _now() + IMPORT_BUDGET
    results = [None] * len(sources)
    if use_ai:
        results, skipped = _parallel(sources, lambda source: ai_claims(source, complete), deadline)
        if skipped and notes is not None:
            subject = '1 source was' if skipped == 1 else f'{skipped} sources were'
            notes.append(f'{subject} read without AI because it took too long.')
    for source, result in zip(sources, results):
        claims += pattern_claims(source)
        claims += result or []
    for i, claim in enumerate(claims, 1):
        claim['id'] = f'c{i}'
    return claims


# ---------------------------------------------------------------- 3. Clarify

def _key(field, value):
    if field == 'name':
        return re.sub(r'[^a-z0-9]', '', value.lower())
    if field == 'address':
        return re.sub(r'[^a-z0-9]', '', value.lower())[:24]
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True)
    return _normalize_space(str(value))


def _candidate(field, value, claims):
    return {'value': value, 'claim_ids': [c['id'] for c in claims], 'source_ids': sorted({c['source_id'] for c in claims})}


def reconcile(claims, source_count):
    """{field: {status, value, candidates}}. Plain rules, no AI:
    - email/phone: a value on more than half the pages that mention one is the church's (staff addresses on a
      single page are not); otherwise different values are a conflict.
    - services: per day, each page's set of times; if one page's set contains all the others it is used, else
      the different sets are a conflict ("9 & 11" on one page, "10:30" on another).
    - anything else: one distinct value is prefilled, more than one is a conflict.
    """
    by_field = {}
    for claim in claims:
        by_field.setdefault(claim['field'], []).append(claim)
    fields = {}
    for field, items in by_field.items():
        if field == 'faq':
            continue
        if field == 'services':
            fields[field] = _reconcile_services(items)
            continue
        groups = {}
        for claim in items:
            groups.setdefault(_key(field, claim['value']), []).append(claim)
        candidates = [_candidate(field, g[0]['value'], g) for g in groups.values()]
        candidates.sort(key=lambda c: -len(c['source_ids']))
        if field in ('email', 'phone') and len(candidates) > 1:
            pages = len({c['source_id'] for c in items})
            if len(candidates[0]['source_ids']) * 2 > pages and len(candidates[0]['source_ids']) > len(candidates[1]['source_ids']):
                candidates = candidates[:1]
        if field in ('about', 'first_visit', 'office_hours') and len(candidates) > 1:
            candidates = candidates[:1]  # prose: keep the most widely stated, the church edits it on review
        fields[field] = ({'status': 'prefilled', 'value': candidates[0]['value'], 'candidates': candidates}
                         if len(candidates) == 1 else {'status': 'conflict', 'value': None, 'candidates': candidates})
    for field in REQUIRED:
        fields.setdefault(field, {'status': 'missing', 'value': None, 'candidates': []})
    return fields


def _reconcile_services(items):
    per_source = {}
    for claim in items:
        day, time = claim['value']['day'], claim['value']['time']
        group = (claim['source_id'], claim.get('service_group'))
        per_source.setdefault(day, {}).setdefault(group, {})[time] = claim
    days, candidates = [], []
    conflict = False
    for day in DAYS:
        if day not in per_source:
            continue
        sets = {sid: frozenset(times) for sid, times in per_source[day].items()}
        largest = max(sets.values(), key=len)
        if all(s <= largest for s in sets.values()):
            days.append((day, sorted(largest)))
        else:
            conflict = True
        distinct = {}
        for sid, times in sets.items():
            distinct.setdefault(times, []).append(sid)
        for times, sids in distinct.items():
            claims = [per_source[day][sid][t] for sid in sids for t in times]
            candidates.append(_candidate('services', [{'day': day, 'time': t} for t in sorted(times)], claims))
    if conflict:
        return {'status': 'conflict', 'value': None, 'candidates': candidates}
    value = [{'day': day, 'time': t} for day, times in days for t in times]
    return {'status': 'prefilled', 'value': value, 'candidates': candidates}


def _show(field, value):
    if field == 'services' and isinstance(value, list):
        return ', '.join(f"{v['day']} {_twelve(v['time'])}" for v in value)
    if field == 'phone' and isinstance(value, str) and len(value) == 10:
        return f'({value[:3]}) {value[3:6]}-{value[6:]}'
    return str(value)


def _twelve(clock):
    h, m = map(int, clock.split(':'))
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _evidence(candidate, by_id, src):
    """Where a candidate value came from: each source and quote once."""
    seen, out = set(), []
    for cid in candidate['claim_ids']:
        claim = by_id[cid]
        key = (claim['source_id'], claim['quote'])
        if key not in seen:
            seen.add(key)
            source = src[claim['source_id']]
            out.append({'source_id': source['id'], 'url': source['url'], 'title': source.get('title', ''), 'quote': claim['quote']})
    return out


def questions(fields, claims, sources):
    """One question per conflict or missing required field, each candidate with its sources and quotes."""
    by_id = {c['id']: c for c in claims}
    src = {s['id']: s for s in sources}
    out = []
    for field, info in fields.items():
        label = FIELD_LABELS.get(field, field)
        if info['status'] == 'conflict':
            out.append({
                'field': field, 'kind': 'conflict',
                'prompt': f'We found {len(info["candidates"])} different answers for {label.lower()}. Which is right?',
                'candidates': [{'value': c['value'], 'display': _show(field, c['value']), 'evidence': _evidence(c, by_id, src)}
                               for c in info['candidates']],
            })
        elif info['status'] == 'missing':
            # A blank draft read nothing, so it asks plainly instead of reporting a miss.
            what = f'What are your {label.lower()}?' if field == 'services' else f'What is your {label.lower()}?'
            out.append({'field': field, 'kind': 'missing', 'candidates': [],
                        'prompt': what if not sources else f'We could not find your {label.lower()}. {what}'})
    return out


# ---------------------------------------------------------------- 4–5. Answer, confirm, build

def _parse_services(text):
    """A typed answer like "Sunday 8:30 AM, Sunday 10:45 AM, Wednesday 7:00 PM" or "Sundays 9 and 11".
    Each time belongs to the day written before it; with no day at all, Sunday."""
    out, day = [], 'Sunday'
    for part in re.split(r'[,;]|\band\b(?=\s*[A-Za-z]{3})', text):
        named = next((d for d in DAYS if DAY_RE[d].search(part)), None)
        day = named or day
        times = [_clock(h, m, ap) for h, m, ap in TIME_RE.findall(part)]
        if not times:
            for h1, m1, h2, m2 in BARE_TIMES_RE.findall(part):
                times += [_clock(h1, m1, None), _clock(h2, m2, None)]
        if not times:
            times = [_clock(h, m, None) for h, m in re.findall(r'\b(\d{1,2})(?::(\d{2}))?\b', part) if 1 <= int(h) <= 12]
        out += [{'day': day, 'time': t} for t in times if {'day': day, 'time': t} not in out]
    return sorted(out, key=lambda s: (DAYS.index(s['day']), s['time']))


def apply_answer(session, field, value):
    """The church's answer becomes a confirmed value (and a claim from 'the church itself')."""
    if field not in FIELD_LABELS:
        raise ValueError('Unknown field')
    if field == 'services':
        value = value if isinstance(value, list) else _parse_services(str(value))
        if not value:
            raise ValueError('Write the service times with a day, e.g. "Sundays 9:00 AM and 11:00 AM".')
        value = [{'day': v['day'], 'time': _clock(*v['time'].split(':'), None) if ':' in v['time'] else v['time']} for v in value]
    elif field == 'phone':
        if len(_digits(str(value))) != 10:
            raise ValueError('Enter a 10-digit phone number.')
        value = _digits(str(value))
    elif field == 'email':
        if not EMAIL_RE.fullmatch(str(value).strip()):
            raise ValueError('Enter a valid email.')
        value = str(value).strip().lower()
    else:
        value = str(value).strip()
        if not value:
            raise ValueError('Enter an answer.')
    session['fields'][field] = {**session['fields'].get(field, {'candidates': []}), 'status': 'confirmed', 'value': value}
    session['questions'] = [q for q in session['questions'] if q['field'] != field]
    session['status'] = 'clarifying' if session['questions'] else 'review'
    return session


def build_content(session, *, allow_unanswered=False):
    """The confirmed profile as ChurchContent (only the sections the builder fills)."""
    open_items = [q['field'] for q in session['questions']]
    if open_items and not allow_unanswered:
        raise ValueError('Answer the open questions first: ' + ', '.join(FIELD_LABELS.get(f, f) for f in open_items))
    f = {k: v.get('value') for k, v in session['fields'].items() if v.get('value') is not None}
    phone = _show('phone', f['phone']) if f.get('phone') else ''
    info = {
        'name': f.get('name') or ('Your church' if allow_unanswered else ''),
        'address': f.get('address', ''), 'phone': phone, 'email': f.get('email', ''),
        'office_hours': f.get('office_hours', ''), 'about': f.get('about', ''), 'first_visit': f.get('first_visit', ''),
        'services': [{'day': s['day'], 'time': _twelve(s['time']), 'note': ''} for s in f.get('services', [])],
        'map_query': f.get('address', ''),
    }
    faqs, seen = [], set()
    for claim in session['claims']:
        if claim['field'] == 'faq' and _normalize_space(claim['value']['question']) not in seen:
            seen.add(_normalize_space(claim['value']['question']))
            faqs.append({'question': claim['value']['question'], 'answer': claim['value']['answer']})
    content = {'info': info}
    if faqs:
        content['faqs'] = faqs
    return church_content.normalize(church_content.ChurchContent(**content))


def new_session(url, fetch=None, complete=None, fetch_bytes=None, describe=None):
    started, notes = _now(), []
    deadline = started + IMPORT_BUDGET
    sources = crawl(url, fetch, deadline=min(deadline, started + CRAWL_BUDGET), notes=notes)
    if not sources:
        raise ValueError('No pages could be read from that address.')
    if describe is not None or (_ai_describe is not None and _ai_available()):
        sources += read_images(sources, fetch_bytes, describe, deadline=deadline, notes=notes)
    return session_from_sources(url, sources, complete, deadline=deadline, notes=notes)


def session_from_sources(url, sources, complete=None, deadline=None, notes=None):
    notes = notes if notes is not None else []
    claims = extract(sources, complete, deadline=deadline, notes=notes)
    fields = reconcile(claims, len(sources))
    qs = questions(fields, claims, sources)
    return {'id': secrets.token_urlsafe(18), 'created_at': datetime.now(timezone.utc).isoformat(),
            'url': url, 'status': 'clarifying' if qs else 'review',
            'sources': sources, 'claims': claims, 'fields': fields, 'questions': qs, 'notes': notes}


# ---------------------------------------------------------------- storage and routes

DRAFT_SPACE = 'builder'
DRAFT_TTL = 24 * 60 * 60
_draft_lock = threading.RLock()


class ImportLimiter:
    """One container's rolling hour of imports; reset() keeps tests independent."""
    def __init__(self):
        self.lock = threading.Lock()
        self.starts = deque()
        self.running = 0

    def reset(self):
        with self.lock:
            self.starts.clear()
            self.running = 0

    @contextmanager
    def importing(self, ip):
        with self.lock:
            now = time.monotonic()
            while self.starts and self.starts[0][0] <= now - 3600:
                self.starts.popleft()
            if sum(client == ip for _, client in self.starts) >= 5:
                raise HTTPException(status_code=429, detail='Too many imports from this address. Try again in an hour.')
            if len(self.starts) >= 60:
                raise HTTPException(status_code=429, detail='Too many imports this hour. Please try again later.')
            if self.running >= 3:
                raise HTTPException(status_code=429, detail='Three imports are already running. Please try again shortly.')
            self.starts.append((now, ip))
            self.running += 1
        try:
            yield
        finally:
            with self.lock:
                self.running -= 1


import_limiter = ImportLimiter()


def _save(session):
    with db.use_church(DRAFT_SPACE):
        db.run(("INSERT INTO config VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data",
                ('draft:' + session['id'], json.dumps(session))))
    return session


def _delete(draft_id):
    with db.use_church(DRAFT_SPACE):
        db.run(('DELETE FROM config WHERE key = ?', ('draft:' + draft_id,)))


def _load(draft_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]{24}', draft_id):
        raise HTTPException(status_code=404, detail='Builder draft not found')
    with db.use_church(DRAFT_SPACE):
        row = db.one('SELECT data FROM config WHERE key = ?', ('draft:' + draft_id,))
    if not row:
        raise HTTPException(status_code=404, detail='Builder draft not found')
    draft = json.loads(row['data'])
    if (datetime.now(timezone.utc) - datetime.fromisoformat(draft['created_at'])).total_seconds() >= DRAFT_TTL:
        _delete(draft_id)
        raise HTTPException(status_code=404, detail='Builder draft not found')
    return draft


def _public(session):
    """The draft for the page, without the full page texts (the evidence quotes are enough)."""
    return {**session, 'notes': session.get('notes', []),
            'sources': [{k: s[k] for k in ('id', 'kind', 'url', 'title')} for s in session['sources']]}


class ImportBody(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    url: str = Field(min_length=4, max_length=500)


class AnswerBody(BaseModel):
    field: str = Field(min_length=1, max_length=40)
    value: str | list | dict


@router.post('/api/builder/drafts', status_code=201)
def import_site(body: ImportBody, request: Request):
    ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
    with import_limiter.importing(ip):
        try:
            session = new_session(body.url)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        with _draft_lock:
            return _public(_save(session))


@router.post('/api/builder/drafts/blank', status_code=201)
def import_blank(request: Request):
    ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
    with import_limiter.importing(ip):
        with _draft_lock:
            return _public(_save(session_from_sources(None, [])))


async def _uploaded_files(request, deadline):
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'multipart/form-data':
        raise HTTPException(status_code=400, detail='Upload files using multipart/form-data with the field name files.')
    received = 0

    async def receive():
        nonlocal received
        try:
            message = await asyncio.wait_for(request.receive(), max(0.0, deadline - _now()))
        except asyncio.TimeoutError as error:
            raise MultiPartException('The upload took too long. Please try again.') from error
        received += len(message.get('body', b''))
        if received > MAX_UPLOAD_BYTES + 64 * 1024:  # Allow bounded multipart headers.
            raise MultiPartException('Upload at most 10 MB of files in total.')
        return message

    bounded = Request(request.scope, receive=receive)
    async with bounded.form(max_files=MAX_UPLOAD_FILES, max_fields=0) as form:
        items = form.multi_items()
        if not 1 <= len(items) <= MAX_UPLOAD_FILES or any(key != 'files' or not isinstance(file, UploadFile) for key, file in items):
            raise HTTPException(status_code=400, detail='Choose 1 to 5 files using the field name files.')
        files, total = [], 0
        for _, file in items:
            data = bytearray()
            while chunk := await file.read(64 * 1024):
                total += len(chunk)
                if len(data) + len(chunk) > MAX_FILE_BYTES:
                    raise HTTPException(status_code=400, detail='Each file must be 5 MB or smaller.')
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=400, detail='Upload at most 10 MB of files in total.')
                data.extend(chunk)
            files.append((_file_title(file.filename), bytes(data)))
        return files


def _upload_session(files, deadline):
    notes = []
    sources = read_files(files, deadline=deadline, notes=notes)
    return session_from_sources(None, sources, deadline=deadline, notes=notes)


def _save_upload(session):
    with _draft_lock:
        return _public(_save(session))


@router.post('/api/builder/drafts/upload', status_code=201)
async def import_upload(request: Request):
    ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
    with import_limiter.importing(ip):
        deadline = _now() + max(0.0, IMPORT_BUDGET - 5.0)
        try:
            files = await _uploaded_files(request, deadline)
            session = await run_in_threadpool(_upload_session, files, deadline)
        except (ValueError, MultiPartException) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return await run_in_threadpool(_save_upload, session)


@router.get('/api/builder/drafts/{draft_id}')
def get_draft(draft_id: str):
    with _draft_lock:
        return _public(_load(draft_id))


@router.post('/api/builder/drafts/{draft_id}/answers')
def answer(draft_id: str, body: AnswerBody):
    with _draft_lock:
        session = _load(draft_id)
        try:
            apply_answer(session, body.field, body.value)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _public(_save(session))


def _content(draft_id):
    try:
        return build_content(_load(draft_id))
    except (ValueError, church_content.ContentError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post('/api/builder/drafts/{draft_id}/preview')
def preview(draft_id: str):
    with _draft_lock:
        return {'content': _content(draft_id)}


@router.get('/api/builder/drafts/{draft_id}/site')
def site(draft_id: str):
    with _draft_lock:
        return church_content.public_site(build_content(_load(draft_id), allow_unanswered=True))


@router.post('/api/builder/drafts/{draft_id}/apply')
def apply(draft_id: str):
    """The Worker requires this church's staff session. Consume the draft only after a successful write."""
    with _draft_lock:
        content = _content(draft_id)
        if db.current_church() == db.DEMO_CHURCH:
            raise HTTPException(status_code=403, detail='The demo church cannot be replaced. Sign up a church to build into.')
        db.replace_content(content)
        _delete(draft_id)
        return {'content': content, 'church': db.current_church()}
