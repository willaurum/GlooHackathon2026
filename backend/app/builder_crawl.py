"""Where the builder looks: robots.txt, sitemaps, link scoring and page types.

The builder reads a few dozen pages of a site that may have hundreds, so it reads the useful ones first:
staff, events, ministries, groups, sermons, locations and visit pages, then about and contact pages, and only
a few blog or news posts. Everything here is plain code; nothing is decided by an AI.
"""
import re
import threading
import time
import xml.etree.ElementTree as ET
from urllib.parse import unquote, urldefrag, urljoin, urlparse

USER_AGENT = 'Tekton'
MAX_SITEMAPS = 5
MAX_SITEMAP_URLS = 2000
MAX_POSTS = 3

# Page types, most specific first. A page's type is the first that matches its address, then its title.
PAGE_TYPES = (
    ('news', r'announcements?|news|bulletins?|weekly|this-?week|e-?news|newsletters?|whats-?happening'),
    ('connect', r'connect|next-?steps?|get-?(involved|connected)|forms?|register|registration|sign-?ups?|prayer-?requests?'),
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
WEIGHTS = {'news': 7, 'connect': 6, 'staff': 9, 'events': 9, 'ministries': 8, 'groups': 8, 'sermons': 8, 'locations': 8, 'visit': 9,
           'about': 6, 'contact': 6, 'give': 1}
# Blog, news and archive pages: a few are read (they can mention service changes), most are noise.
POST_RE = re.compile(r'/(blog|news|posts?|articles?|stories|updates)/.+|/\d{4}/\d{2}/', re.I)
SKIP_RE = re.compile(r'/wp-(admin|login|json)|/(login|logout|signin|sign-in|account|cart|checkout|search|tag|tags|'
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

MAX_CRAWL_DELAY = 10.0


class Robots:
    """robots.txt rules for our user agent (RFC 9309). The group naming Tekton applies, else the '*' group;
    rules use '*' and '$' wildcards, the longest matching rule wins and Allow wins a tie. `Crawl-delay` is read
    from the same group. With no robots.txt (missing or 4xx), everything is allowed; `Robots.unreachable()`
    (a 5xx or network error) disallows everything, as RFC 9309 requires."""

    def __init__(self, text='', disallow_all=False):
        self.rules, self.delay, self.sitemaps, self.disallow_all = [], 0.0, [], disallow_all
        groups, current, in_agents = [], None, False
        for raw in (text or '').splitlines()[:5000]:
            line = raw.split('#', 1)[0].strip()
            if ':' not in line:
                continue
            key, value = (part.strip() for part in line.split(':', 1))
            key = key.lower()
            if key == 'sitemap':
                if value:
                    self.sitemaps.append(value)
            elif key == 'user-agent':
                if not in_agents:
                    current = {'agents': [], 'rules': [], 'delay': None}
                    groups.append(current)
                current['agents'].append(value.lower())
                in_agents = True
            elif current is not None:
                in_agents = False
                if key in ('allow', 'disallow') and value:
                    current['rules'].append((key == 'allow', value))
                elif key == 'crawl-delay':
                    try:
                        current['delay'] = float(value)
                    except ValueError:
                        pass
        token = USER_AGENT.lower()
        mine = [g for g in groups if any(a != '*' and token.startswith(a) for a in g['agents'])]
        chosen = mine or [g for g in groups if '*' in g['agents']]
        for group in chosen:
            self.rules += [(allow, pattern, _pattern(pattern)) for allow, pattern in group['rules']]
            if group['delay'] is not None:
                self.delay = max(self.delay, group['delay'])
        self.delay = max(0.0, min(self.delay, MAX_CRAWL_DELAY))

    @classmethod
    def unreachable(cls):
        return cls(disallow_all=True)

    def allowed(self, url):
        parsed = urlparse(url)
        path = unquote(parsed.path or '/') + ('?' + unquote(parsed.query) if parsed.query else '')
        if path == '/robots.txt':
            return True
        if self.disallow_all:
            return False
        best = None  # (pattern length, allow)
        for allow, pattern, regex in self.rules:
            if regex.match(path):
                key = (len(pattern), allow)
                if best is None or key > best:
                    best = key
        return True if best is None else best[1]

    def crawl_delay(self):
        return self.delay


def _pattern(pattern):
    """A robots.txt path pattern as a regex: '*' is any run of characters, a final '$' anchors the end."""
    anchored = pattern.endswith('$')
    body = unquote(pattern[:-1] if anchored else pattern)
    return re.compile(''.join('.*' if ch == '*' else re.escape(ch) for ch in body) + ('$' if anchored else ''), re.S)


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


def robots_status(error):
    """The HTTP status a failed robots.txt fetch stands for: 404 when it is missing or not a text file,
    the status the server answered, or None for a network error or timeout."""
    status = getattr(getattr(error, 'response', None), 'status_code', None)
    if status:
        return status
    if isinstance(error, FileNotFoundError):
        return 404
    message = str(error)
    answered = re.search(r'answered (\d{3})', message)
    if answered:
        return int(answered.group(1))
    if re.search(r'not a feed|not a web page|private network|could not be found', message, re.I):
        return 404
    return None


def robots_from(result):
    """Robots for one robots.txt fetch result: ('ok', (url, type, text)), ('error', exception) or None (no time).
    A missing file (4xx) allows everything; a server error, network error or timeout allows nothing (RFC 9309)."""
    if result and result[0] == 'ok':
        content_type, text = result[1][1] or '', result[1][2]
        return Robots('' if 'html' in content_type.lower() else text)
    if result and (robots_status(result[1]) or 500) < 500:
        return Robots()
    return Robots.unreachable()


def discover(start_url, robots, fetch_feed, run):
    """Page urls from a site's sitemaps (robots.txt `Sitemap:` lines, else /sitemap.xml). `run(urls, fetch)` fetches
    within the import's budget and returns one ('ok', value), ('error', exception) or None (out of time) per url."""
    parsed = urlparse(start_url)
    root = f'{parsed.scheme}://{parsed.netloc}'
    queue = [s for s in robots.sitemaps if same_site(s, parsed.netloc)] or [root + '/sitemap.xml']
    seen, pages = set(), []
    while queue and len(seen) < MAX_SITEMAPS:
        take, queue = queue[:MAX_SITEMAPS - len(seen)], queue[MAX_SITEMAPS - len(seen):]
        batch = [u for u in take if u not in seen and robots.allowed(u)]
        seen.update(take)
        if not batch:
            continue
        for result in run(batch, fetch_feed):
            if not result or result[0] != 'ok':
                continue
            try:
                found, nested = sitemap_urls(result[1][2])
            except (ET.ParseError, ValueError):
                continue
            # Sitemaps often still list http:// addresses for an https site: read them as the site serves them.
            pages += [clean(u.replace('http://', 'https://', 1) if parsed.scheme == 'https'
                            and urlparse(u).scheme == 'http' else u) for u in found if same_site(u, parsed.netloc)]
            queue += [u for u in nested if same_site(u, parsed.netloc) and u not in seen]
    return list(dict.fromkeys(pages))[:MAX_SITEMAP_URLS]


class HostPolicy:
    """Every fetch the builder makes asks this first: is the address allowed by its host's robots.txt, and when may
    it be fetched (Crawl-delay, per host)? robots.txt is fetched once per host with `fetch_feed`; without one
    (tests that inject only a page fetcher) every address is allowed and nothing waits."""

    def __init__(self, fetch_feed=None, run=None, now=None, sleep=None):
        self.fetch_feed, self.run = fetch_feed, run
        self.now, self.sleep = now or time.monotonic, sleep or time.sleep
        self.robots, self.slots, self.lock = {}, {}, threading.Lock()

    @staticmethod
    def host(url):
        return urlparse(url).netloc.lower()

    def rules(self, url):
        host = self.host(url)
        with self.lock:
            known = self.robots.get(host)
        if known is None:
            if self.fetch_feed is None or self.run is None:
                known = Robots()
            else:
                parsed = urlparse(url)
                known = robots_from(self.run([f'{parsed.scheme}://{parsed.netloc}/robots.txt'], self.fetch_feed)[0])
            with self.lock:
                known = self.robots.setdefault(host, known)
        return known

    def allowed(self, url):
        return self.rules(url).allowed(url)

    def delay(self, url):
        return self.rules(url).crawl_delay()

    def wait(self, url, deadline):
        """Hold until this host may be fetched again. False (and no wait) when that would pass the deadline."""
        delay = self.delay(url)
        if not delay:
            return True
        host = self.host(url)
        with self.lock:
            now = self.now()
            slot = max(now, self.slots.get(host, now))
            if slot > deadline:
                return False
            self.slots[host] = slot + delay
        if slot > now:
            self.sleep(slot - now)
        return True
