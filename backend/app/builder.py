"""Agentic builder: turn an existing church website into a church profile, with every value traced to its source.

    1. Import   fetch the site into sources: [{id, url, title, text}]. robots.txt is obeyed, the sitemap and the
                navigation are read first, and pages are read most useful first (builder_crawl.py), with iCal and
                sermon feeds read as their own sources.
    2. Extract  read each source into claims: {field, value, quote, source_id, method}. Pattern rules catch
                phones, emails, addresses and service times; the AI (when configured) adds the name, prose and
                FAQs. Every AI claim must quote its source exactly, or it is dropped. Lists (events, staff,
                ministries, groups, locations, sermons) come from structured data (builder_structured.py) and from
                specialist readers, one bounded AI call per page (builder_agents.py), checked the same way.
    3. Clarify  plain code compares the claims field by field: one agreeing value is prefilled, different
                values are a conflict, nothing found for a required field is missing. Nothing is decided by
                the AI, and a conflict is never resolved without the church's answer.
    4. Confirm  the church answers the questions and reviews the profile.
    5. Build    the confirmed profile becomes ChurchContent JSON (church_content.py) and can be loaded into a
                church, whose own site is then the preview.

A website import runs in the background: POST answers 202 with a draft whose status is 'importing', and the
page polls GET until it is 'clarifying', 'review' or 'failed'. Public drafts live in the reserved platform space
'builder' as 'draft:<id>', expire after 24 hours, and can be applied once by staff into a new church.
"""
import asyncio
import contextvars
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
import heapq
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urldefrag, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException

from . import (builder_agents, builder_calendar, builder_crawl, builder_customize, builder_edit, builder_json,
               builder_run, builder_site, builder_structured, builder_theme, chat, church_content, db)
from .builder_edit import clean_layout, default_layout
from .builder_export import files as content_files, load as load_content_files, sources as content_sources, calendars as content_calendars

log = logging.getLogger(__name__)
router = APIRouter()

MAX_PAGES = max(1, min(60, int(os.environ.get('BUILDER_MAX_PAGES') or 40)))
CRAWL_WORKERS = 3
MAX_FEEDS = 4
MAX_SPECIALIST_CALLS = max(0, int(os.environ.get('BUILDER_MAX_AI_CALLS') or 60) - MAX_PAGES // 2)
MAX_PAGE_BYTES = 1_000_000
MAX_SOURCE_CHARS = 20_000
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_FILES = 5
FETCH_TIMEOUT = 10.0
IMPORT_BUDGET = float(os.environ.get('BUILDER_IMPORT_BUDGET', '75.0'))
CRAWL_BUDGET = 30.0
# A website import runs in the background (see import_site), so it can read more than one request allows.
JOB_BUDGET = float(os.environ.get('BUILDER_JOB_BUDGET') or 180.0)
JOB_MAX = JOB_BUDGET + 60.0
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
                # Each worker gets this thread's context, so its steps and counts reach the run (builder_run).
                pending[_WORKERS.submit(contextvars.copy_context().run, run, items[pos])] = pos
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


# Zero-width and text-direction characters: invisible on the page, so they can only hide or reorder words.
INVISIBLE_RE = re.compile('[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]')
VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}


def _hidden(attrs):
    """An element the page marks as not shown (hidden, aria-hidden, display:none, visibility:hidden)."""
    style = re.sub(r'\s+', '', attrs.get('style') or '').lower()
    return ('hidden' in attrs or (attrs.get('aria-hidden') or '').strip().lower() == 'true'
            or 'display:none' in style or 'visibility:hidden' in style)


class _PageText(HTMLParser):
    """Visible text (with images as [image: alt]), the <title>, and the links of one HTML page. Also kept for the
    structured readers: link text and whether a link is in the navigation, JSON-LD blocks, embedded players,
    feed links and the canonical address. Text the page hides (and comments) is not read: a reader could be told
    things there that visitors never see. Links inside hidden menus are still followed.
    For recreating the site (builder_site, builder_theme): the menu as (depth, label, href) per <nav>/<header>
    block, headings, form fields (never their values), button-styled links, stylesheets, icons and the logo."""
    # Form dropdowns are choices, not content (a "Which service?" list would read as service times).
    SKIP = {'script', 'style', 'noscript', 'template', 'svg', 'select', 'textarea'}
    BLOCK = {'p', 'div', 'br', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
             'header', 'footer', 'nav', 'main', 'aside', 'dt', 'dd', 'table', 'form', 'blockquote', 'label', 'button'}
    NAV = {'nav', 'header', 'footer'}
    HEADINGS = {'h1': 1, 'h2': 2, 'h3': 3, 'h4': 4, 'h5': 5, 'h6': 6}
    FIELD_SKIP = {'hidden', 'submit', 'button', 'image', 'reset', 'password', 'file'}
    MAX_JSONLD, MAX_FORMS, MAX_FIELDS, MAX_NAV, MAX_CSS = 10, 10, 30, 200, 60_000

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.images, self.title, self._skip, self._in_title = [], [], [], '', 0, False
        self.anchors, self.jsonld, self.embeds, self.feeds, self.canonical = [], [], [], [], ''
        self.meta, self.nav, self.headings, self.forms, self.ctas = {}, [], [], [], []
        self.styles, self.icons, self.logos, self.css, self.hidden_links = [], [], [], [], []
        self._nav, self._anchor, self._script, self._hide, self._style = 0, None, None, None, None
        self._block, self._items, self._heading, self._form, self._label, self._labels = 0, [], None, None, None, {}
        self.scripts, self.calendar_hints = 0, []

    def _nav_start(self, tag, attrs):
        if tag in ('nav', 'header', 'footer') and not self._nav:
            self._block += 1
            self._block_tag = tag
        if not self._nav or self._hide and tag != 'li':
            return
        if tag == 'li' and len(self.nav) < self.MAX_NAV:
            item = {'block': self._block, 'tag': getattr(self, '_block_tag', 'nav'), 'depth': len(self._items) + 1,
                    'text': [], 'href': '', 'open': True}
            self._items.append(item)
            self.nav.append(item)
        elif tag in ('ul', 'ol') and self._items:
            self._items[-1]['open'] = False  # the item's own label is done; its submenu follows
        elif tag == 'a' and self._items and self._items[-1]['open'] and not self._items[-1]['href']:
            self._items[-1]['href'] = attrs.get('href') or ''

    def _form_start(self, tag, attrs):
        if tag == 'form' and len(self.forms) < self.MAX_FORMS:
            self._form = {'action': attrs.get('action') or '', 'method': (attrs.get('method') or 'get').lower(),
                          'name': attrs.get('aria-label') or attrs.get('name') or attrs.get('id') or '',
                          'fields': [], 'submit': '', 'password': False}
            self.forms.append(self._form)
        elif self._form is None:
            return
        elif tag in ('input', 'select', 'textarea'):
            kind = (attrs.get('type') or 'text').lower() if tag == 'input' else tag
            if kind == 'password':
                self._form['password'] = True
            if kind in ('submit', 'button') and attrs.get('value') and not self._form['submit']:
                self._form['submit'] = attrs['value'][:60]
            if kind in self.FIELD_SKIP or len(self._form['fields']) >= self.MAX_FIELDS:
                return
            # A label with no `for` names the field it wraps, or else the next field ("<label>Email</label><input>").
            own = self._form.pop('_next_label', '') if not self._label else ''
            self._form['fields'].append({
                'name': (attrs.get('name') or '')[:80], 'type': kind, 'id': attrs.get('id') or '',
                'label': (attrs.get('aria-label') or own or attrs.get('placeholder') or '')[:120],
                'required': 'required' in attrs or (attrs.get('aria-required') or '') == 'true'})
        elif tag == 'label':
            self._label = [attrs.get('for') or '', [], len(self._form['fields'])]
        elif tag == 'button' and (attrs.get('type') or 'submit').lower() == 'submit':
            self._form['_button'] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self._hide:
            if tag == self._hide[0]:
                self._hide[1] += 1
        elif tag not in VOID_TAGS and _hidden(attrs):
            self._hide = [tag, 1]
        self._nav_start(tag, attrs)
        if attrs.get('data-tockify-calendar') and len(self.calendar_hints) < 5:
            self.calendar_hints.append(attrs['data-tockify-calendar'].strip())  # a Tockify embed names its calendar here
        if not self._hide:
            self._form_start(tag, attrs)
            if tag in self.HEADINGS:
                self._heading = [self.HEADINGS[tag], []]
        if tag == 'style' and len(''.join(self.css)) < self.MAX_CSS:
            self._style = []
        if tag in self.SKIP:
            self._skip += 1
            self.scripts += tag == 'script'
            if tag == 'script' and (attrs.get('type') or '').lower() == 'application/ld+json' and len(self.jsonld) < self.MAX_JSONLD:
                self._script = []
        elif tag == 'title':
            self._in_title = True
        elif tag == 'a' and attrs.get('href'):
            self.links.append(attrs['href'])
            self._anchor = [attrs['href'], [], self._nav > 0, attrs.get('aria-label') or attrs.get('title') or '']
            if self._hide or _hidden(attrs):
                self.hidden_links.append(attrs['href'])
            look = f"{attrs.get('class') or ''} {attrs.get('role') or ''}".lower()
            if not self._hide and re.search(r'\b(btn|button|cta)\b|button', look):
                self.ctas.append(attrs['href'])
        elif tag == 'img' and not self._hide and not _hidden(attrs):
            if attrs.get('src'):
                self.images.append(attrs['src'])
                look = ' '.join(attrs.get(k) or '' for k in ('class', 'id', 'alt', 'src')).lower()
                if 'logo' in look or self._nav and not self.logos and self._anchor is not None:
                    self.logos.append((attrs['src'], attrs.get('alt') or ''))
            if attrs.get('alt'):
                self.parts.append(f" [image: {attrs['alt']}] ")
        elif tag == 'meta' and attrs.get('content'):
            key = (attrs.get('property') or attrs.get('name') or '').strip().lower()
            if key and key not in self.meta and len(self.meta) < 40:
                self.meta[key] = ' '.join(INVISIBLE_RE.sub('', attrs['content']).split())[:500]
        elif tag == 'iframe' and attrs.get('src') and not self._hide:
            # A marker line, so builder_site can tell which section a player or form sits in.
            self.parts.append(f'\n[embed {len(self.embeds) + 1}]\n')
            self.embeds.append((attrs['src'], attrs.get('title') or attrs.get('aria-label') or ''))
        elif tag == 'link' and attrs.get('href'):
            rel, kind = (attrs.get('rel') or '').lower(), (attrs.get('type') or '').lower()
            if rel == 'canonical':
                self.canonical = attrs['href']
            elif 'stylesheet' in rel and len(self.styles) < 10:
                self.styles.append(attrs['href'])
            elif 'icon' in rel and len(self.icons) < 10:
                self.icons.append((attrs['href'], rel, attrs.get('sizes') or ''))
            elif 'alternate' in rel and ('rss' in kind or 'atom' in kind or 'calendar' in kind):
                self.feeds.append(attrs['href'])
        if tag in self.NAV:
            self._nav += 1
        if tag in self.BLOCK:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self._hide and tag == self._hide[0]:
            self._hide[1] -= 1
            if not self._hide[1]:
                self._hide = None
        if tag == 'li' and self._items:
            self._items.pop()['open'] = False
        if tag in self.HEADINGS and self._heading:
            text = ' '.join(''.join(self._heading[1]).split())
            if text:
                self.headings.append((self._heading[0], text[:200]))
            self._heading = None
        if self._form is not None:
            if tag == 'label' and self._label:
                target, words, first = self._label
                text = ' '.join(''.join(words).split())[:120]
                if target:
                    self._labels[target] = text
                elif len(self._form['fields']) > first:
                    for field in self._form['fields'][first:]:
                        field['label'] = field['label'] if field['id'] in self._labels else text
                else:
                    self._form['_next_label'] = text
                self._label = None
            elif tag == 'button' and '_button' in self._form:
                text = ' '.join(''.join(self._form.pop('_button')).split())
                self._form['submit'] = self._form['submit'] or text[:60]
            elif tag == 'form':
                self._form = None
        if tag == 'style' and self._style is not None:
            self.css.append(''.join(self._style))
            self._style = None
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
            if tag == 'script' and self._script is not None:
                self.jsonld.append(''.join(self._script)[:MAX_SOURCE_CHARS])
                self._script = None
        elif tag == 'title':
            self._in_title = False
        elif tag == 'a' and self._anchor:
            href, text, in_nav, label = self._anchor
            text = ' '.join(''.join(text).split()) or ('' if href in self.hidden_links else ' '.join(label.split()))
            self.anchors.append((href, text[:120], in_nav))
            self._anchor = None
        if tag in self.NAV:
            self._nav = max(0, self._nav - 1)
        if tag in self.BLOCK:
            self.parts.append('\n')

    def handle_data(self, data):
        if self._style is not None:
            self._style.append(data)
        if not self._hide and not self._skip:
            if self._items and self._items[-1]['open']:
                self._items[-1]['text'].append(data)
            if self._heading:
                self._heading[1].append(data)
            if self._label:
                self._label[1].append(data)
            if self._form is not None and '_button' in self._form:
                self._form['_button'].append(data)
        if self._script is not None:
            self._script.append(data)
        elif self._in_title:
            self.title += data
        elif not self._skip and not self._hide:
            self.parts.append(data)
            if self._anchor:
                self._anchor[1].append(data)

    def menu(self):
        """[(block, block tag, depth, label, href)] for menu items with a label."""
        out = []
        for item in self.nav:
            label = ' '.join(INVISIBLE_RE.sub('', ''.join(item['text'])).split())[:80]
            if label:
                out.append((item['block'], item['tag'], item['depth'], label, item['href']))
        return out

    def form_list(self):
        """Forms with their fields' labels; login forms are left out, and no field values are ever kept."""
        out = []
        for form in self.forms:
            if form.pop('password', False):
                continue
            form.pop('_button', None)
            form.pop('_next_label', None)
            fields, seen = [], set()
            for field in form['fields']:
                field_id = field.pop('id')
                field['label'] = (self._labels.get(field_id, '') if field_id else '') or field['label'] or field['name']
                key = (field['label'].lower(), field['name'], field['type'])
                if key not in seen:  # a checkbox group ("Volunteer in a Ministry" five times) is one field
                    seen.add(key)
                    fields.append(field)
            form['fields'] = fields
            out.append(form)
        return out

    def text(self):
        text = INVISIBLE_RE.sub('', ''.join(self.parts))
        lines = (re.sub(r'[ \t\r\f\v]+', ' ', line).strip() for line in text.split('\n'))
        return '\n'.join(line for line in lines if line)


def parse_html(html):
    page = _PageText()
    page.feed(html)
    page.close()
    return {'title': ' '.join(INVISIBLE_RE.sub('', page.title).split()), 'text': page.text(), 'links': page.links, 'images': page.images,
            'anchors': page.anchors, 'jsonld': page.jsonld, 'embeds': page.embeds, 'feeds': page.feeds,
            'canonical': page.canonical, 'meta': page.meta, 'nav': page.menu(), 'headings': page.headings,
            'forms': page.form_list(), 'ctas': page.ctas, 'styles': page.styles, 'icons': page.icons,
            'logos': page.logos[:3], 'css': ''.join(page.css)[:page.MAX_CSS], 'hidden_links': page.hidden_links,
            'scripts': page.scripts, 'calendar_hints': page.calendar_hints}


class FetchRefused(ValueError):
    """The fetch bridge refused an address (private network, unknown host, bad scheme)."""


def _fetch_bridge():
    """Base URL of a fetch bridge, or ''. On Cloudflare the container cannot reach arbitrary websites, so it asks
    the Worker (http://builder-fetch, api/builderfetch.ts), which checks every address and redirect itself."""
    return os.environ.get('BUILDER_FETCH_URL', '').strip().rstrip('/')


def _check_public(url):
    """Refuse URLs that would make the server fetch its own network (SSRF), unless BUILDER_ALLOW_PRIVATE=1."""
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('Enter a website address starting with http:// or https://')
    if os.environ.get('BUILDER_ALLOW_PRIVATE') == '1' or _fetch_bridge():
        return  # A fetch bridge resolves and checks the address where the request is really made.
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80))
    except socket.gaierror as error:
        raise ValueError('That website address could not be found.') from error
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError('That address is on a private network and cannot be imported.')


def _fetch_each(urls, fetch, deadline, workers):
    """One result per url, in order: ('ok', value), ('error', exception), or None for work cut off by the deadline."""
    def read(url):
        try:
            return 'ok', fetch(url)
        except Exception as error:  # one broken page must not stop the import
            return 'error', error
    values, _ = _parallel(urls, read, deadline, workers=workers)
    return values


class _Late(Exception):
    """A fetch that would start after the deadline because the site asked for a pause between requests."""


def host_policy(fetch_feed, deadline):
    """robots.txt rules and Crawl-delay pacing for every host the import touches (builder_crawl.HostPolicy)."""
    return builder_crawl.HostPolicy(
        fetch_feed, lambda urls, f: _fetch_each(urls, f, min(deadline, _now() + FETCH_TIMEOUT + 5), 1), now=_now)


def polite(fetch, policy, deadline):
    """`fetch` that skips addresses robots.txt disallows and waits out each host's Crawl-delay."""
    def go(url, *args):
        if not policy.allowed(url):
            raise PermissionError(f'robots.txt disallows {url}')
        if not policy.wait(url, deadline):
            raise _Late(url)
        return fetch(url, *args)
    return go


# How the progress feed names a page's type (builder_crawl.PAGE_TYPES).
PAGE_KINDS = {'home': 'home page', 'news': 'announcements', 'connect': 'sign-ups', 'staff': 'staff', 'events': 'events',
              'sermons': 'sermons', 'groups': 'groups', 'ministries': 'ministries', 'locations': 'locations',
              'visit': 'plan a visit', 'about': 'about', 'contact': 'contact', 'give': 'giving'}


STRONG_CHURCH_WORDS = re.compile(r'\b(church|chapel|parish|cathedral|tabernacle|abbey|basilica)\b', re.I)


def _page_name(source, church=''):
    """A page as Tekton names it: the part of its title that is not the church's name ("Crosspoint Church - Men's"
    is "Men's"), else its first heading, else its address. A title that is a sentence is not a name."""
    title = source.get('title') or ''
    parts = [p.strip() for p in TITLE_SPLIT.split(title) if p.strip()]
    if source.get('page_type') == 'home' or urlparse(source.get('url') or '').path.strip('/') in ('', 'home', 'index.html'):
        if len(parts) <= 1 or all(CHURCH_WORDS.search(p) or ',' in p for p in parts):
            return 'Home'
    names = {' '.join(n.lower().split()) for n in (church, title_name(title)) if n}
    own = [p for p in parts if ' '.join(p.lower().split()) not in names]
    if len(parts) > 1 and len(own) == len(parts):
        # "Crosspoint Church - Downtown Missional Community": the part that says church is the site's name.
        strong = [p for p in own if not STRONG_CHURCH_WORDS.search(p)]
        own = strong if len(strong) < len(own) else [p for p in own if not CHURCH_WORDS.search(p)]
    names = own[:1] + [text for _, text in source.get('headings') or []][:2] \
        + [s.get('heading') or '' for s in source.get('sections') or []][:2]
    for name in names:
        name = ' '.join(name.split())
        if name and len(name.split()) <= 8 and not re.search(r'[.!?]$', name):
            return name[:60]
    path = urlparse(source.get('url') or '').path.strip('/').rsplit('/', 1)[-1]
    return re.sub(r'[-_]+', ' ', re.sub(r'\.html?$', '', path)).strip().capitalize()[:60] or 'Home'


ROBOTS_UNREACHABLE = ('This website\'s robots.txt could not be read right now, so it cannot be imported safely. '
                      'Try again later, or upload your church materials instead.')
ROBOTS_REFUSED = ('This website asks automated tools not to read it (robots.txt), so it cannot be imported. '
                  'Upload your church materials instead.')


def crawl(start_url, fetch=None, max_pages=None, deadline=None, notes=None, fetch_feed=None, feeds=None, progress=None,
          policy=None):
    """Same-site HTML pages, most useful first (builder_crawl.score). `fetch(url) -> (final_url, content_type, text)`
    can be injected. With `fetch_feed` (used for robots.txt and sitemaps), robots.txt is obeyed for every host, its
    Crawl-delay paces the reading, and the sitemap's pages join the queue. Feed links (iCal, RSS) found on the way
    are appended to `feeds`. `progress(read, found)` is called after each batch of pages."""
    max_pages = max_pages or MAX_PAGES
    start_url = urldefrag(start_url.strip())[0]
    deadline = deadline if deadline is not None else _now() + min(CRAWL_BUDGET, IMPORT_BUDGET)
    _, skipped = _parallel([start_url], _check_public, deadline, workers=1)
    if skipped:
        if notes is not None:
            notes.append('Stopped reading before the first page to stay within the time limit.')
        return []
    origin = urlparse(start_url).netloc
    policy = policy or (host_policy(fetch_feed, deadline) if fetch_feed is not None else builder_crawl.HostPolicy())
    fetch = polite(fetch or _http_fetch, policy, deadline)
    workers = CRAWL_WORKERS
    feeds = feeds if feeds is not None else []
    order, queue, seen, sources = 0, [], {start_url}, []

    def push(url, value):
        nonlocal order
        order += 1
        heapq.heappush(queue, (-value, order, url))

    def add_feed(url):
        url = builder_crawl.feed_url(url)
        if url not in feeds and urlparse(url).scheme in ('http', 'https'):
            feeds.append(url)

    paced = False
    if fetch_feed is not None:
        robots = policy.rules(start_url)
        if robots.disallow_all:
            raise ValueError(ROBOTS_UNREACHABLE)
        if not robots.allowed(start_url):
            raise ValueError(ROBOTS_REFUSED)
        builder_run.step(f'Checked robots.txt: {origin} lets Tekton read its pages')
        delay = robots.crawl_delay()
        if delay:
            builder_run.step(f'This site asks for {delay:g} seconds between pages, so Tekton reads one page at a time')
            # One page at a time, with the pause the site asked for; what fits in the time is all that is read.
            workers, paced = 1, True
            max_pages = max(1, min(max_pages, int(max(0.0, deadline - _now()) * 0.8 / delay)))
        # Sitemaps get at most a fifth of the reading time.
        found_by = _now() + max(0.0, deadline - _now()) * 0.2
        mapped = builder_crawl.discover(start_url, robots, polite(fetch_feed, policy, found_by),
                                        lambda urls, f: _fetch_each(urls, f, found_by, workers))
        if mapped:
            builder_run.step(f'Found {len(mapped)} pages in the sitemap; reading the most useful first')
        for url in mapped:
            if url not in seen and not builder_crawl.skippable(url):
                seen.add(url)
                push(url, builder_crawl.score(url))
    push(start_url, float('inf'))
    posts, stopped = 0, False
    while queue and len(sources) < max_pages and _now() < deadline and not stopped:
        wave = []
        while queue and len(wave) < min(workers, max_pages - len(sources)):
            url = heapq.heappop(queue)[2]
            if url != start_url and (not policy.allowed(url) or builder_crawl.is_post(url) and posts >= builder_crawl.MAX_POSTS):
                continue
            posts += url != start_url and builder_crawl.is_post(url)
            wave.append(url)
        if not wave:
            break
        for url, result in zip(wave, _fetch_each(wave, fetch, deadline, workers)):
            if result is None or result[0] == 'error' and isinstance(result[1], _Late):
                push(url, float('inf'))  # read first next time; counted as not read in the note below
                stopped = True
                continue
            status, value = result
            if status == 'error':
                if isinstance(value, FetchRefused) and url == start_url:
                    raise value  # "That address is on a private network" says more than "no pages could be read".
                log.info('builder: skipped %s (%s)', url, value)
                continue
            final_url, content_type, body = value
            if 'html' not in content_type:
                continue
            page = parse_html(body)
            canonical = urldefrag(urljoin(final_url, page['canonical']))[0] if page['canonical'] else ''
            # The same page under two addresses ("/" and "/index.html") is one source, or it would count twice.
            if any(s['text'] == page['text'][:MAX_SOURCE_CHARS] or canonical and s['url'] == canonical for s in sources):
                continue
            images = [urldefrag(urljoin(final_url, src))[0] for src in page['images']]

            def address(href):
                return builder_crawl.unwrap(urldefrag(urljoin(final_url, href))[0])  # Google Sites wraps outside links
            anchors = [(address(href), text, nav) for href, text, nav in page['anchors']
                       if not href.lower().startswith(('mailto:', 'tel:', 'javascript:'))][:300]
            sources.append({'id': f's{len(sources) + 1}', 'kind': 'page', 'url': final_url, 'title': page['title'],
                            'text': page['text'][:MAX_SOURCE_CHARS],
                            'images': [i for i in images if urlparse(i).netloc == origin and IMAGE_RE.search(i)],
                            'page_type': builder_crawl.page_type(final_url, page['title']),
                            'links': list(dict.fromkeys(a[0] for a in anchors)),
                            'anchors': anchors, 'jsonld': page['jsonld'],
                            'site_name': page['meta'].get('og:site_name') or page['meta'].get('application-name', ''),
                            'meta': page['meta'], 'headings': page['headings'],
                            'nav': [(b, tag, depth, label, address(href) if href else '')
                                    for b, tag, depth, label, href in page['nav']],
                            'forms': [{**f, 'action': urljoin(final_url, f['action']) if f['action'] else final_url}
                                      for f in page['forms']],
                            'ctas': list(dict.fromkeys(address(h) for h in page['ctas']))[:30],
                            'styles': [urljoin(final_url, h) for h in page['styles']],
                            'icons': [(urljoin(final_url, h), rel, sizes) for h, rel, sizes in page['icons']],
                            'logos': [(urljoin(final_url, src), alt) for src, alt in page['logos']],
                            'css': page['css'],
                            'hidden_links': list({address(h) for h in page['hidden_links']}),
                            'embeds': [(urljoin(final_url, src), title) for src, title in page['embeds']],
                            'scripts': page['scripts'], 'calendar_hints': page.get('calendar_hints', [])})
            kind = PAGE_KINDS.get(sources[-1]['page_type'])
            builder_run.step(f'Read “{_page_name(sources[-1])}”' + (f' ({kind})' if kind else ''))
            for href in page['feeds']:
                add_feed(urljoin(final_url, href))
            for link, text, nav in anchors:
                podcast = builder_crawl.podcast_feed(link)
                if podcast:
                    add_feed(podcast)  # a sermon podcast's own feed (Spreaker, Anchor, Buzzsprout...), read like any feed
                elif builder_crawl.is_feed(link):
                    add_feed(link)
                elif builder_crawl.same_site(link, origin) and link not in seen and not builder_crawl.skippable(link):
                    seen.add(link)
                    push(link, builder_crawl.score(link, text, nav))
            for href in page['links']:
                if href.lower().startswith('webcal:'):
                    add_feed(href)
        if progress:
            progress(len(sources), len(sources) + len(queue))
    if paced and notes is not None:
        notes.append(f'This website asks automated tools to pause {delay:g} seconds between pages, so the builder '
                     'read one page at a time.')
    if queue and notes is not None:
        total = min(max_pages, len(sources) + len(queue))
        if len(sources) < max_pages:
            notes.append(f'Stopped reading after {len(sources)} of {total} pages to stay within the time limit.')
        else:
            notes.append(f'Read the {len(sources)} most useful pages of {len(sources) + len(queue)} found; '
                         'older posts and archive pages were skipped.')
    return sources


def read_feeds(feeds, fetch_feed, first_id, deadline, notes=None, policy=None):
    """Calendar (iCal) and sermon (RSS, podcast) feeds as sources of kind 'feed'. Calendars are read first. Feeds
    on any host follow that host's robots.txt."""
    if not feeds or fetch_feed is None or _now() >= deadline:
        return []
    policy = policy or host_policy(fetch_feed, deadline)
    ranked = sorted(dict.fromkeys(feeds), key=lambda u: (not re.search(r'\.ics|calendar', u, re.I),
                                                         not re.search(r'sermon|podcast|message', u, re.I)))
    ranked = [u for u in ranked if policy.allowed(u)][:MAX_FEEDS]
    out = []
    for url, result in zip(ranked, _fetch_each(ranked, polite(fetch_feed, policy, deadline), deadline, CRAWL_WORKERS)):
        if not result or result[0] != 'ok':
            continue
        final_url, _, body = result[1]
        body = body if isinstance(body, str) else body.decode('utf-8', errors='replace')
        calendar = 'BEGIN:VCALENDAR' in body[:2000]
        if not calendar and not re.search(r'<(rss|feed)\b', body[:2000]):
            continue
        out.append({'id': f's{first_id + len(out)}', 'kind': 'feed', 'url': final_url,
                    'title': 'Calendar feed' if calendar else 'News or podcast feed', 'text': '', 'feed': body[:MAX_PAGE_BYTES]})
    return out


IMAGE_RE = re.compile(r'\.(png|jpe?g|gif|webp)$', re.I)
MAX_IMAGES = 5
MAX_IMAGE_BYTES = 4_000_000


def read_images(sources, fetch_bytes=None, describe=None, deadline=None, notes=None, policy=None):
    """Image sources: a bulletin or flyer often holds the only copy of a service time. Each same-site image
    (at most MAX_IMAGES) is transcribed by a vision model into text that the same rules then read. With no
    vision model, images are skipped."""
    describe = describe if describe is not None else _ai_describe
    if not describe:
        return []
    deadline = deadline if deadline is not None else _now() + IMPORT_BUDGET
    fetch_bytes = polite(fetch_bytes or _http_fetch_bytes, policy or builder_crawl.HostPolicy(), deadline)
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


def _bridge_fetch(url, kind):
    """(final_url, content_type, body bytes) through the fetch bridge, which enforces the size and redirect limits."""
    with httpx.Client(timeout=FETCH_TIMEOUT + 5) as client:
        response = client.post(_fetch_bridge() + '/fetch', json={'url': url, 'kind': kind})
    if response.status_code != 200:
        try:
            detail = response.json().get('detail')
        except Exception:
            detail = None
        error = FetchRefused if response.status_code in (400, 403) else ValueError
        raise error(detail if isinstance(detail, str) else f'That page could not be read ({response.status_code}).')
    return response.headers.get('x-final-url') or url, response.headers.get('content-type', ''), response.content


def _http_fetch_bytes(url):
    _check_public(url)
    if _fetch_bridge():
        _, content_type, data = _bridge_fetch(url, 'image')
        content_type = content_type.split(';')[0]
        if not content_type.startswith('image/') or len(data) > MAX_IMAGE_BYTES:
            raise ValueError('not a small image')
        return content_type, data
    with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False, headers={'User-Agent': 'Tekton/0.1'}) as client:
        response = client.get(url)
        response.raise_for_status()
        content_type = response.headers.get('content-type', '').split(';')[0]
        if not content_type.startswith('image/') or len(response.content) > MAX_IMAGE_BYTES:
            raise ValueError('not a small image')
        return content_type, response.content


GLOO_BUILDER_DEFAULT = 'gloo-anthropic-claude-haiku-4.5'


def builder_model(provider, model):
    """The builder's model. On Gloo the chat's default (gloo-qwen-3.7-flash) reasons for 30+ seconds per call, which
    would spend the whole import budget on a page or two, so the builder uses a fast model that also reads images:
    GLOO_BUILDER_MODEL, then GLOO_MATCH_MODEL (Find a place's fast model), then Claude Haiku 4.5 on Gloo.
    Every other provider (Ollama on the laptop) keeps its configured model."""
    if provider != 'gloo':
        return model
    return os.environ.get('GLOO_BUILDER_MODEL') or os.environ.get('GLOO_MATCH_MODEL') or GLOO_BUILDER_DEFAULT


def _ai_describe_impl(data, content_type):
    """Transcribe an image's words with the first configured model that accepts images."""
    import base64
    from . import chat
    clients = chat.make_clients()
    if not clients:
        return ''
    name, model, extra_body, client = clients[0]
    model = builder_model(name, model)
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


FEED_TYPES = re.compile(r'xml|rss|atom|calendar|text/plain', re.I)


def _http_fetch(url, kind='page'):
    """(final_url, content_type, text). kind 'feed' is for robots.txt, sitemaps and iCal/RSS feeds."""
    _check_public(url)
    if _fetch_bridge():
        final_url, content_type, data = _bridge_fetch(url, kind)
        charset = re.search(r'charset=([\w.-]+)', content_type)
        try:
            text = data.decode(charset.group(1) if charset else 'utf-8', errors='replace')
        except LookupError:
            text = data.decode('utf-8', errors='replace')
        return final_url, content_type, text[:MAX_PAGE_BYTES]
    with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False, headers={'User-Agent': 'Tekton/0.1'}) as client:
        response = client.get(url)
        hops = 0
        while response.is_redirect and hops < 5:
            url = urljoin(url, response.headers['location'])
            _check_public(url)  # a redirect must not lead into a private network either
            response = client.get(url)
            hops += 1
        response.raise_for_status()
        content_type = response.headers.get('content-type', '')
        if kind == 'feed' and not FEED_TYPES.search(content_type):
            raise ValueError('not a feed')
        if kind == 'css' and not re.match(r'text/css\b', content_type, re.I):
            raise ValueError('not a stylesheet')
        return str(response.url), content_type, response.text[:MAX_PAGE_BYTES]


def _http_feed(url):
    return _http_fetch(url, 'feed')


def _http_css(url):
    return _http_fetch(url, 'css')


# ---------------------------------------------------------------- 2. Extract

PHONE_RE = re.compile(r'\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}\b')
EMAIL_RE = re.compile(r'\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b')
STREET_RE = re.compile(r'\b\d{1,6}\s+(?:[A-Z][\w.\'-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Circle|Terrace)\b\.?(?:,?\s+[A-Z][\w\s.\'-]{1,40},\s*[A-Z]{2}\b)?')
TIME_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b', re.I)
BARE_TIMES_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*(?:&|and|\+)\s*(\d{1,2})(?::(\d{2}))?\b')
WORSHIP_WORDS = re.compile(r'\b(worship|service|services|gathering|mass|traditional|contemporary|join us)\b', re.I)
NOT_WORSHIP = re.compile(r'\b(sunday school|office|youth|kids|nursery|rehears|breakfast|study|potluck|dinner|lunch|fish fry|'
                         r'class(?:es)?|students?)\b', re.I)
# A calendar date ("Sunday, November 1, 2026") is a one-off event, not a weekly service time.
# Ordinals and their typos ("October 15th", "Oct 25h"), numeric dates ("10/25") and ISO dates count too.
DATED = re.compile(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th|h)?\b'
                   r'|\b\d{1,2}(?:st|nd|rd|th)\s+of\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)'
                   r'|\bthe\s+\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b', re.I)
# A monthly or yearly gathering ("the last Tuesday of every month") is an event, not a weekly service time.
NOT_WEEKLY = re.compile(r'\b(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\s+(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*'
                        r'\s+(?:of|in|each|every)\b|\b(?:of|each|every)\s+(?:the\s+)?month\b|\bmonthly\b|\bonce\s+a\s+'
                        r'(?:month|quarter|year)\b|\bevery\s+other\b|\bbi-?weekly\b|\bquarterly\b|\bannual(?:ly)?\b|'
                        r'\bonce\s+a\s+year\b', re.I)
# "6:30 - 7:30 PM", "10am to noon": a service starts at the first time; the end time is not another service.
RANGE_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?\s*(?:-|–|—|to|until|till)\s*'
                      r'(\d{1,2})(?::\d{2})?\s*([ap])\.?\s*m\.?\b', re.I)
# Announcement, news and event pages invite people to one-off gatherings ("Come join us on Sunday at 4 PM for
# trunk or treat"), so there a sentence must say worship, service or mass, and "join us" with a day is not enough.
STRICT_PAGES = ('news', 'events')
STRICT_WORSHIP = re.compile(r'\b(worship|services?|mass)\b', re.I)
# "9:00 & 11:00 am": the am/pm after the last time covers the times listed before it.
SHARED_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*(?:&|and|\+|,)\s*(?=(?:\d{1,2}(?::\d{2})?\s*(?:&|and|\+|,)\s*)*'
                       r'(\d{1,2})(?::\d{2})?\s*([ap])\.?\s*m\.?\b)', re.I)


# An address written in any case. Lower case is common in prose and headings ("join us at: 150 alum springs road"),
# where words like "way" or "drive" also appear, so it must end in ", city, ST 12345" to count.
ANY_CASE_STREET_RE = re.compile(r'\b\d{1,6}\s+(?:[a-z][\w.\'-]*\s+){1,4}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|'
                                r'boulevard|blvd|way|court|ct|place|pl|parkway|pkwy|highway|hwy|circle|terrace)\b\.?,?\s+'
                                r'[a-z][a-z\s.\'-]{1,40},\s*[a-z]{2}\s+\d{5}(?:-\d{4})?\b', re.I)


def _address_case(address):
    """'150 Alum springs road, lynchburg, va 24502' as '150 Alum Springs Road, Lynchburg, VA 24502'."""
    *street, last = [p.strip() for p in address.split(',')]
    state = re.sub(r'^([a-z]{2})\b', lambda m: m.group(1).upper(), last, flags=re.I)
    return ', '.join([' '.join(w[:1].upper() + w[1:] for w in p.split()) for p in street] + [state])


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


def _times(sentence):
    """Clock times in a sentence, in order, including ones that share a later am/pm. A range ("6:30 - 7:30 PM")
    counts as its start time only."""
    found, ends = [], set()
    for m in RANGE_RE.finditer(sentence):
        hour, minute, own, last, ampm = m.groups()
        found.append((m.start(), _clock(hour, minute, own or (ampm if int(hour) % 12 <= int(last) % 12 else None))))
        ends.add(m.start(4))
    found += [(m.start(), _clock(*m.groups())) for m in TIME_RE.finditer(sentence)
              if m.start() not in ends and not any(r.start() <= m.start() < r.end() for r in RANGE_RE.finditer(sentence))]
    for m in SHARED_RE.finditer(sentence):
        hour, minute, last, ampm = m.groups()
        # "11 & 1 pm" does not make 11 pm: the shared am/pm only applies when the order still makes sense.
        found.append((m.start(), _clock(hour, minute, ampm if int(hour) % 12 <= int(last) % 12 else None)))
    return list(dict.fromkeys(clock for _, clock in sorted(found)))


def _labeled(text):
    """(sentence, label, following) triples: each sentence with the line above it, which on a sidebar or card is its
    label ("Youth Group" above "Sundays, 6:00 PM"), and the sentence after it, which can explain it ("Sundays - 9:45am"
    over "Grade-specific Sunday School classes are offered at 9:45")."""
    sentences = [s.strip() for line in text.split('\n') if line.strip()
                 for s in re.split(r'(?<=[.!?])\s+', line.strip()) if s.strip()]
    for i, sentence in enumerate(sentences):
        yield sentence, sentences[i - 1] if i else '', sentences[i + 1] if i + 1 < len(sentences) else ''


def _clauses(sentence):
    """(clause, day) for a sentence that lists several things: "Sunday Services at 8:30am & 11:00am; Sunday School at
    9:45am; Wednesday Evening at 6:30pm". A clause with no day of its own keeps the one before it. A sentence that
    is about one thing stays whole."""
    if not NOT_WORSHIP.search(sentence) or not re.search(r'[;,]', sentence):
        return [(sentence, None)]
    out, day = [], None
    for clause in (c.strip() for c in re.split(r'\s*[;,]\s*', sentence) if c.strip()):
        own = next((d for d in DAYS if DAY_RE[d].search(clause)), None)
        out.append((clause, None if own else day))
        day = own or day
    return out


def service_times(text, strict=False):
    """{day: [(clock, quote)]} for sentences that talk about worship and name a day and times. strict (announcement
    and event pages) needs the sentence to say worship, service or mass. A sentence that does not say worship
    takes its label from the line above: "Youth Group" over "Sundays, 6:00 PM" is not a service time. A bulletin's
    dated heading over "Worship: 10:00 AM" is that Sunday's service time (its quote keeps both lines)."""
    found = {}
    worship = STRICT_WORSHIP if strict else WORSHIP_WORDS
    lines = text.split('\n')
    for whole, label, following in _labeled(text):
        for sentence, carried in _clauses(whole):  # one clause of a list at a time
            days = [d for d in DAYS if DAY_RE[d].search(sentence)] or ([carried] if carried else [])
            if not days and label and DATED.search(label) and len(sentence) <= 40 and STRICT_WORSHIP.match(sentence) \
                    and not NOT_WORSHIP.search(sentence):
                day = next((d for d in DAYS if DAY_RE[d].search(label)), None)
                times = _times(sentence)
                if day and times:
                    found.setdefault(day, [])
                    found[day] += [(t, f'{label} {sentence}') for t in times if t not in [x for x, _ in found[day]]]
                continue
            if not days or NOT_WORSHIP.search(sentence) or DATED.search(sentence) or NOT_WEEKLY.search(sentence):
                continue
            if not worship.search(sentence) and label and (NOT_WORSHIP.search(label) or NOT_WEEKLY.search(label)):
                continue
            if not worship.search(sentence) and NOT_WORSHIP.search(following) and not worship.search(following):
                continue  # "Sundays - 9:45am" explained by the next line: "Sunday School classes are offered at 9:45"
            times = _times(sentence)
            if not times and worship.search(sentence) or not strict and re.search(r'\bsundays?\b\s+\d', sentence, re.I):
                for h1, m1, h2, m2 in BARE_TIMES_RE.findall(sentence):
                    times += [_clock(h1, m1, None), _clock(h2, m2, None)]
            if not times or not (worship.search(sentence) or not strict and len(days) == 1 and re.search(r'\bsundays?\b', sentence, re.I)):
                continue
            for day in days[:1]:
                found.setdefault(day, [])
                found[day] += [(t, sentence) for t in times if t not in [x for x, _ in found[day]]]
    # Tables and footers: a "Sunday" cell or heading followed by times on the next lines (not on announcement pages).
    for i, line in enumerate([] if strict else lines):
        day = next((d for d in DAYS if re.fullmatch(rf'{d}s?( services?| worship)?', line.strip(), re.I)), None)
        if not day:
            continue
        for k, nxt in enumerate(lines[i + 1:i + 4], i + 1):
            if NOT_WORSHIP.search(nxt) or DATED.search(nxt) or NOT_WEEKLY.search(nxt) or any(re.match(rf'{d}\b', nxt) for d in DAYS):
                break
            for clock in _times(nxt):
                found.setdefault(day, [])
                if clock not in [x for x, _ in found[day]]:
                    # The quote is the page's own words, from the heading down to this time.
                    found[day].append((clock, ' '.join(l.strip() for l in lines[i:k + 1] if l.strip())))
    return found


TITLE_SPLIT = re.compile(r'\s+[|\-–—·:]\s+')
CHURCH_WORDS = re.compile(r'\b(church|chapel|parish|cathedral|fellowship|assembly|congregation|tabernacle|ministries|'
                          r'temple|abbey|basilica|mission|community)\b', re.I)


def title_name(title):
    """The church's name from a page title: "Plan a Visit | Cedar Hollow Church", "Grace Chapel - Home". The part
    that says church (chapel, parish...) wins; otherwise the part after the last " | ", where most sites put it.
    ("HLC - Welcome!!" names nothing.)"""
    parts = [p.strip() for p in TITLE_SPLIT.split(title or '') if p.strip()]
    churchy = [p for p in parts if CHURCH_WORDS.search(p)]
    if len(parts) > 1 and len(churchy) == 1:
        return churchy[0]
    return title.rsplit(' | ', 1)[1].strip() if ' | ' in (title or '') else ''


def pattern_claims(source):
    """Claims from plain rules: no AI involved, so they work offline and are easy to explain."""
    text, sid, claims = source['text'], source['id'], []
    for match in sorted(set(EMAIL_RE.findall(text))):
        claims.append({'field': 'email', 'value': match.lower(), 'quote': match, 'source_id': sid, 'method': 'pattern'})
    for match in sorted(set(PHONE_RE.findall(text))):
        claims.append({'field': 'phone', 'value': _digits(match), 'quote': match, 'source_id': sid, 'method': 'pattern'})
    flat = text.replace('\n', ', ')
    found = sorted(set(m.group(0).strip(' ,.') for m in STREET_RE.finditer(flat)))
    for match in found:
        claims.append({'field': 'address', 'value': match, 'quote': match, 'source_id': sid, 'method': 'pattern'})
    for match in sorted(set(m.group(0).strip(' ,.') for m in ANY_CASE_STREET_RE.finditer(flat))):
        if not any(match.lower() in f.lower() or f.lower() in match.lower() for f in found):
            # "150 Alum springs road, lynchburg, va 24502": shown as an address, quoted as the page wrote it.
            claims.append({'field': 'address', 'value': _address_case(match), 'quote': match, 'source_id': sid,
                           'method': 'pattern'})
    if source.get('kind', 'page') == 'page':
        name, quote = title_name(source.get('title', '')), source.get('title', '')
        if source.get('site_name') and CHURCH_WORDS.search(source['site_name']):
            name, quote = source['site_name'], source['site_name']
        if name:
            # Quote the name where the page shows it, so its source link lands on it; else the title it came from.
            shown = re.search(re.escape(name).replace('\\ ', r'\s+'), text, re.I)
            claims.append({'field': 'name', 'value': name, 'quote': shown.group(0) if shown else quote, 'source_id': sid,
                           'method': 'pattern'})
    # Uploads and campus pages list several sets of times; each quote is its own set, so different campuses'
    # times become a question instead of being merged into one list.
    separate = source.get('url') is None or source.get('page_type') == 'locations'
    for day, times in service_times(text, strict=source.get('page_type') in STRICT_PAGES).items():
        for clock, quote in times:
            # A dated bulletin's time is its own answer, so "9:00 on the website, 10:00 in Sunday's bulletin" is asked.
            group = quote if separate or DATED.search(quote) else None
            claims.append({'field': 'services', 'value': {'day': day, 'time': clock}, 'quote': quote,
                           'source_id': sid, 'method': 'pattern', **({'service_group': group} if group else {})})
    return claims


# Office hours must be quoted from words about the office being open ("Office hours", "Open Monday - Thursday"), with
# a time in them; a service time or a phone number under "Church Office" is not office hours.
OFFICE_WORDS = re.compile(r'\b(office|hours?|open|closed|weekdays?)\b|\b(?:mon|tue|wed|thu|fri)[a-z]*\.?\s*(?:-|–|—|through|'
                          r'thru|to)\s*(?:mon|tue|wed|thu|fri|sat)', re.I)
OFFICE_TIMES = re.compile(r'\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\b|-|–|—|to\b)|\bnoon\b|\bby appointment\b', re.I)
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


BELIEFS_RE = re.compile(r'belie(?:fs?|ve)\b|doctrin|statement[-\s]of[-\s]faith|what[-\s]we[-\s]teach|our[-\s]faith|creed|confession', re.I)
BELIEFS_PLACEHOLDER_NOTE = ('Your website\'s beliefs section is only a placeholder, so it was not imported. Tekton does '
                            'not write theology; your pastor can add your statement of faith in Church setup.')


def is_beliefs(page):
    """A page that holds the church's statement of faith, by its address or title."""
    return bool(BELIEFS_RE.search(urlparse(page.get('url') or '').path + ' ' + (page.get('path') or '') + ' ' + (page.get('title') or '')))


def quote_context(text, quote, words=3):
    """A few words before and after the quote on its page ({'prefix', 'suffix'}), so a link can point at this
    place on the page when the same words appear twice (a URL text fragment, frontend/src/sourceLink.js).
    Each side stays on one line of the page: browsers do not always match context across a block boundary, and
    context that does not match stops the link from scrolling at all."""
    if not text or not quote:
        return {}
    parts = str(quote).split()
    if not parts:
        return {}
    found = re.search(r'\s+'.join(map(re.escape, parts)), text, re.IGNORECASE)
    if not found:
        return {}
    line = lambda chunk: next((l for l in chunk if l.strip()), '')  # noqa: E731, E741
    head, tail = text[:found.start()].split('\n'), text[found.end():].split('\n')
    # The words just before the quote on its own line, else the line above it; the same after it.
    before = (head[-1] if head[-1].strip() else line(reversed(head))).split()[-words:]
    after = (tail[0] if tail[0].strip() else line(tail)).split()[:words]
    out = {}
    if before:
        out['prefix'] = ' '.join(before)[-80:]
    if after:
        out['suffix'] = ' '.join(after)[:80]
    return out


def grounded(quote, text):
    """True when the quote really appears in the source (ignoring whitespace and case)."""
    q = _normalize_space(quote)
    return len(q) >= 3 and q in _normalize_space(text)


def ai_claims(source, complete=None, deadline=None, errors=None):
    """Claims from the AI. `complete(messages, tools) -> tool arguments dict` can be injected for tests.
    Any claim whose quote is not found in the source is dropped: the AI can propose, never invent.
    A failed call is appended to `errors`; each real call is limited to the time left before `deadline`."""
    complete = _completer(complete, deadline)
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
        log.warning('builder: AI extraction failed for %s: %s', source.get('url') or source.get('title'), error)
        if errors is not None:
            errors.append(source['id'])
        return []
    claims = []
    beliefs = is_beliefs(source)
    facts = builder_agents.entries(args, 'facts')
    if facts is None:
        if args:
            builder_run.drop('not in the expected shape')  # one answer that could not be read, counted once
        facts = []
    for fact in facts:
        if not isinstance(fact, dict):
            builder_run.drop('not in the expected shape')
            continue
        fact = builder_agents.clean(fact)
        field, value, quote = fact.get('field'), str(fact.get('value', '')).strip(), str(fact.get('quote', '')).strip()
        if field not in AI_FIELDS and field != 'faq' or not value:
            builder_run.drop('not a detail Tekton asked for')
            continue
        reason = ''
        if not grounded(quote, source['text']):
            reason = 'its quote is not on the page'
        elif field == 'name' and _key('name', value) not in re.sub(r'[^a-z0-9]', '', quote.lower()):
            reason = 'its quote does not name the church'
        elif field == 'office_hours' and not (OFFICE_WORDS.search(quote) and OFFICE_TIMES.search(quote)):
            reason = 'not office hours'  # a service time, or "Church Office" over a phone number
        if reason:
            builder_run.drop(reason)
            builder_run.removed(reason, field, value, source, quote)  # the church can still add it back
            continue
        if beliefs and field == 'about':
            continue  # a statement of faith is kept word for word for the pastor, never summarized (is_beliefs)
        if field == 'faq':
            if '||' not in value:
                builder_run.drop('not in the expected shape')
                continue
            q, a = (part.strip() for part in value.split('||', 1))
            value = {'question': q, 'answer': a}
        claims.append({'field': field, 'value': value, 'quote': quote, 'source_id': source['id'], 'method': 'ai'})
    return claims


def _completer(complete, deadline):
    """The call one AI task makes: an injected `complete`, or the real model limited to the time left."""
    if complete is None and _ai_complete is not None and deadline is not None:
        remaining = max(1.0, deadline - _now())
        return lambda messages, tools: _ai_complete(messages, tools, timeout=remaining)  # noqa: E731
    return complete or _ai_complete


def _tool_arguments(text):
    """Tool arguments as a dict. Some models wrap the JSON in prose or a code fence; take the outer object."""
    try:
        return json.loads(text)
    except ValueError:
        start, end = text.find('{'), text.rfind('}')
        return json.loads(text[start:end + 1]) if 0 <= start < end else None


# Structured output: Tekton's readers (READER_TOOLS) ask for JSON constrained to their tool's schema, the
# OpenAI-compatible `response_format` json_schema that Gemini, OpenAI and Qwen models honor, instead of a forced tool
# call. Gloo's guarded endpoint does not document response_format (it may drop it silently), so these calls go to its
# direct chat completions endpoint (BUILDER_STRUCTURED_ENDPOINT), with the same key.
# BUILDER_STRUCTURED_OUTPUT: auto (by model family, see output_mode), json_schema, or tools. Any refusal (400, 401,
# 403, 404, 422), an answer that is not JSON, cut short or filtered, or one missing the schema's top-level fields
# falls back to the forced tool call on the usual endpoint, and that model is not asked for json_schema again by
# this process. Other AI calls (plain-word edits) keep their tool call.
READER_TOOLS = {'record_church_facts', 'record_events', 'record_staff', 'record_ministries', 'record_sermons',
                'record_locations'}
DIRECT_ENDPOINT = 'https://platform.ai.gloo.com/ai/v2/direct'
# Model families whose OpenAI-compatible answers follow a json_schema; Anthropic's compatibility layer ignores it.
JSON_SCHEMA_MODELS = re.compile(r'^gloo-(openai-|google-gemini-|qwen-3\.[78]-(flash|plus|max))', re.I)
# Keywords the portable subset leaves out (lengths and patterns stay enforced by Pydantic after parsing).
UNPORTABLE = ('minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum',
              'exclusiveMaximum', 'maxItems', 'default', '$ref', '$defs', 'title')
_no_json_schema = set()


def output_mode(provider, model, tool_name=None):
    """'json_schema' or 'tools' for one call."""
    if tool_name is not None and tool_name not in READER_TOOLS:
        return 'tools'
    mode = (os.environ.get('BUILDER_STRUCTURED_OUTPUT') or 'auto').strip().lower()
    if mode == 'tools' or model in _no_json_schema:
        return 'tools'
    if mode == 'json_schema':
        return 'json_schema'
    if provider == 'openai':
        return 'json_schema'
    return 'json_schema' if provider == 'gloo' and JSON_SCHEMA_MODELS.match(model or '') else 'tools'


def strict_schema(schema):
    """The tool's JSON Schema in the strict, portable subset structured output needs: every object lists all its
    properties as required (an optional one may be null instead) and allows no others; string enums only; no
    $ref, lengths or patterns."""
    schema = {k: v for k, v in schema.items() if k not in UNPORTABLE}
    if schema.get('type') == 'object':
        required = set(schema.get('required', []))
        props = {}
        for key, value in schema.get('properties', {}).items():
            value = strict_schema(value)
            props[key] = value if key in required else _nullable(value)
        schema.update(properties=props, required=list(props), additionalProperties=False)
    elif schema.get('type') == 'array' and isinstance(schema.get('items'), dict):
        schema['items'] = strict_schema(schema['items'])
        if schema.get('minItems', 0) > 1:
            schema['minItems'] = 1
    return schema


def _nullable(schema):
    schema = dict(schema)
    kind = schema.get('type')
    if isinstance(kind, str) and kind != 'null':
        schema['type'] = [kind, 'null']
    if 'enum' in schema and None not in schema['enum']:
        schema['enum'] = [*schema['enum'], None]
    return schema


def without_nulls(value):
    """A structured answer in the shape a tool call gives: an optional field left null is simply absent."""
    if isinstance(value, dict):
        return {k: without_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [without_nulls(v) for v in value if v is not None]
    return value


def response_format(tool):
    function = tool['function']
    return {'type': 'json_schema', 'json_schema': {'name': function['name'], 'strict': True,
                                                   'schema': strict_schema(function['parameters'])}}


def _json_messages(messages):
    """The same request, saying plainly that the answer is JSON (Qwen's JSON mode needs the word in the prompt)."""
    if messages and messages[0].get('role') == 'system':
        return [{**messages[0], 'content': messages[0]['content'] + ' Answer with JSON that matches the given schema.'},
                *messages[1:]]
    return [{'role': 'system', 'content': 'Answer with JSON that matches the given schema.'}, *messages]


def _structured_client(provider, client):
    if provider != 'gloo':
        return client, ''
    endpoint = (os.environ.get('BUILDER_STRUCTURED_ENDPOINT') or DIRECT_ENDPOINT).rstrip('/')
    return client.with_options(base_url=endpoint), endpoint


def _structured_answer(response, tool):
    """The answer as a dict, or None when it is not usable JSON for this tool (so the tool call is asked instead)."""
    choice = response.choices[0]
    if getattr(choice, 'finish_reason', None) in ('length', 'content_filter'):
        return None
    content = choice.message.content
    if not isinstance(content, str) or not content.strip():
        return None
    try:
        answer = _tool_arguments(content.strip())
    except ValueError:
        return None
    if not isinstance(answer, dict):
        return None
    required = tool['function']['parameters'].get('required', [])
    for key in required:
        # A list sent as a JSON string is read as the list; one that cannot be read asks the tool call instead.
        if key in answer and not isinstance(answer[key], list) \
                and tool['function']['parameters']['properties'].get(key, {}).get('type') == 'array':
            answer[key] = builder_agents.entries(answer, key)
            if answer[key] is None:
                return None
    return without_nulls(answer) if all(key in answer for key in required) else None


def _ai_complete_impl(messages, tools, timeout=None):
    """Structured output when the model takes it (output_mode), else force the first tool. If the first configured
    provider fails, the next one (AI_FALLBACK) gets one try."""
    import openai
    from . import chat
    clients = chat.make_clients()
    if not clients:
        return None
    forced = {'type': 'function', 'function': {'name': tools[0]['function']['name']}}
    error = None
    for name, model, extra_body, client in clients[:2]:
        model = builder_model(name, model)
        if timeout is not None:  # never outlive the import that asked
            client = client.with_options(timeout=min(timeout, chat.provider_timeout(name)), max_retries=0)
        extra = {'extra_body': extra_body} if extra_body else {}
        if output_mode(name, model, tools[0]['function']['name']) == 'json_schema':
            structured, endpoint = _structured_client(name, client)
            started = _now()
            try:
                response = structured.chat.completions.create(model=model, messages=_json_messages(messages), temperature=0,
                                                              response_format=response_format(tools[0]), **extra)
                answer = _structured_answer(response, tools[0])
            except (openai.BadRequestError, openai.AuthenticationError, openai.PermissionDeniedError,
                    openai.NotFoundError, openai.UnprocessableEntityError) as refused:
                log.info('builder: %s did not take response_format json_schema (%s); using a tool call', model, refused)
                response, answer = None, None
            except Exception as failure:
                log.info('builder: %s failed (%s); trying the fallback provider if there is one', name, failure)
                builder_run.ai(model, failed=True, mode='json_schema', endpoint=endpoint, seconds=_now() - started)
                error = failure
                continue
            if answer is not None:
                builder_run.ai(model, getattr(response, 'usage', None), mode='json_schema', endpoint=endpoint,
                               seconds=_now() - started)
                return answer
            _no_json_schema.add(model)
            builder_run.ai(model, getattr(response, 'usage', None) if response is not None else None,
                           mode='json_schema_fallback', endpoint=endpoint, seconds=_now() - started)
        started = _now()
        try:
            try:
                response = client.chat.completions.create(model=model, messages=messages, tools=tools,
                                                          tool_choice=forced, temperature=0, **extra)
            except openai.BadRequestError:
                # Some endpoints and models accept tools but not a forced choice.
                response = client.chat.completions.create(model=model, messages=messages, tools=tools,
                                                          tool_choice='auto', temperature=0, **extra)
        except Exception as failure:
            log.info('builder: %s failed (%s); trying the fallback provider if there is one', name, failure)
            builder_run.ai(model, failed=True, mode='tools', seconds=_now() - started)
            error = failure
            continue
        builder_run.ai(model, getattr(response, 'usage', None), mode='tools', seconds=_now() - started)
        calls = response.choices[0].message.tool_calls or []
        return _tool_arguments(calls[0].function.arguments) if calls else None
    raise error


def _ai_available():
    try:
        from . import chat
        return bool(chat.provider_chain())
    except Exception:
        return False


_ai_complete = _ai_complete_impl if os.environ.get('BUILDER_AI', '1') != '0' else None


AI_OFFLINE_NOTE = ('The AI reader is offline right now, so only details found by plain rules (phone, email, address, '
                   'service times) were filled in. Add the rest in the questions and review.')
AI_SLOW_NOTE = ('The AI reader did not answer in time, so only details found by plain rules (phone, email, address, '
                'service times) were filled in. Add the rest in the questions and review.')
AI_MISSING_NOTE = ('No AI model is set up, so only details found by plain rules (phone, email, address, '
                   'service times) were filled in. Add the rest in the questions and review.')


def extract(sources, complete=None, deadline=None, notes=None):
    """Claims for the profile fields (see extract_all for the lists)."""
    return extract_all(sources, complete, deadline, notes)[0]


def feed_items(source):
    try:
        if 'BEGIN:VCALENDAR' in source['feed'][:2000]:
            return builder_structured.ics_events(source, source['feed'])  # recurring events expanded (builder_calendar)
        return builder_structured.feed_sermons(source, source['feed'])
    except (ET.ParseError, ValueError) as error:
        log.info('builder: skipped feed %s (%s)', source.get('url'), error)
        return []


def extract_all(sources, complete=None, deadline=None, notes=None):
    """(claims, items). The orchestrator: every page, image and file gets the info reader; pages of a known type also
    get specialist readers (builder_agents.ROUTES), at most MAX_SPECIALIST_CALLS of them. All AI work shares one
    deadline and four workers. Structured data and feeds are read by plain code."""
    claims, items = [], []
    use_ai = complete is not None or (_ai_complete is not None and _ai_available())
    deadline = deadline if deadline is not None else _now() + IMPORT_BUDGET
    readable = [s for s in sources if s.get('kind', 'page') != 'feed']
    results = [None] * len(readable)
    failed, list_failed = [], []
    if use_ai:
        tasks = [('info', source) for source in readable]
        # A home page's sections get a list reader only when no page of the site is about that list.
        covered = {name for source in readable if source.get('page_type') not in ('home', 'other')
                   for name in builder_agents.specialists_for(source)}
        tasks += [(name, source) for source in readable for name in builder_agents.specialists_for(source)
                  if source.get('page_type') not in ('home', 'other') or name not in covered][:MAX_SPECIALIST_CALLS]
        specialists = [name for name, _ in tasks if name != 'info']
        builder_run.step(f'AI is reading {len(readable)} ' + ('source' if len(readable) == 1 else 'sources')
                         + ' for church details' + (f', with {len(specialists)} specialist readers for '
                         + ', '.join(sorted({SPECIALIST_LABELS[n] for n in specialists})) if specialists else ''))

        def run(task):
            name, source = task
            if name == 'info':
                return ai_claims(source, complete, deadline, failed)
            answer, inner = {}, _completer(complete, deadline)

            def capture(messages, tools):
                answer['raw'] = inner(messages, tools)
                return answer['raw']
            found = builder_agents.run(name, source, capture, list_failed)
            builder_run.drop('it did not match its page', _specialist_drops(name, answer.get('raw'), found))
            if source['id'] not in list_failed:
                builder_run.step(f'{SPECIALIST_LABELS[name].capitalize()} reader on “{_page_name(source)}”: '
                                 + (f'{len(found)} found' if found else 'nothing to add'))
            return found

        done, _ = _parallel(tasks, run, deadline)
        results, lists = done[:len(readable)], done[len(readable):]
        skipped = sum(r is None for r in results)
        answered = len(readable) - skipped
        explained = False
        if readable and not answered and notes is not None:
            notes.append(AI_SLOW_NOTE)
            explained = True
        elif skipped and notes is not None:
            subject = '1 source was' if skipped == 1 else f'{skipped} sources were'
            notes.append(f'{subject} read without AI because it took too long.')
        if answered and failed and notes is not None:
            if len(failed) >= answered:
                notes.append(AI_OFFLINE_NOTE)
                explained = True
            else:
                subject = '1 source was' if len(failed) == 1 else f'{len(failed)} sources were'
                notes.append(f'{subject} read without AI because the AI reader returned an error.')
        unfinished = sum(r is None for r in lists) + len(list_failed)
        if unfinished and not explained and notes is not None:
            subject = '1 page' if unfinished == 1 else f'{unfinished} pages'
            notes.append(f'{subject} of events, staff, ministries or sermons could not be read in time. '
                         'Check those lists in the review.')
        for found in lists:
            items += found or []
        run_now = builder_run.current()
        removed = sum(run_now.dropped.values()) if run_now else 0
        builder_run.step(f'Checking facts… {removed} unsupported ' + ('claim' if removed == 1 else 'claims') + ' removed'
                         if removed else 'Checking facts… every fact matched a quote on its page', 'check')
    elif readable and complete is None and _ai_complete is not None and notes is not None:
        notes.append(AI_MISSING_NOTE)
    for source, result in zip(readable, results):
        claims += pattern_claims(source)
        if source.get('kind', 'page') == 'page':
            info, found = builder_structured.page_items(source)
            claims += info
            items += found
        claims += result or []
    for source in sources:
        if source.get('kind') == 'feed':
            items += feed_items(source)
    for i, claim in enumerate(claims, 1):
        claim['id'] = f'c{i}'
    return claims, items


def _specialist_drops(name, raw, kept):
    """How many items a specialist reader returned that builder_agents.check left out as unsupported (its quote,
    name or details were not on the page). Events that are already past are skipped, not counted."""
    entries = builder_agents.entries(raw, 'items')
    if entries is None:
        return 0  # an answer that could not be read is counted once by builder_agents.check
    today = builder_structured._today()
    past = 0
    if name == 'events':
        for entry in entries:
            when = entry.get('date') if isinstance(entry, dict) else ''
            try:
                past += bool(when) and not builder_structured._upcoming(when, today)
            except (TypeError, ValueError):
                pass
    return max(0, len(entries) - len(kept) - past)


SPECIALIST_LABELS = {'events': 'events', 'staff': 'staff', 'ministries': 'ministries and groups', 'sermons': 'sermons',
                     'locations': 'locations'}
METHOD_RANK = {'structured': 0, 'pattern': 1, 'ai': 2}
COLLECTION_LIMITS = {'events': 100, 'staff': 100, 'ministries': 60, 'groups': 100, 'locations': 30, 'sermons': 100}
COLLECTION_LABELS = {'events': 'Events', 'staff': 'Staff and leaders', 'ministries': 'Ministries', 'groups': 'Small groups',
                     'locations': 'Locations', 'sermons': 'Sermons'}


def _item_key(collection, value):
    name = re.sub(r'[^a-z0-9]', '', str(value.get('name') or value.get('title') or '').lower())
    if collection == 'events':
        return f"{name}|{value.get('date', '')}"
    if collection == 'sermons':
        return value.get('url') or f"{name}|{value.get('date', '')}"
    if collection == 'locations':
        return re.sub(r'[^a-z0-9]', '', str(value.get('address', '')).lower())[:24] or name
    return name


def collect(items, sources):
    """{collection: [entry]}: the same item found on several pages (or by several readers) is one entry, its fields
    taken from the most reliable reader first (structured data, then page patterns, then AI). Each entry keeps its
    evidence and starts included, except staff: a person is only included by default when two pages, or the site's
    structured data, name them, because their name and email will be public."""
    by_id = {s['id']: s for s in sources}
    grouped = {}
    for item in sorted(items, key=lambda i: METHOD_RANK.get(i['method'], 3)):
        key = _item_key(item['collection'], item['value'])
        if key.strip('|'):
            grouped.setdefault(item['collection'], {}).setdefault(key, []).append(item)
    out = {}
    for collection in builder_structured.COLLECTIONS:
        entries = []
        for found in grouped.get(collection, {}).values():
            value, evidence, seen = {}, [], set()
            for item in found:
                for field, v in item['value'].items():
                    value.setdefault(field, v)
                    if field == 'role' and isinstance(v, str) and len(v) > len(value[field]) \
                            and v.lower().startswith(value[field].lower()):
                        value[field] = v  # "Deacon of" from one reader, "Deacon of New Member Assimilation" from another
                if (item['source_id'], item['quote']) not in seen:
                    seen.add((item['source_id'], item['quote']))
                    source = by_id.get(item['source_id'], {})
                    evidence.append({'source_id': item['source_id'], 'url': source.get('url'),
                                     'title': source.get('title', ''), 'quote': item['quote'],
                                     **quote_context(source.get('text', ''), item['quote'])})
            methods = sorted({i['method'] for i in found}, key=lambda m: METHOD_RANK.get(m, 3))
            pages = {i['source_id'] for i in found}
            include = len(pages) >= 2 or 'structured' in methods if collection == 'staff' else True
            entries.append({'value': value, 'evidence': evidence[:5], 'methods': methods, 'include': include})
        if collection == 'events':
            entries.sort(key=lambda e: (e['value'].get('date') or '9999', e['value'].get('name', '').lower()))
        elif collection == 'sermons':
            entries.sort(key=lambda e: e['value'].get('date') or '', reverse=True)
        entries = entries[:COLLECTION_LIMITS[collection]]
        for n, entry in enumerate(entries, 1):
            entry['id'] = f'{collection}-{n}'
        if entries:
            out[collection] = entries
    return out


# ---------------------------------------------------------------- 3. Clarify

# "Forest Baptist Church (FBC)", "The Forest Baptist Church" and "Forest Baptist Church, Inc." are one name.
NAME_EXTRAS = re.compile(r'^\s*the\s+|\s*\([A-Za-z.&\s]{1,12}\)\s*$|,?\s+(inc|incorporated|llc)\.?\s*$', re.I)


def plain_name(value):
    """A church name without a leading "The", trailing initials in parentheses or a corporate suffix."""
    previous = None
    while previous != value:
        previous, value = value, NAME_EXTRAS.sub('', value).strip()
    return value


def _key(field, value):
    if field == 'name':
        return re.sub(r'[^a-z0-9]', '', plain_name(value).lower())
    if field == 'address':
        return re.sub(r'[^a-z0-9]', '', value.lower())[:24]
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True)
    return _normalize_space(str(value))


def _most_common(field, claims):
    counts = {}
    for claim in claims:
        value = claim['value']
        key = json.dumps(value, sort_keys=True) if isinstance(value, dict) else value
        counts.setdefault(key, [0, value])[0] += 1
    best = max(counts.values(), key=lambda pair: (pair[0], field == 'name' and pair[1] == plain_name(pair[1])))
    return best[1]


def _candidate(field, value, claims):
    return {'value': value, 'claim_ids': [c['id'] for c in claims], 'source_ids': sorted({c['source_id'] for c in claims})}


def reconcile(claims, source_count):
    """{field: {status, value, candidates}}. Plain rules, no AI:
    - email/phone/address: a value on more than half the pages that mention one is the church's (staff addresses
      on a single page, or a second campus on the locations page, are not); otherwise different values are a conflict.
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
        # Each candidate shows its most common spelling (the plainest one on a tie).
        candidates = [_candidate(field, _most_common(field, g), g) for g in groups.values()]
        candidates.sort(key=lambda c: -len(c['source_ids']))
        if field in ('email', 'phone', 'address', 'name') and len(candidates) > 1:
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
            context = {k: claim[k] for k in ('prefix', 'suffix') if claim.get(k)}
            out.append({'source_id': source['id'], 'url': source['url'], 'title': source.get('title', ''), 'quote': claim['quote'],
                        **(context or quote_context(source.get('text', ''), claim['quote']))})
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
            if field in ('phone', 'email'):
                what = f"What is your church's {label.lower()}?"
            prompt = what if not sources else f'We could not find your {label.lower()}. {what}'
            hints = info.get('hints') or []
            if hints:
                # Ministry contacts are shown as hints only: "The Men's page lists (607) 425-9569."
                prompt += ' ' + ' '.join(f"The {h['page']} page lists {h['display']}." for h in hints[:3])
            out.append({'field': field, 'kind': 'missing', 'candidates': [], 'prompt': prompt})
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


MAX_EDITS = 40


def plan_edit(session, request):
    """(operations, reply, method) for a request in plain words: the rules first, then the AI."""
    ops = builder_edit.rule_ops(request)
    method, reply = 'rules', ''
    if ops is None:
        complete = _completer(None, _now() + 25)
        if not complete or not _ai_available():
            raise HTTPException(status_code=400, detail='Tekton did not understand that. Try “Put service times above '
                                                        'ministries” or “Hide the youth ministry”.')
        ops, reply = builder_edit.ai_ops(session, request, complete, FIELD_LABELS)
        method = 'ai'
    return ops, reply, method


def apply_edit(session, ops):
    checked = [op for op in (builder_edit.check_op(session, op) for op in ops) if op]
    if not checked:
        raise ValueError('Tekton could not match that to your site. Try “Put service times above ministries” or '
                         '“Hide the youth ministry”.')
    return builder_edit.apply_ops(session, checked, apply_answer)


def undo_edit(session):
    return builder_edit.undo(session)


def provenance(session):
    """Where each fact on the preview came from (builder_edit.provenance)."""
    return builder_edit.provenance(session, {s['id']: s for s in session.get('sources', [])},
                                   {c['id']: c for c in session.get('claims', [])}, _evidence)


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
    content.update(collection_content(session.get('collections', {})))
    if session.get('site', {}).get('pages'):
        content.update(builder_site.content(session['site'], info['name']))
    layout = clean_layout(session.get('layout'))
    if layout != default_layout():
        content['site'] = {**content.get('site', {}), 'layout': layout}
    return church_content.normalize(church_content.ChurchContent(**content))


ITEM_FIELDS = {
    'events': ('name', 'date', 'time', 'when', 'location', 'description'),
    'staff': ('name', 'role', 'group', 'email', 'phone', 'bio'),
    'ministries': ('name', 'description', 'when', 'where', 'leader', 'email', 'audience'),
    'groups': ('name', 'description', 'when', 'where', 'leader', 'email', 'audience'),
    'locations': ('name', 'address', 'service_times'),
    'sermons': ('title', 'date', 'speaker', 'series', 'scripture', 'url'),
}


def _valid(model, item):
    try:
        return model(**item).model_dump(exclude_none=True)
    except Exception as error:  # pydantic.ValidationError: one bad item is left out, not the whole site
        log.info('builder: left out %s item %s (%s)', model.__name__, item.get('name') or item.get('title'), error)
        return None


def collection_content(collections, today=None):
    """Included list entries as ChurchContent sections. Dated events in the future go to the calendar; repeating
    or undated ones are event highlights. Sections with nothing included are left out, so applying a draft never
    empties a section the church already has."""
    today = (today or builder_structured._today()).isoformat()
    cc = church_content
    included = {name: [e['value'] for e in collections.get(name, []) if e.get('include')] for name in ITEM_FIELDS}
    out = {'calendar': [], 'events': [], 'groups': [], 'ministries': [], 'staff': [], 'locations': [], 'sermons': []}
    for v in included['events']:
        if v.get('date'):
            if v['date'] >= today:
                out['calendar'].append(_valid(cc.CalendarEvent, {
                    'title': v.get('name', ''), 'date': v['date'], 'time': v.get('time', '')[:100],
                    'location': v.get('location', '')[:200], 'description': v.get('description', '')[:4000]}))
        else:
            out['events'].append(_valid(cc.Highlight, {
                'name': v.get('name', ''), 'when': (v.get('when') or v.get('time', ''))[:200], 'where': v.get('location', '')[:200],
                'description': v.get('description', '')[:2000]}))
    for v in included['groups']:
        # A group has no leader field, so its leader and contact stay in its description.
        led = ' '.join(filter(None, ('Led by ' + v['leader'] if v.get('leader') else '', f"({v['email']})" if v.get('email') else '')))
        out['groups'].append(_valid(cc.Highlight, {
            'name': v.get('name', ''), 'when': v.get('when', '')[:200], 'where': v.get('where', '')[:200],
            'description': '\n'.join(filter(None, (v.get('description', ''), led + '.' if led else '')))[:2000],
            'audience': v.get('audience', '')[:100]}))
    for v in included['ministries']:
        # Where it meets and who it is for become the ministry's note.
        note = '. '.join(filter(None, (v.get('where', ''), 'For ' + v['audience'] if v.get('audience') else '')))
        out['ministries'].append(_valid(cc.Ministry, {
            'name': v.get('name', '')[:120], 'description': v.get('description', '')[:2000], 'day': v.get('when', '')[:120],
            'head': v.get('leader', '')[:120], 'email': v.get('email', '')[:200], 'note': note[:500]}))
    for v in included['staff']:
        out['staff'].append(_valid(cc.Person, {k: v.get(k, '') for k in ITEM_FIELDS['staff']}))
    for v in included['locations']:
        out['locations'].append(_valid(cc.Location, {k: v.get(k, '') for k in ITEM_FIELDS['locations']}))
    for v in included['sermons']:
        out['sermons'].append(_valid(cc.Sermon, {k: v.get(k, '') for k in ITEM_FIELDS['sermons']}))
    limits = cc.ChurchContent.model_fields
    content = {}
    for name, entries in out.items():
        entries = [e for e in entries if e]
        if entries:
            limit = next((m.max_length for m in limits[name].metadata if hasattr(m, 'max_length')), None)
            content[name] = entries[:limit] if limit else entries
    return content


SITE_PARTS = ('pages', 'links', 'forms', 'media', 'assets')


def apply_part(session, part, item_id=None, include=None, rights=None):
    """Keep or leave out a page, link, form, player or image of the site model (all of that part when item_id is
    None). `rights` is the church confirming it may use an image from the old site."""
    entries = session.get('site', {}).get(part) if part in SITE_PARTS else None
    if entries is None:
        raise ValueError('Unknown part of the site')
    targets = entries if item_id is None else [e for e in entries if e.get('id') == item_id]
    if not targets:
        raise ValueError('Unknown item')
    if rights is not None and part != 'assets':
        raise ValueError('Only images need permission.')
    for entry in targets:
        if include is not None:
            entry['include'] = bool(include)
        if rights is not None:
            entry['rights'] = bool(rights)
    return session


ADDED_EVIDENCE = {'title': 'You added this', 'url': '', 'quote': ''}


def add_removed(session, removed_id):
    """The church adds back something the fact check removed. A list item joins its list; a detail fills an empty
    field, joins an open question as another answer, or (when the field already has a different value, even one the
    church confirmed) becomes a question with both answers, so nothing is overwritten without the church choosing.
    Either way it is marked as added by the church, not as read from the page."""
    entry = next((e for e in session.get('removed') or [] if e.get('id') == removed_id), None)
    if entry is None:
        raise LookupError('Not found')
    field, value = entry['field'], entry['value']
    if entry['kind'] == 'item':
        entries = session.setdefault('collections', {}).setdefault(field, [])
        if field not in ITEM_FIELDS:
            raise ValueError('Unknown list')
        same = next((e for e in entries if _item_key(field, e['value']) == _item_key(field, value)), None)
        if same:
            same['include'] = True
        elif len(entries) >= COLLECTION_LIMITS[field]:
            raise ValueError('That list is full.')
        else:
            used = {e['id'] for e in entries}
            n = len(entries) + 1
            while f'{field}-{n}' in used:
                n += 1
            entries.append({'value': {k: v for k, v in value.items() if k in ITEM_FIELDS[field] and v not in ('', None)},
                            'evidence': [], 'methods': ['church'], 'include': True, 'id': f'{field}-{n}', 'added': True})
    elif field == 'faq':
        if '||' not in str(value):
            raise ValueError('That question has no answer.')
        q, a = (part.strip() for part in str(value).split('||', 1))
        session['claims'].append({'id': f"c{len(session['claims']) + 1}", 'field': 'faq', 'value': {'question': q, 'answer': a},
                                  'quote': '', 'source_id': '', 'method': 'church'})
    elif field in FIELD_LABELS:
        _add_detail(session, field, str(value).strip())
    else:
        raise ValueError('Unknown field')
    session['removed'] = [e for e in session['removed'] if e.get('id') != removed_id]
    session['status'] = 'clarifying' if session['questions'] else 'review'
    return session


def _add_detail(session, field, value):
    info = session['fields'].get(field) or {'status': 'missing', 'value': None, 'candidates': []}
    label = FIELD_LABELS[field]
    added = {'value': value, 'display': _show(field, value), 'evidence': [ADDED_EVIDENCE]}
    question = next((q for q in session['questions'] if q['field'] == field), None)
    if info['status'] == 'missing' or info.get('value') in (None, '') and info['status'] != 'conflict':
        session['fields'][field] = {**info, 'status': 'confirmed', 'value': value, 'added': True}
        session['questions'] = [q for q in session['questions'] if q['field'] != field]
        return
    if info['status'] == 'conflict':
        if question and not any(_key(field, c['value']) == _key(field, value) for c in question['candidates']):
            question['candidates'].append(added)
        return
    if _key(field, info['value']) == _key(field, value):
        return  # already the answer
    if info['status'] == 'confirmed':
        current = {'value': info['value'], 'display': _show(field, info['value']),
                   'evidence': [{'title': 'You confirmed this', 'url': '', 'quote': ''}]}
    else:
        by_id = {c['id']: c for c in session.get('claims', [])}
        src = {s['id']: s for s in session.get('sources', [])}
        top = (info.get('candidates') or [None])[0]
        current = {'value': info['value'], 'display': _show(field, info['value']),
                   'evidence': _evidence(top, by_id, src) if top else []}
    session['fields'][field] = {**info, 'status': 'conflict', 'value': None}
    session['questions'].append({'field': field, 'kind': 'conflict', 'candidates': [current, added],
                                 'prompt': f'You added a different answer for {label.lower()}. Which is right?'})


def apply_item(session, collection, item_id=None, include=None, value=None):
    """Include, leave out or edit a list entry (all entries of the list when item_id is None)."""
    entries = session.get('collections', {}).get(collection)
    if collection not in ITEM_FIELDS or entries is None:
        raise ValueError('Unknown list')
    targets = entries if item_id is None else [e for e in entries if e['id'] == item_id]
    if not targets:
        raise ValueError('Unknown item')
    if value is not None:
        if item_id is None or not isinstance(value, dict):
            raise ValueError('Edit one item at a time.')
        entry = targets[0]
        edited = {**entry['value'], **{k: ' '.join(str(v).split()) for k, v in value.items() if k in ITEM_FIELDS[collection] and v is not None}}
        edited = {k: v for k, v in edited.items() if v != ''}
        if not collection_content({collection: [{'value': edited, 'include': True}]}):
            raise ValueError('Check this item: it needs a name, and dates must be written as YYYY-MM-DD and not be in the past.')
        entry['value'], entry['edited'] = edited, True
    if include is not None:
        for entry in targets:
            entry['include'] = bool(include)
    return session


def new_session(url, fetch=None, complete=None, fetch_bytes=None, describe=None, fetch_feed=None, budget=None,
                crawl_budget=None, progress=None, fetch_css=None):
    """Import a website. With no injected `fetch`, robots.txt, sitemaps, feeds and stylesheets are read too (or
    with `fetch_feed`, `fetch_css`). `progress(stage, pages_read, pages_found)` reports how far it got."""
    started, notes, feeds = _now(), [], []
    deadline = started + (IMPORT_BUDGET if budget is None else budget)
    crawl_budget = CRAWL_BUDGET if crawl_budget is None else crawl_budget
    if fetch is None:
        fetch_feed = fetch_feed or _http_feed
        fetch_css = fetch_css or _http_css
    report = (lambda read, found: progress('reading', read, found)) if progress else None
    builder_run.step(f'Reading {url}')
    policy = host_policy(fetch_feed, deadline) if fetch_feed is not None else builder_crawl.HostPolicy()
    sources = crawl(url, fetch, deadline=min(deadline, started + crawl_budget), notes=notes, fetch_feed=fetch_feed,
                    feeds=feeds, progress=report, policy=policy)
    if not sources:
        raise ValueError('No pages could be read from that address.')
    if builds_in_browser(sources):
        # A Wix or Squarespace style app shell: the pages are scripts, not text. Ask the church directly instead.
        builder_run.step(JS_SITE_NOTE, 'warn')
        session = session_from_sources(url, [], complete, deadline=deadline, notes=[JS_SITE_NOTE])
        session['js_rendered'] = True
        return finish_run(session, pages=len(sources))
    if describe is not None or (_ai_describe is not None and _ai_available()):
        images = read_images(sources, fetch_bytes, describe, deadline=deadline, notes=notes, policy=policy)
        if images:
            builder_run.step(f'Looked at {len(images)} ' + ('image' if len(images) == 1 else 'images') + ' for times and events')
        sources += images
    found_feeds = read_feeds(feeds, fetch_feed, len(sources) + 1, min(deadline, _now() + 20), notes, policy)
    for feed in found_feeds:
        builder_run.step(('Read the calendar feed' if 'BEGIN:VCALENDAR' in feed.get('feed', '')[:2000] else 'Read the sermon feed')
                         + f' {urlparse(feed.get("url") or "").netloc}')
    sources += found_feeds
    look = None
    if fetch_css is not None and _now() < deadline:
        paced = polite(fetch_css, policy, min(deadline, _now() + 15))
        look = builder_theme.read(sources[0], lambda u: paced(u)[2], policy.allowed, notes)
    if progress:
        progress('extracting', len([s for s in sources if s.get('kind') == 'page']), len(sources))
    session = session_from_sources(url, sources, complete, deadline=deadline, notes=notes)
    session['site']['calendars'] = found_calendars(sources, found_feeds, policy if fetch_feed is not None else None)
    look = look or builder_theme.read(sources[0])
    session['site'].update(theme=look[0], assets=look[1])
    builder_run.step('Read the colors, fonts and logo from your site')
    return finish_run(session, pages=len([s for s in sources if s.get('kind', 'page') == 'page']))


def found_calendars(sources, feeds, policy=None):
    """The calendars the pages embed or link (builder_calendar.detect), marked 'imported' when the crawl already read
    their feed (its host allowed it). A feed robots.txt keeps the crawl away from waits for the church's say-so."""
    calendars = builder_calendar.detect(sources)
    read = {f.get('url') for f in feeds} | {f.get('requested_url') for f in feeds}
    for entry in calendars:
        if not entry['feed_url']:
            builder_run.step(f'Found your calendar, {builder_calendar.label(entry)}; it has no public feed, so it stays a link')
            continue
        if policy is not None:
            try:
                entry['robots_allowed'] = bool(policy.allowed(entry['feed_url']))
            except Exception:  # robots.txt could not be read: treat as not allowed, the church decides
                entry['robots_allowed'] = False
        if entry['feed_url'] in read:
            entry['status'] = 'imported'
            builder_run.step(f'Read the events from your calendar, {builder_calendar.label(entry)}')
        else:
            builder_run.step(f'Found your calendar, {builder_calendar.label(entry)}; Tekton will ask before importing its events')
    return calendars


def _http_calendar(url):
    """(final_url, text) of one calendar feed the church asked to import. Only addresses Tekton derived
    (builder_calendar.is_feed_url); robots.txt is not consulted for this one user-requested fetch; size is capped."""
    if not builder_calendar.is_feed_url(url):
        raise ValueError('That is not a calendar feed Tekton found.')
    _check_public(url)
    if _fetch_bridge():
        final_url, content_type, data = _bridge_fetch(url, 'calendar')
    else:
        data, hops = b'', 0
        with httpx.Client(timeout=FETCH_TIMEOUT * 2, follow_redirects=False, headers={'User-Agent': 'Tekton/0.1'}) as client:
            while True:
                with client.stream('GET', url) as response:
                    if response.is_redirect and hops < 5:
                        url, hops = urljoin(url, response.headers['location']), hops + 1
                        if not builder_calendar.is_feed_url(url):
                            raise ValueError('The calendar feed moved somewhere Tekton does not read.')
                        _check_public(url)
                        continue
                    response.raise_for_status()
                    for chunk in response.iter_bytes():
                        data += chunk
                        if len(data) > builder_calendar.MAX_FEED_BYTES:
                            break  # a long calendar is cut, not refused: the upcoming events are usually near the end
                    final_url = str(response.url)
                    break
    text = data[:builder_calendar.MAX_FEED_BYTES].decode('utf-8', errors='replace')
    if 'BEGIN:VCALENDAR' not in text[:5000]:
        raise ValueError('That calendar did not answer with a calendar feed.')
    return final_url, text


def import_calendar(session, calendar_id, fetch=None, today=None):
    """Read one found calendar's feed (the church said yes) into the events list. Returns how many were added."""
    entry = next((c for c in session.get('site', {}).get('calendars', []) if c.get('id') == calendar_id), None)
    if entry is None:
        raise ValueError('Calendar not found')
    if not entry.get('feed_url'):
        raise ValueError('This calendar has no public feed to import.')
    try:
        final_url, text = (fetch or _http_calendar)(entry['feed_url'])
    except Exception as error:
        entry['status'] = 'failed'
        raise ValueError('Tekton could not read that calendar. Check that it is public, then try again.') from error
    source = {'id': 'calendar-' + calendar_id, 'kind': 'feed', 'url': entry.get('page_url') or final_url,
              'title': builder_calendar.label(entry)}
    items = builder_calendar.events(source, text, today or builder_structured._today(),
                                    builder_structured.EVENT_HORIZON_DAYS, builder_calendar.MAX_IMPORTED,
                                    quote_name=entry.get('name') or '')
    added = add_items(session, items, [source])
    entry.update(status='imported', count=added)
    if not any(s.get('id') == source['id'] for s in session.get('sources', [])):
        session.setdefault('sources', []).append(source)
    note = f'Imported {added} upcoming ' + ('event' if added == 1 else 'events') + f' from {builder_calendar.label(entry)}.'
    session.setdefault('notes', []).append(note)
    return added


def add_items(session, items, sources):
    """Merge new list items into the draft's lists (collect's rules); an entry already there is not added twice."""
    fresh = collect(items, sources)
    collections = session.setdefault('collections', {})
    added = 0
    for name, entries in fresh.items():
        current = collections.setdefault(name, [])
        keys = {_item_key(name, e['value']) for e in current}
        for entry in entries:
            if _item_key(name, entry['value']) in keys or len(current) >= COLLECTION_LIMITS[name]:
                continue
            keys.add(_item_key(name, entry['value']))
            used = {e['id'] for e in current}
            n = len(current) + 1
            while f'{name}-{n}' in used:
                n += 1
            current.append({**entry, 'id': f'{name}-{n}'})
            added += 1
    return added


def decline_calendar(session, calendar_id):
    entry = next((c for c in session.get('site', {}).get('calendars', []) if c.get('id') == calendar_id), None)
    if entry is None:
        raise ValueError('Calendar not found')
    entry['status'] = 'declined'


JS_SITE_NOTE = ('This site builds itself in the browser, so Tekton could not read its text. '
                'Let me ask you directly instead.')
APP_SHELL_RE = re.compile(r'wix|squarespace|webflow|weebly|duda|godaddy|site ?builder|gatsby|next\.js|nuxt', re.I)


def builds_in_browser(sources):
    """True when the pages read are almost all scripts and no text: a site that only renders in a browser."""
    pages = [s for s in sources if s.get('kind', 'page') == 'page']
    if not pages:
        return False
    words = sum(len(s.get('text', '').split()) for s in pages)
    scripts = sum(s.get('scripts', 0) for s in pages)
    shell = any(APP_SHELL_RE.search(str(s.get('meta', {}).get('generator', ''))) for s in pages)
    return words < 40 * len(pages) and words < 150 and (scripts >= 3 * len(pages) or shell)


def finish_run(session, pages=0):
    """The run's last steps and summary (the file check, time, fact check, cost), saved on the draft for the review
    screen. The file check runs here, while the page texts are still at hand."""
    session['file_check'] = builder_json.check(session)
    builder_run.step(builder_json.summary(session['file_check']),
                     'done' if session['file_check']['valid'] and not session['file_check']['unsupported_count'] else 'warn')
    run = builder_run.current()
    if run is None:
        return session
    session['removed'] = list(run.removed)
    if run.modes:
        names = {'json_schema': 'as schema-checked JSON', 'tools': 'as tool calls',
                 'json_schema_fallback': 'asked again as tool calls'}
        run.step('AI answers: ' + ', '.join(f'{n} {names.get(m, m)}' for m, n in sorted(run.modes.items())))
    cost = builder_run.money(run.cost())
    run.step(f'Done: read {pages} ' + ('page' if pages == 1 else 'pages') + f' in {run.seconds():g}s'
             + (f', about {cost}' if cost and cost != 'no AI cost' else ''), 'done')
    session['run'] = run.summary(pages=pages, sources=len(session.get('sources', [])))
    return session


# Pages about one ministry, group, person or event: a phone or email found only there is that ministry's contact
# ("please contact Pete at (607) 425-9569"), not the church's.
LOCAL_CONTACT_PAGES = ('ministries', 'groups', 'staff', 'events', 'news', 'sermons')


def local_contacts(claims, sources, items):
    """(church-wide claims, {field: [hint]}). A phone or email is the church's when a home, contact, visit, about
    or other general page gives it, when it is on at least half the pages read (a header or footer), or when the
    site's structured data says so. One found only on ministry, group, staff, event, news or sermon pages is left
    out of the church's candidates: it goes to that page's ministry or group when it has none, and the question
    for the church's own number mentions it."""
    by_id = {s['id']: s for s in sources}
    pages = [s for s in sources if s.get('kind', 'page') == 'page' and s.get('url')]
    kept, local = [], {}
    for claim in claims:
        source = by_id.get(claim['source_id'], {})
        if claim['field'] in ('phone', 'email') and claim['method'] != 'structured' and source in pages \
                and source.get('page_type') in LOCAL_CONTACT_PAGES:
            local.setdefault((claim['field'], _key(claim['field'], claim['value'])), []).append(claim)
        else:
            kept.append(claim)
    general = {(c['field'], _key(c['field'], c['value'])) for c in kept if c['field'] in ('phone', 'email')}
    hints, left_out = {}, set()
    for (field, key), found in local.items():
        on = {c['source_id'] for c in found}
        if (field, key) in general or len(on) * 2 >= len(pages):
            continue  # also on a general page, or in the header or footer of most pages: the church's
        left_out.update(id(c) for c in found)
        value = found[0]['value']
        for sid in on:
            page = by_id[sid]
            hints.setdefault(field, []).append({'value': value, 'display': _show(field, value), 'page': _page_name(page),
                                                'url': page.get('url', '')})
            group = next((i for i in items if i['source_id'] == sid and i['collection'] in ('ministries', 'groups')
                          and not i['value'].get(field) and 'Contact:' not in i['value'].get('description', '')), None)
            if group and field == 'email':
                group['value']['email'] = value
            elif group:  # ministries and groups have no phone field: it goes in their description
                text = group['value'].get('description', '')
                group['value']['description'] = f"{text} Contact: {_show(field, value)}".strip()[:1000]
    return [c for c in claims if id(c) not in left_out], hints


def session_from_sources(url, sources, complete=None, deadline=None, notes=None):
    notes = notes if notes is not None else []
    claims, items = extract_all(sources, complete, deadline=deadline, notes=notes)
    by_id = {s['id']: s for s in sources}
    for claim in claims:  # while the page text is at hand: where on the page each quote sits, for source links
        claim.update(quote_context(by_id.get(claim['source_id'], {}).get('text', ''), claim['quote']))
    claims, hints = local_contacts(claims, sources, items)
    fields = reconcile(claims, len(sources))
    for field, found in hints.items():
        if fields.get(field, {}).get('status') == 'missing':
            fields[field]['hints'] = found[:5]
    qs = questions(fields, claims, sources)
    if sources:
        for q in qs:
            label = FIELD_LABELS.get(q['field'], q['field']).lower()
            builder_run.step(f'Found {len(q["candidates"])} different answers for {label}; Tekton will ask you which is right'
                             if q['kind'] == 'conflict' else f'Could not find your {label}; Tekton will ask you', 'warn')
    site = builder_site.build(sources, url or '')
    beliefs = beliefs_review(site, sources, notes)
    return {'id': secrets.token_urlsafe(18), 'created_at': datetime.now(timezone.utc).isoformat(),
            'url': url, 'status': 'clarifying' if qs else 'review',
            'sources': sources, 'claims': claims, 'fields': fields, 'questions': qs, 'notes': notes,
            'collections': collect(items, sources), 'site': site, 'beliefs': beliefs, 'layout': default_layout()}


PLACEHOLDER_RE = re.compile(r'under construction|coming soon|check back|lorem ipsum|\btbd\b|to be (?:announced|added)|'
                            r'more (?:info|information) soon|content (?:goes|coming) here', re.I)


def _placeholder(sections):
    text = ' '.join(s.get('text') or '' for s in sections)
    return bool(PLACEHOLDER_RE.search(text)) or len(text.split()) < 8


def beliefs_review(site, sources, notes):
    """The statement of faith goes back to the pastor. Tekton never writes or summarizes theology:
    - a beliefs page is kept word for word but left off the new site until the church confirms it (POST .../beliefs);
    - a beliefs section of another page (one-page sites, "#beliefs") is taken off that page and becomes its own
      beliefs page, held the same way;
    - a placeholder ("This page is under construction") or nothing at all is not imported: the pastor adds it."""
    if not sources or not any(s.get('kind', 'page') == 'page' for s in sources):
        return None
    pages = [p for p in site.get('pages', []) if is_beliefs(p)]
    held = []
    for page in site.get('pages', []):
        if page in pages or page.get('sections') is None:
            continue
        keep = [s for s in page['sections'] if not BELIEFS_RE.search(s.get('heading') or '')]
        if len(keep) != len(page['sections']):
            held += [s for s in page['sections'] if s not in keep]
            page['sections'], page['section_count'] = keep, len(keep)
    placeholder = False
    for page in list(pages):
        if page.get('sections') is not None and _placeholder(page['sections']):
            page['include'] = False
            pages.remove(page)
            placeholder = True
    if held and _placeholder(held):
        held, placeholder = [], True
    if held:
        first = next(p for p in site['pages'] if p.get('sections') is not None)
        pages.append({'id': 'beliefs', 'url': first['url'].split('#')[0] + '#beliefs', 'path': '/beliefs',
                      'title': held[0].get('heading') or 'What we believe', 'page_type': 'about', 'in_menu': False,
                      'sections': held, 'section_count': len(held), 'include': False})
        site['pages'].append(pages[-1])
    if not pages:
        if placeholder:
            builder_run.step('Your beliefs section is only a placeholder (“under construction”). Tekton does not write '
                             'theology, so it asks your pastor instead', 'warn')
            notes.append(BELIEFS_PLACEHOLDER_NOTE)
            return {'status': 'missing', 'placeholder': True}
        return {'status': 'missing'}
    for page in pages:
        page['include'] = False
    first = pages[0]
    builder_run.step(f'Found your beliefs, “{_page_name(first)}”. Tekton does not write '
                     'theology, so they go to your pastor to confirm', 'warn')
    return {'status': 'needs_pastor', 'page_ids': [p['id'] for p in pages], 'title': _page_name(first),
            'url': first.get('url', ''), 'confirmed': False}


def confirm_beliefs(session, confirmed):
    """The pastor confirmed the imported statement of faith (or took it back out)."""
    beliefs = session.get('beliefs') or {}
    if beliefs.get('status') != 'needs_pastor':
        raise ValueError('No statement of faith was imported to confirm.')
    beliefs['confirmed'] = bool(confirmed)
    for page in session.get('site', {}).get('pages', []):
        if page['id'] in beliefs['page_ids']:
            page['include'] = bool(confirmed)
    return session


# ---------------------------------------------------------------- storage and routes

DRAFT_SPACE = 'builder'
DRAFT_TTL = 24 * 60 * 60
_draft_lock = threading.RLock()


def _limit(name, default):
    try:
        return max(1, int(os.environ.get(name) or default))
    except ValueError:
        return default


# Per rolling hour. Raised for the demo, where the team and judges share one venue address and rehearse many
# imports; BUILDER_IMPORTS_PER_ADDRESS and BUILDER_IMPORTS_PER_HOUR (Worker vars) override these.
IMPORTS_PER_ADDRESS = _limit('BUILDER_IMPORTS_PER_ADDRESS', 200)
IMPORTS_PER_HOUR = _limit('BUILDER_IMPORTS_PER_HOUR', 500)


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
        self.acquire(ip)
        try:
            yield
        finally:
            self.release()

    def acquire(self, ip):
        """Count one import against the limits; every successful acquire needs one release()."""
        with self.lock:
            now = time.monotonic()
            while self.starts and self.starts[0][0] <= now - 3600:
                self.starts.popleft()
            if sum(client == ip for _, client in self.starts) >= IMPORTS_PER_ADDRESS:
                raise HTTPException(status_code=429, detail='Too many imports from this address. Try again in an hour.')
            if len(self.starts) >= IMPORTS_PER_HOUR:
                raise HTTPException(status_code=429, detail='Too many imports this hour. Please try again later.')
            if self.running >= 3:
                raise HTTPException(status_code=429, detail='Three imports are already running. Please try again shortly.')
            self.starts.append((now, ip))
            self.running += 1

    def release(self):
        with self.lock:
            self.running = max(0, self.running - 1)


import_limiter = ImportLimiter()


STORED_SOURCE_KEYS = ('id', 'kind', 'url', 'title', 'page_type')


def _page_key(draft_id, page_id=''):
    return f'draft:{draft_id}:page:{page_id}'


def _without_sections(site):
    return {**site, 'pages': [{k: v for k, v in p.items() if k != 'sections'} for p in site.get('pages', [])]}


def _save(session):
    """Store a draft and drop expired ones; a draft nobody opens again would otherwise stay forever.
    Page texts are not stored: every value keeps its quote, which is all review and evidence need. The site model's
    page sections (the recreated pages) are stored once, a row per page, when the import finishes."""
    cutoff = datetime.fromtimestamp(time.time() - DRAFT_TTL, timezone.utc).isoformat()
    stored = {**session, 'sources': [{k: s[k] for k in STORED_SOURCE_KEYS if k in s} for s in session['sources']]}
    statements = []
    if session.get('site'):
        stored['site'] = _without_sections(session['site'])
        statements = [("INSERT INTO config VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data",
                       (_page_key(session['id'], page['id']),
                        json.dumps({'created_at': session['created_at'], 'sections': page['sections']})))
                      for page in session['site'].get('pages', []) if 'sections' in page]
    with db.use_church(DRAFT_SPACE):
        db.run(("INSERT INTO config VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data",
                ('draft:' + session['id'], json.dumps(stored))), *statements,
               ("DELETE FROM config WHERE key LIKE 'draft:%' AND json_extract(data, '$.created_at') < ?", (cutoff,)))
    return session


def _delete(draft_id):
    prefix = _page_key(draft_id)
    with db.use_church(DRAFT_SPACE):
        db.run(('DELETE FROM config WHERE key = ? OR substr(key, 1, ?) = ?', ('draft:' + draft_id, len(prefix), prefix)))


def _page_sections(draft_id):
    """{page id: sections} for a stored draft."""
    prefix = _page_key(draft_id)
    with db.use_church(DRAFT_SPACE):
        rows = db.query('SELECT key, data FROM config WHERE substr(key, 1, ?) = ?', (len(prefix), prefix))
    return {row['key'][len(prefix):]: json.loads(row['data'])['sections'] for row in rows}


def _with_pages(session):
    """The draft with its pages' sections loaded, for building content."""
    if not session.get('site', {}).get('pages'):
        return session
    sections = _page_sections(session['id'])
    pages = [{**p, 'sections': sections.get(p['id'], [])} for p in session['site']['pages']]
    return {**session, 'site': {**session['site'], 'pages': pages}}


def _read(draft_id):
    with db.use_church(DRAFT_SPACE):
        row = db.one('SELECT data FROM config WHERE key = ?', ('draft:' + draft_id,))
    return json.loads(row['data']) if row else None


INTERRUPTED = 'The import was interrupted. Please try again.'


def _load(draft_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]{24}', draft_id):
        raise HTTPException(status_code=404, detail='Builder draft not found')
    draft = _read(draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail='Builder draft not found')
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(draft['created_at'])).total_seconds()
    if age >= DRAFT_TTL:
        _delete(draft_id)
        raise HTTPException(status_code=404, detail='Builder draft not found')
    if draft.get('status') == 'importing' and (not _job_alive(draft_id) or age > JOB_MAX):
        # The container restarted (or the job hung): say so instead of showing "importing" forever.
        draft = {**draft, 'status': 'failed', 'error': INTERRUPTED}
        _save(draft)
    return draft


def _ready(draft):
    """Answers, lists, previews and apply need a finished import."""
    if draft.get('status') == 'importing':
        raise HTTPException(status_code=409, detail='This draft is still being imported.')
    if draft.get('status') == 'failed':
        raise HTTPException(status_code=409, detail=draft.get('error') or 'This import failed. Please start a new one.')
    return draft


def _public(session):
    """The draft for the page, without the full page texts (the evidence quotes are enough)."""
    out = {**session, 'notes': session.get('notes', []), 'collections': session.get('collections', {}),
           'sources': [{k: s[k] for k in ('id', 'kind', 'url', 'title') if k in s} for s in session['sources']],
           # The copies kept for undo stay on the server; the page only needs to know there is something to undo.
           'undo_count': len(session.get('undo') or [])}
    out.pop('undo', None)
    out.pop('json_content', None)
    out.pop('json_sources', None)
    out.pop('json_calendars', None)
    if session.get('site'):
        out['site'] = _without_sections(session['site'])
    return out


class ImportBody(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    url: str = Field(min_length=4, max_length=500)


class AnswerBody(BaseModel):
    field: str = Field(min_length=1, max_length=40)
    value: str | list | dict


class ItemBody(BaseModel):
    collection: str = Field(min_length=1, max_length=20)
    id: str | None = Field(default=None, max_length=40)
    include: bool | None = None
    value: dict | None = None


class PartBody(BaseModel):
    part: str = Field(min_length=1, max_length=20)
    id: str | None = Field(default=None, max_length=40)
    include: bool | None = None
    rights: bool | None = None


# ---------------------------------------------------------------- background imports

_JOBS = ThreadPoolExecutor(max_workers=3, thread_name_prefix='builder-import')
_running = {}  # draft id -> Future of its import
_running_lock = threading.Lock()


def _job_alive(draft_id):
    with _running_lock:
        future = _running.get(draft_id)
    return future is not None and not future.done()


def wait_for_imports(timeout=10.0):
    """Wait for running imports (tests and shutdown)."""
    with _running_lock:
        futures = list(_running.values())
    wait(futures, timeout=timeout)


def _importing_draft(url):
    return {'id': secrets.token_urlsafe(18), 'created_at': datetime.now(timezone.utc).isoformat(), 'url': url,
            'status': 'importing', 'progress': {'stage': 'starting', 'pages_read': 0, 'pages_found': 0, 'steps': [],
                                                'checked': 0, 'seconds': 0},
            'sources': [], 'claims': [], 'fields': {}, 'questions': [], 'notes': [], 'collections': {}}


PROGRESS_EVERY = 1.0


def _run_import(draft):
    """The import job. Its steps (builder_run) are saved about every second while it reads, so the page's poll
    shows them as they happen; the finished draft replaces it."""
    run, token = builder_run.start()
    state = {'stage': 'starting', 'pages_read': 0, 'pages_found': 0}
    saved, done = [-1], threading.Event()

    def save_progress():
        if run.version == saved[0]:
            return
        saved[0] = run.version
        with _draft_lock:
            current = _read(draft['id'])
            if current and current.get('status') == 'importing':
                _save({**current, 'progress': {**state, **run.snapshot()}})

    def progress(stage, read, found):
        state.update(stage=stage, pages_read=read, pages_found=found)
        with run.lock:
            run.version += 1  # saved with the steps on the next tick

    def saver():
        while not done.wait(PROGRESS_EVERY):
            try:
                save_progress()
            except Exception:  # a missed progress save must never stop the import
                log.exception('builder: progress save failed for %s', draft['id'])

    thread = threading.Thread(target=saver, name='builder-progress', daemon=True)
    thread.start()
    try:
        try:
            session = new_session(draft['url'], budget=JOB_BUDGET, crawl_budget=JOB_BUDGET / 2, progress=progress)
            session.update(id=draft['id'], created_at=draft['created_at'])
        except ValueError as error:
            session = {**draft, 'status': 'failed', 'error': str(error)}
        except Exception:
            log.exception('builder: import %s failed', draft['id'])
            session = {**draft, 'status': 'failed', 'error': 'The import failed. Please try again.'}
        done.set()
        thread.join(timeout=5)
        with _draft_lock:
            if _read(draft['id']):  # an expired or consumed draft is not brought back
                _save(session)
    finally:
        done.set()
        builder_run.finish(token)
        import_limiter.release()


@router.post('/api/builder/drafts', status_code=202)
def import_site(body: ImportBody, request: Request):
    """Start a website import. The draft answers 'importing' until the job finishes; poll GET for the result."""
    ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
    import_limiter.acquire(ip)
    try:
        url = urldefrag(body.url.strip())[0]
        _check_public(url)
        draft = _importing_draft(url)
        with _draft_lock:
            _save(draft)
        with _running_lock:
            for done in [key for key, future in _running.items() if future.done()]:
                del _running[done]
            _running[draft['id']] = _JOBS.submit(_run_import, draft)
    except ValueError as error:
        import_limiter.release()
        raise HTTPException(status_code=400, detail=str(error)) from error
    except BaseException:
        import_limiter.release()
        raise
    return _public(draft)


@router.post('/api/builder/drafts/blank', status_code=201)
def import_blank(request: Request):
    ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
    with import_limiter.importing(ip):
        with _draft_lock:
            return _public(_save(session_from_sources(None, [])))


MAX_JSON_BYTES = 2 * 1024 * 1024


@router.post('/api/builder/drafts/json', status_code=201)
async def import_json(request: Request):
    ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
    with import_limiter.importing(ip):
        if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
            raise HTTPException(status_code=400, detail='Upload site files as JSON.')
        data = bytearray()
        try:
            async with asyncio.timeout(30):
                async for chunk in request.stream():
                    data.extend(chunk)
                    if len(data) > MAX_JSON_BYTES:
                        raise ValueError('Site files must be 2 MB or smaller in total.')
            return await run_in_threadpool(_save_json, data)
        except (ValueError, UnicodeError, RecursionError, TimeoutError) as error:
            raise HTTPException(status_code=400, detail=str(error) or 'The JSON upload took too long.') from error


def _json_constant(value):
    raise ValueError('Site files cannot contain ' + value + '.')


def _save_json(data):
    files = json.loads(data, parse_constant=_json_constant)
    content = load_content_files(files)
    json.dumps(content, allow_nan=False)  # Also rejects numbers such as 1e400 that overflow to infinity.
    if not content.get('info'):
        raise ValueError('church.json must include church info.')
    draft = _importing_draft(None)
    draft.update(status='review', import_kind='json', json_content=content, json_sources=content_sources(files),
                 json_versioned='schema_version' in files['church.json'], json_calendars=content_calendars(files),
                 fields={key: {'value': value, 'status': 'confirmed', 'evidence': []}
                         for key, value in content['info'].items()})
    with _draft_lock:
        return _public(_save(draft))


def _draft_content(draft, allow_unanswered=False):
    if draft.get('import_kind') == 'json':
        content = draft['json_content']
    else:
        content = build_content(_with_pages(draft), allow_unanswered=allow_unanswered)
    # Changes asked in the preview (builder_customize) sit on top of what was imported or loaded.
    return builder_customize.apply(content, draft.get('custom'))


def _editable(draft):
    if draft.get('import_kind') == 'json':
        raise HTTPException(status_code=409, detail='Edit the JSON files and import them again, or edit in Church setup after creating your church.')
    return draft


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
    run, token = builder_run.start()
    try:
        notes = []
        builder_run.step(f'Reading {len(files)} ' + ('file' if len(files) == 1 else 'files'))
        sources = read_files(files, deadline=deadline, notes=notes)
        return finish_run(session_from_sources(None, sources, deadline=deadline, notes=notes), pages=len(sources))
    finally:
        builder_run.finish(token)


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
        session = _ready(_load(draft_id))
        if session.get('import_kind') == 'json':
            if body.field != 'name':
                _editable(session)
            try:
                content = session['json_content']
                content = church_content.normalize(church_content.ChurchContent(**{**content, 'info': {**content['info'], 'name': body.value}}))
            except (ValueError, church_content.ContentError) as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
            session['json_content'] = content
            session['fields']['name']['value'] = content['info']['name']
            if session.get('json_sources'):
                session['json_sources']['info']['name'] = [{'title': 'You confirmed this', 'quote': content['info']['name'], 'url': '', 'prefix': '', 'suffix': ''}]
            return _public(_save(session))
        try:
            apply_answer(session, body.field, body.value)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _public(_save(session))


@router.post('/api/builder/drafts/{draft_id}/items')
def item(draft_id: str, body: ItemBody):
    """Include, leave out or edit an imported list entry (events, staff, ministries, groups, locations, sermons)."""
    with _draft_lock:
        session = _editable(_ready(_load(draft_id)))
        try:
            apply_item(session, body.collection, body.id, body.include, body.value)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _public(_save(session))


@router.post('/api/builder/drafts/{draft_id}/removed/{removed_id}/add')
def removed_add(draft_id: str, removed_id: str):
    """Add back something the fact check removed ("Add it anyway"): it is marked as added by the church."""
    with _draft_lock:
        session = _ready(_load(draft_id))
        try:
            add_removed(session, removed_id)
        except LookupError:
            raise HTTPException(status_code=404, detail='Not found') from None
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _public(_save(session))


@router.post('/api/builder/drafts/{draft_id}/parts')
def part(draft_id: str, body: PartBody):
    """Keep or leave out part of the imported site: a page, link, form, player, or (with permission) an image."""
    with _draft_lock:
        session = _editable(_ready(_load(draft_id)))
        try:
            apply_part(session, body.part, body.id, body.include, body.rights)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _public(_save(session))


@router.get('/api/builder/drafts/{draft_id}/pages/{page_id}')
def draft_page(draft_id: str, page_id: str):
    """One imported page with its sections, for review."""
    with _draft_lock:
        session = _ready(_load(draft_id))
    page = next((p for p in session.get('site', {}).get('pages', []) if p['id'] == page_id), None)
    if page is None:
        raise HTTPException(status_code=404, detail='Page not found')
    return {**page, 'sections': _page_sections(draft_id).get(page_id, [])}


def _content(draft_id):
    try:
        return _draft_content(_ready(_load(draft_id)))
    except (ValueError, church_content.ContentError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post('/api/builder/drafts/{draft_id}/preview')
def preview(draft_id: str):
    with _draft_lock:
        return {'content': _content(draft_id)}


@router.get('/api/builder/drafts/{draft_id}/site')
def site(draft_id: str):
    with _draft_lock:
        draft = _with_pages(_ready(_load(draft_id)))
        return {**church_content.public_site(_draft_content(draft, allow_unanswered=True)),
                **({'provenance': draft['json_sources']} if draft.get('json_sources') else
                   {'provenance': provenance(draft)} if draft.get('import_kind') != 'json' else {})}


draft_chat_limiter = ImportLimiter()


customize_limiter = ImportLimiter()


class CustomizeBody(BaseModel):
    request: str = Field(min_length=3, max_length=300)
    viewing: str = Field(default='', max_length=80)


@router.post('/api/builder/drafts/{draft_id}/customize')
def customize(draft_id: str, body: CustomizeBody, request: Request):
    """A change asked in plain words while looking at the preview ("Make the main color navy"), made as checked
    operations on the draft's content (builder_customize)."""
    with _draft_lock:
        draft = _with_pages(_ready(_load(draft_id)))
        if len(draft.get('custom') or []) >= builder_customize.MAX_CUSTOM:
            raise HTTPException(status_code=429, detail='This draft has had many changes. Create your church to keep editing.')
        content = _draft_content(draft, allow_unanswered=True)
        history = list(draft.get('custom_log') or [])
    ops, reply, method, asking = builder_customize.rule_ops(body.request, body.viewing), '', 'rules', False
    if ops is None:
        complete = _completer(None, _now() + 25)
        if (not complete or not _ai_available()) and builder_customize.VAGUE_COLOR_RE.fullmatch(body.request.strip()):
            return {'draft': _public(draft), 'reply': builder_customize.VAGUE_COLOR_REPLY, 'changes': [], 'refused': [],
                    'asking': True, 'method': 'rules'}
        if not complete or not _ai_available():
            raise HTTPException(status_code=400, detail='Tekton did not understand that. Try “Make the main color navy”, '
                                                        '“Put service times above ministries” or “Hide the map”.')
        ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
        try:
            with customize_limiter.importing(ip):
                ops, reply, asking = builder_customize.ai_ops(content, body.request, history, body.viewing, complete)
        except HTTPException:
            raise
        except Exception:
            log.exception('builder: customize AI call failed')
            raise HTTPException(status_code=502, detail='Tekton is unavailable right now. Please try again in a moment.')
        method = 'ai'
    stored, changes, refused = [], [], []
    for op in ops:
        try:
            op, content = builder_customize.check(content, op)
        except builder_customize.Refused as why:
            refused.append(str(why))
            continue
        stored.append(op)
        changes.append(builder_customize.describe(op))
    if not stored and not asking:
        raise HTTPException(status_code=400, detail=refused[0] if refused else (reply or 'Tekton could not match that to your site.'))
    with _draft_lock:
        draft = _ready(_load(draft_id))
        draft['custom'] = [*(draft.get('custom') or []), *stored]
        draft.setdefault('custom_steps', []).append(len(stored))
        reply = reply or ('. '.join(changes) + '.')
        draft['custom_log'] = [*(draft.get('custom_log') or []), {'request': body.request, 'reply': reply}][-10:]
        return {'draft': _public(_save(draft)), 'reply': reply, 'changes': changes, 'refused': refused,
                'asking': asking and not stored, 'method': method}


@router.post('/api/builder/drafts/{draft_id}/customize/undo')
def customize_undo(draft_id: str):
    with _draft_lock:
        draft = _ready(_load(draft_id))
        steps = draft.get('custom_steps') or []
        if not steps:
            raise HTTPException(status_code=400, detail='There is nothing to undo.')
        count = steps.pop()
        draft['custom'] = (draft.get('custom') or [])[:len(draft.get('custom') or []) - count]
        draft['custom_steps'] = steps
        return {'draft': _public(_save(draft)), 'reply': 'Undid the last change.', 'changes': []}


@router.post('/api/builder/drafts/{draft_id}/chat')
def draft_chat(draft_id: str, body: chat.ChatRequest, request: Request):
    messages = chat.recent_messages(body)
    with _draft_lock:
        draft = _with_pages(_ready(_load(draft_id)))
        content = _draft_content(draft, allow_unanswered=True)
    ip = request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
    with draft_chat_limiter.importing(ip):
        try:
            return chat.run(messages, body.session_id, source=chat.DraftContent(content))
        except Exception:
            log.exception('draft chat turn failed')
            raise HTTPException(status_code=502, detail='The assistant is unavailable right now. Please try again in a moment.')


def _file(draft_id, name):
    with _draft_lock:
        draft = _with_pages(_ready(_load(draft_id)))
        # _draft_content keeps a JSON import's loaded content and applies the church's customizations.
        content = _draft_content(draft, allow_unanswered=True)
        if draft.get('import_kind') == 'json':
            draft = {**draft, 'site': {**(draft.get('site') or {}), 'calendars': draft.get('json_calendars') or []}}
            document = builder_json.files(draft, content=content, sources=draft.get('json_sources') or {})[name]
        else:
            document = builder_json.files(draft, content=content)[name]
    # Served as a download: the church (or the team) can keep the files Tekton wrote.
    return JSONResponse(document, headers={'Content-Disposition': f'attachment; filename="{name}.json"'})


@router.get('/api/builder/drafts/{draft_id}/church.json')
def church_file(draft_id: str):
    return _file(draft_id, 'church')


@router.get('/api/builder/drafts/{draft_id}/site.json')
def site_file(draft_id: str):
    return _file(draft_id, 'site')


@router.post('/api/builder/drafts/{draft_id}/calendars/{calendar_id}/import')
def calendar_import(draft_id: str, calendar_id: str):
    """The church asked Tekton to import a calendar it found: read that one feed (an address Tekton derived, never
    one sent by the page) into the events list."""
    if not re.fullmatch(r'cal\d{1,2}', calendar_id):
        raise HTTPException(status_code=404, detail='Calendar not found')
    with _draft_lock:
        session = _ready(_load(draft_id))
    try:
        entry = next(c for c in session.get('site', {}).get('calendars', []) if c.get('id') == calendar_id)
    except StopIteration:
        raise HTTPException(status_code=404, detail='Calendar not found') from None
    try:
        final_url, text = _http_calendar(entry.get('feed_url') or '')  # outside the lock: it can take a few seconds
    except Exception as error:
        log.info('builder: calendar %s failed (%s)', entry.get('feed_url'), error)
        final_url, text = None, None
    with _draft_lock:
        session = _ready(_load(draft_id))
        try:
            if text is None:
                raise ValueError('Tekton could not read that calendar. Check that it is public, then try again.')
            import_calendar(session, calendar_id, fetch=lambda url: (final_url, text))
        except ValueError as error:
            entry = next((c for c in session.get('site', {}).get('calendars', []) if c.get('id') == calendar_id), None)
            if entry is not None:
                entry['status'] = 'failed'
                _save(session)
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _public(_save(session))


@router.post('/api/builder/drafts/{draft_id}/calendars/{calendar_id}/decline')
def calendar_decline(draft_id: str, calendar_id: str):
    with _draft_lock:
        session = _ready(_load(draft_id))
        try:
            decline_calendar(session, calendar_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return _public(_save(session))


class BeliefsBody(BaseModel):
    confirmed: bool


@router.post('/api/builder/drafts/{draft_id}/beliefs')
def beliefs(draft_id: str, body: BeliefsBody):
    """The pastor confirms the imported statement of faith (it stays off the new site until then)."""
    with _draft_lock:
        session = _editable(_ready(_load(draft_id)))
        try:
            confirm_beliefs(session, body.confirmed)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _public(_save(session))


class EditBody(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    request: str = Field(min_length=3, max_length=300)


@router.post('/api/builder/drafts/{draft_id}/edits')
def edit(draft_id: str, body: EditBody):
    """A change asked in plain words ("Put service times above ministries"), made as checked operations."""
    with _draft_lock:
        session = _editable(_ready(_load(draft_id)))
        if len(session.get('edit_log', [])) >= MAX_EDITS:
            raise HTTPException(status_code=429, detail='This draft has had many changes. Edit the details below instead.')
    # The AI call (if the rules do not understand the request) runs outside the lock; the draft is read again after.
    ops, reply, method = plan_edit(session, body.request)
    with _draft_lock:
        session = _editable(_ready(_load(draft_id)))
        try:
            changes = apply_edit(session, ops)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        session.setdefault('edit_log', []).append({'request': body.request, 'reply': reply, 'changes': changes, 'method': method})
        return {'draft': _public(_save(session)), 'reply': reply, 'changes': changes, 'method': method}


@router.post('/api/builder/drafts/{draft_id}/edits/undo')
def undo(draft_id: str):
    with _draft_lock:
        session = _editable(_ready(_load(draft_id)))
        try:
            change = undo_edit(session)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {'draft': _public(_save(session)), 'reply': f'Undid: {change}'}


@router.get('/api/builder/drafts/{draft_id}/files')
def draft_files(draft_id: str):
    with _draft_lock:
        draft = _ready(_load(draft_id))
        return {'files': content_files(_draft_content(draft, allow_unanswered=True),
                                       versioned=draft.get('json_versioned', False), sources=draft.get('json_sources'),
                                       calendars=draft.get('json_calendars'))}


@router.post('/api/builder/drafts/{draft_id}/apply')
def apply(draft_id: str):
    """The Worker requires this church's staff session. Consume the draft only after a successful write."""
    with _draft_lock:
        content = _content(draft_id)
        if db.current_church() == db.DEMO_CHURCH:
            raise HTTPException(status_code=403, detail='The demo church cannot be replaced. Sign up a church to build into.')
        existing = db.get_church_info()
        info = content['info']
        # The draft has no city or care team; keep the ones the church signed up with.
        info.update({key: info.get(key) or existing.get(key, '') for key in ('city', 'care_team')})
        info['map_query'] = info['map_query'] or info['city']
        db.replace_content(content)
        _delete(draft_id)
        return {'content': content, 'church': db.current_church()}
