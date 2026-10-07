"""Where the builder looks: robots.txt, sitemaps, link scoring and page types.

The builder reads a few dozen pages of a site that may have hundreds, so it reads the useful ones first:
staff, events, ministries, groups, sermons, locations and visit pages, then about and contact pages, and only
a few blog or news posts. Everything here is plain code; nothing is decided by an AI.
"""
import re
import xml.etree.ElementTree as ET
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.robotparser import RobotFileParser

USER_AGENT = 'TektonBuilder'
MAX_SITEMAPS = 5
MAX_SITEMAP_URLS = 2000
MAX_POSTS = 3

# Page types, most specific first. A page's type is the first that matches its address, then its title.
PAGE_TYPES = (
    ('staff', r'staff|team|leadership|leaders|pastors?|elders|deacons|our-?people|directory|meet-?(the|our)'),
    ('events', r'events?|calendar|happenings|upcoming|whats-?on'),
    ('sermons', r'sermons?|messages?|watch|media|podcasts?|teachings?|listen|livestream|series'),
    ('groups', r'groups?|small-?groups?|life-?groups?|community-?groups?|bible-?stud(y|ies)|classes'),
    ('ministries', r'ministr(y|ies)|serve|serving|volunteer|outreach|missions?|kids|children|nursery|youth|students?'
                   r'|women|men|seniors|young-?adults|care'),
    ('locations', r'locations?|campus(es)?|directions|find-?us|maps?'),
    ('visit', r'plan-?(a|your)-?visit|im-?new|new-?here|visit|first-?time|what-?to-?expect|service-?times|sundays?|worship'),
    ('about', r'about|who-?we-?are|beliefs?|what-?we-?believe|our-?story|history|mission|vision'),
    ('contact', r'contact|get-?in-?touch'),
    ('give', r'give|giving|donate|tithe'),
)
_TYPE_RE = [(name, re.compile(rf'(?<![a-z]){pattern}(?![a-z])', re.I)) for name, pattern in PAGE_TYPES]
WEIGHTS = {'staff': 9, 'events': 9, 'ministries': 8, 'groups': 8, 'sermons': 8, 'locations': 8, 'visit': 9,
           'about': 6, 'contact': 6, 'give': 1}
# Blog, news and archive pages: a few are read (they can mention service changes), most are noise.
POST_RE = re.compile(r'/(blog|news|posts?|articles?|stories|updates)/.+|/\d{4}/\d{2}/', re.I)
SKIP_RE = re.compile(r'/(wp-admin|wp-login|wp-json|login|logout|signin|sign-in|account|cart|checkout|search|tag|tags|'
                     r'category|categories|author|feed|comments?|print|share)(/|$)|/page/\d+|[?&](replytocom|share|print|'
                     r'sort|filter|s)=', re.I)
FILE_RE = re.compile(r'\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp3|mp4|mov|ics|xml|rss|css|js)$', re.I)
FEED_RE = re.compile(r'\.ics$|^webcal:|/feed/?$|\.rss$|/rss/?$|podcast.*\.xml$|feeds?\.[a-z.]+/|/calendar\.ics', re.I)


def site_key(netloc):
    """www.church.org and church.org are one site."""
    host = netloc.lower()
    return host[4:] if host.startswith('www.') else host


def same_site(url, origin):
    parsed = urlparse(url)
    return parsed.scheme in ('http', 'https') and site_key(parsed.netloc) == site_key(origin)


def clean(url, base=None):
    url = urljoin(base, url) if base else url
    return urldefrag(url.strip())[0]


def page_type(url, title=''):
    path = urlparse(url).path.strip('/')
    if not path or re.fullmatch(r'(index|home|default)(\.\w+)?', path, re.I):
        return 'home'
    words = re.sub(r'[_/.]+', '-', path)
    for name, pattern in _TYPE_RE:
        if pattern.search(words):
            return name
    for name, pattern in _TYPE_RE:
        if pattern.search(re.sub(r'\s+', '-', title or '')):
            return name
    return 'other'


def is_post(url):
    return bool(POST_RE.search(urlparse(url).path))


def skippable(url):
    return bool(SKIP_RE.search(url) or FILE_RE.search(urlparse(url).path))


def score(url, anchor='', in_nav=False):
    """Higher is read sooner. Kind pages beat posts, navigation links beat links in body text."""
    kind = page_type(url, anchor)
    value = WEIGHTS.get(kind, 2)
    if kind == 'other' and anchor:
        anchor_kind = page_type('/' + re.sub(r'\s+', '-', anchor.strip().lower()))
        value = max(value, WEIGHTS.get(anchor_kind, 2) - 1)
    if in_nav:
        value += 4
    if is_post(url):
        value -= 8
    depth = len([part for part in urlparse(url).path.split('/') if part])
    value -= max(0, depth - 2)
    if urlparse(url).query:
        value -= 3
    return value


def is_feed(url):
    return bool(FEED_RE.search(url))


def feed_url(url):
    return 'https://' + url[len('webcal://'):] if url.lower().startswith('webcal://') else url


# ---------------------------------------------------------------- robots.txt and sitemaps

class Robots:
    """robots.txt rules for our user agent. With no robots.txt, everything is allowed."""

    def __init__(self, text=''):
        self.parser = RobotFileParser()
        self.parser.parse((text or '').splitlines())
        self.sitemaps = [line.split(':', 1)[1].strip() for line in (text or '').splitlines()
                         if line.lower().startswith('sitemap:') and ':' in line]

    def allowed(self, url):
        try:
            return self.parser.can_fetch(USER_AGENT, url)
        except Exception:
            return True


def _xml(text):
    """Parse a sitemap or feed. Documents with DTDs or entities are refused (no entity expansion)."""
    head = text[:4096].upper()
    if '<!DOCTYPE' in head or '<!ENTITY' in text.upper():
        raise ValueError('XML with a DTD is not read')
    return ET.fromstring(text.encode('utf-8') if isinstance(text, str) else text)


def _local(tag):
    return tag.rsplit('}', 1)[-1].lower()


def sitemap_urls(text):
    """(page urls, nested sitemap urls) from a sitemap or sitemap index."""
    root = _xml(text)
    pages, nested = [], []
    for item in root:
        loc = next((child.text.strip() for child in item if _local(child.tag) == 'loc' and child.text), None)
        if not loc:
            continue
        (nested if _local(root.tag) == 'sitemapindex' else pages).append(loc)
    return pages[:MAX_SITEMAP_URLS], nested[:MAX_SITEMAPS]


def discover(start_url, fetch_feed, run):
    """robots.txt and sitemap pages for a site. `run(urls, fetch) -> results` fetches within the import's budget
    (None for a skipped or failed fetch). Returns (Robots, [page urls])."""
    parsed = urlparse(start_url)
    root = f'{parsed.scheme}://{parsed.netloc}'
    robots_text = run([root + '/robots.txt'], fetch_feed)[0]
    robots = Robots(robots_text[2] if robots_text and 'html' not in (robots_text[1] or '').lower() else '')
    queue = [s for s in robots.sitemaps if same_site(s, parsed.netloc)] or [root + '/sitemap.xml']
    seen, pages = set(), []
    while queue and len(seen) < MAX_SITEMAPS:
        batch = [u for u in queue[:MAX_SITEMAPS - len(seen)] if u not in seen]
        queue = queue[len(batch):]
        seen.update(batch)
        for result in run(batch, fetch_feed):
            if not result:
                continue
            try:
                found, nested = sitemap_urls(result[2])
            except (ET.ParseError, ValueError):
                continue
            pages += [clean(u) for u in found if same_site(u, parsed.netloc)]
            queue += [u for u in nested if same_site(u, parsed.netloc) and u not in seen]
    return robots, list(dict.fromkeys(pages))[:MAX_SITEMAP_URLS]
