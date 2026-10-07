"""Structured content the builder can read without an AI: schema.org JSON-LD, iCal and RSS feeds, sermon
video links, staff cards and dated event listings.

Everything returns plain items: {'collection', 'value', 'quote', 'source_id', 'method'}, where `collection` is one
of COLLECTIONS and `quote` is the text the item was read from (shown to the church as evidence). JSON-LD can also
add info claims (name, phone, email, address) in the same shape builder.pattern_claims uses.
"""
import json
import re
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

from .builder_crawl import _local, _xml

COLLECTIONS = ('events', 'staff', 'ministries', 'groups', 'locations', 'sermons')
MAX_FEED_ITEMS = 50
EVENT_HORIZON_DAYS = 183
MONTHS = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
MONTH_DATE_RE = re.compile(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?'
                           r'(?:,?\s+(\d{4}))?\b', re.I)
TIME_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b', re.I)
ROLE_RE = re.compile(r'\b(pastor|minister|director|coordinator|elder|deacon|administrator|manager|assistant|leader|'
                     r'secretary|bishop|priest|rector|vicar|chaplain|staff|ministry|ministries|worship|youth|children|'
                     r'student|operations|executive|treasurer|accountant|receptionist|custodian|facilities|music)\b', re.I)
NAME_RE = re.compile(r"^(?:(?i:rev|reverend|pastor|dr|mr|mrs|ms|fr|father|elder|deacon|bishop)\.?\s+)?"
                     r"[A-Z][a-zA-Z'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'’.-]+){1,3}$")
EMAIL_RE = re.compile(r'\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b')
VIDEO_RE = re.compile(r'^https?://(?:www\.|m\.)?(?:youtube\.com/(?:watch\?v=|embed/|live/)[\w-]{11}|youtu\.be/[\w-]{11}'
                      r'|vimeo\.com/(?:video/)?\d+|player\.vimeo\.com/video/\d+)', re.I)
SERMON_FEED_RE = re.compile(r'sermon|message|podcast|teaching|preach|worship', re.I)


def _today():
    """Today's date; tests replace this so dated fixtures stay upcoming."""
    return date.today()


def _item(collection, value, quote, source, method='structured'):
    value = {k: (v.strip() if isinstance(v, str) else v) for k, v in value.items() if v not in (None, '')}
    return {'collection': collection, 'value': value, 'quote': ' '.join(str(quote).split())[:500],
            'source_id': source['id'], 'method': method}


def _iso(value):
    """'YYYY-MM-DD' from an ISO date or datetime, or ''."""
    match = re.match(r'(\d{4})-(\d{2})-(\d{2})', str(value or ''))
    if not match:
        return ''
    try:
        return date(*map(int, match.groups())).isoformat()
    except ValueError:
        return ''


def _twelve(hour, minute):
    return f"{hour % 12 or 12}:{minute:02d} {'AM' if hour < 12 else 'PM'}"


def _iso_time(value):
    match = re.search(r'T(\d{2}):(\d{2})', str(value or ''))
    return _twelve(int(match.group(1)), int(match.group(2))) if match else ''


def _upcoming(iso, today):
    return bool(iso) and today <= date.fromisoformat(iso) <= today + timedelta(days=EVENT_HORIZON_DAYS)


def _text(value):
    if isinstance(value, dict):
        return value.get('name') or value.get('@id') or ''
    if isinstance(value, list):
        return ', '.join(filter(None, (_text(v) for v in value)))
    return str(value or '')


def _address(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if value.get('@type') in ('Place', 'PlaceOfWorship', 'Church') or 'address' in value:
            return _address(value.get('address')) or value.get('name', '')
        parts = [value.get('streetAddress'), value.get('addressLocality'), value.get('addressRegion')]
        return ', '.join(p.strip() for p in parts if isinstance(p, str) and p.strip())
    return ''


# ---------------------------------------------------------------- JSON-LD

def _nodes(data):
    if isinstance(data, list):
        for item in data:
            yield from _nodes(item)
    elif isinstance(data, dict):
        if '@graph' in data:
            yield from _nodes(data['@graph'])
        yield data


def _types(node):
    kind = node.get('@type', '')
    return {k.lower() for k in (kind if isinstance(kind, list) else [kind]) if isinstance(k, str)}


ORG_TYPES = {'church', 'placeofworship', 'organization', 'religiousorganization', 'localbusiness', 'catholicchurch'}


def jsonld(source, scripts, today=None):
    """(info claims, items) from the page's <script type="application/ld+json"> blocks."""
    today = today or _today()
    claims, items = [], []
    for raw in scripts[:10]:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for node in _nodes(data):
            types = _types(node)
            if types & ORG_TYPES:
                quote = f"{node.get('name', '')} {_address(node.get('address'))} {node.get('telephone', '')} {node.get('email', '')}"
                for field, value in (('name', node.get('name')), ('phone', node.get('telephone')),
                                     ('email', node.get('email')), ('address', _address(node.get('address')))):
                    if isinstance(value, str) and value.strip():
                        value = value.strip()
                        if field == 'phone':
                            value = re.sub(r'\D', '', value)[-10:]
                            if len(value) != 10:
                                continue
                        if field == 'email':
                            value = value.removeprefix('mailto:').lower()
                        claims.append({'field': field, 'value': value, 'quote': ' '.join(quote.split()),
                                       'source_id': source['id'], 'method': 'structured'})
            if 'event' in types or any(t.endswith('event') for t in types):
                iso = _iso(node.get('startDate'))
                if iso and not _upcoming(iso, today):
                    continue
                value = {'name': _text(node.get('name')), 'date': iso, 'time': _iso_time(node.get('startDate')),
                         'location': _address(node.get('location')), 'description': _text(node.get('description'))[:2000]}
                if value['name']:
                    items.append(_item('events', value, f"{value['name']} {node.get('startDate', '')}", source))
            if 'person' in types and node.get('name'):
                value = {'name': _text(node.get('name')), 'role': _text(node.get('jobTitle')),
                         'email': str(node.get('email') or '').removeprefix('mailto:'),
                         'phone': str(node.get('telephone') or ''), 'bio': _text(node.get('description'))[:2000]}
                items.append(_item('staff', value, f"{value['name']} {value['role']}", source))
            if types & {'videoobject', 'podcastepisode', 'audioobject'} and node.get('name'):
                url = node.get('url') or node.get('contentUrl') or node.get('embedUrl') or ''
                value = {'title': _text(node.get('name')), 'date': _iso(node.get('uploadDate') or node.get('datePublished')),
                         'speaker': _text(node.get('author') or node.get('actor')),
                         'url': url if str(url).startswith(('http://', 'https://')) else ''}
                items.append(_item('sermons', value, value['title'], source))
    return claims, items


# ---------------------------------------------------------------- iCal

def _unescape(value):
    return value.replace('\\n', ' ').replace('\\N', ' ').replace('\\,', ',').replace('\\;', ';').replace('\\\\', '\\')


DAY_CODES = {'SU': 'Sunday', 'MO': 'Monday', 'TU': 'Tuesday', 'WE': 'Wednesday', 'TH': 'Thursday', 'FR': 'Friday', 'SA': 'Saturday'}


def ics_events(source, text, today=None):
    """Upcoming events (within EVENT_HORIZON_DAYS) and recurring ones from an iCal feed."""
    today = today or _today()
    lines = []
    for line in text.replace('\r\n', '\n').split('\n'):
        if line[:1] in (' ', '\t') and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    items, event = [], None
    for line in lines:
        if line == 'BEGIN:VEVENT':
            event = {}
        elif line == 'END:VEVENT' and event is not None:
            item = _ics_item(source, event, today)
            if item:
                items.append(item)
            event = None
        elif event is not None and ':' in line:
            key, value = line.split(':', 1)
            event[key.split(';', 1)[0].upper()] = _unescape(value.strip())
    items.sort(key=lambda i: i['value'].get('date') or '9999')
    return items[:MAX_FEED_ITEMS]


def _ics_item(source, event, today):
    name = event.get('SUMMARY', '').strip()
    start = event.get('DTSTART', '')
    if not name or not re.match(r'\d{8}', start):
        return None
    iso = f'{start[:4]}-{start[4:6]}-{start[6:8]}'
    try:
        date.fromisoformat(iso)
    except ValueError:
        return None
    clock = _twelve(int(start[9:11]), int(start[11:13])) if re.match(r'\d{8}T\d{4}', start) else ''
    value = {'name': name, 'location': event.get('LOCATION', ''), 'description': event.get('DESCRIPTION', '')[:2000]}
    rule = event.get('RRULE', '')
    if rule:
        freq = re.search(r'FREQ=(\w+)', rule)
        days = [DAY_CODES[d[-2:]] for d in re.findall(r'[+-]?\d*(SU|MO|TU|WE|TH|FR|SA)', re.search(r'BYDAY=([\w,+-]+)', rule).group(1))] \
            if 'BYDAY=' in rule else [date.fromisoformat(iso).strftime('%A')]
        value['when'] = f"{(freq.group(1).capitalize() if freq else 'Repeats')} on {', '.join(days)}" + (f' at {clock}' if clock else '')
    elif _upcoming(iso, today):
        value.update(date=iso, time=clock)
    else:
        return None
    return _item('events', value, f'{name} {start}', source)


# ---------------------------------------------------------------- RSS, Atom and podcasts

def _child(node, name):
    return next((c for c in node if _local(c.tag) == name), None)


def _child_text(node, *names):
    for name in names:
        child = _child(node, name)
        if child is not None and (child.text or '').strip():
            return child.text.strip()
    return ''


def feed_sermons(source, text):
    """Sermons from a podcast or sermon RSS/Atom feed. A blog feed (no audio or video, no sermon words) adds nothing."""
    root = _xml(text)
    channel = _child(root, 'channel') if _local(root.tag) == 'rss' else root
    if channel is None:
        return []
    title = _child_text(channel, 'title')
    entries = [c for c in channel if _local(c.tag) in ('item', 'entry')][:MAX_FEED_ITEMS]
    media = any(_child(e, 'enclosure') is not None or _child(e, 'duration') is not None for e in entries)
    if not media and not SERMON_FEED_RE.search(title + ' ' + (source.get('url') or '')):
        return []
    items = []
    for entry in entries:
        name = _child_text(entry, 'title')
        if not name:
            continue
        link = _child_text(entry, 'link')
        if not link:
            node = _child(entry, 'link')
            link = node.get('href', '') if node is not None else ''
        published = _child_text(entry, 'pubdate', 'published', 'updated')
        iso = _iso(published)
        if not iso and published:
            try:
                iso = parsedate_to_datetime(published).date().isoformat()
            except (TypeError, ValueError):
                iso = ''
        author = _child_text(entry, 'author', 'creator')
        node = _child(entry, 'author')
        if node is not None and not author:
            author = _child_text(node, 'name')
        value = {'title': name, 'date': iso, 'speaker': author, 'series': '',
                 'url': canonical_video(link) if link.startswith(('http://', 'https://')) else ''}
        items.append(_item('sermons', value, f'{name} {published}', source))
    return items


# ---------------------------------------------------------------- page patterns

VIDEO_ID_RE = re.compile(r'(?:youtube\.com/(?:watch\?v=|embed/|live/)|youtu\.be/)([\w-]{11})', re.I)


def canonical_video(url):
    """One address per YouTube video, whether it was linked, shared or embedded."""
    match = VIDEO_ID_RE.search(url or '')
    return f'https://www.youtube.com/watch?v={match.group(1)}' if match else url


def video_sermons(source, anchors, embeds):
    """Sermon videos linked or embedded on a sermons page."""
    items, seen = [], set()
    for url, label in [(href, text) for href, text, _ in anchors] + [(src, title) for src, title in embeds]:
        if not VIDEO_RE.match(url or '') or canonical_video(url) in seen:
            continue
        url = canonical_video(url)
        seen.add(url)
        title = ' '.join((label or '').split())
        if len(title) < 3 or title.lower() in ('watch', 'play', 'youtube', 'vimeo', 'watch now', 'listen'):
            continue
        items.append(_item('sermons', {'title': title[:200], 'url': url}, title, source, method='pattern'))
    return items


# A heading over a plain list of names: "Elders", "Our Deacons", "Board of Trustees".
GROUP_RE = re.compile(r'^(?:our\s+|the\s+|board\s+of\s+)?(elders|deacons|deaconesses|trustees|church\s+council|'
                      r'council|elder\s+board|deacon\s+board)(?:\s*(?:&|and)\s+[a-z ]{3,20})?:?$', re.I)
GROUP_ROLES = {'elders': 'Elder', 'deacons': 'Deacon', 'deaconesses': 'Deaconess', 'trustees': 'Trustee',
               'elder board': 'Elder', 'deacon board': 'Deacon'}
# A role that goes on to the next line: "Executive Director of" / "Operations".
WRAPPED_ROLE = re.compile(r'(?:\b(?:of|and|for|the|to)|[&,/–-])$', re.I)


def _person(line):
    return bool(NAME_RE.match(line)) and (not ROLE_RE.search(line)
                                         or bool(re.match(r'(?i)(rev|pastor|dr|father|elder|deacon|bishop)\b', line)))


def staff_cards(source):
    """Name, role (possibly wrapped onto a second line) and optional email on consecutive lines: the usual staff
    card. Also plain lists of names under an "Elders" or "Deacons" heading. Menu links are not people."""
    menu = {text for _, text, in_nav in source.get('anchors', []) if in_nav}
    lines = [line.strip() for line in source['text'].split('\n') if line.strip() and line.strip() not in menu]

    def role_at(i):
        """(role, lines used) for a role starting at line i, or ('', 0)."""
        if i >= len(lines):
            return '', 0
        role = lines[i]
        if len(role) > 60 or not ROLE_RE.search(role) or EMAIL_RE.search(role):
            return '', 0
        if WRAPPED_ROLE.search(role) and i + 1 < len(lines) and len(role) + len(lines[i + 1]) <= 90 \
                and not EMAIL_RE.search(lines[i + 1]) and not _person(lines[i + 1]):
            return f'{role} {lines[i + 1]}', 2
        return role, 1

    items, i = [], 0
    while i < len(lines):
        line = lines[i]
        heading = GROUP_RE.match(line)
        if heading:
            group, j = ' '.join(line.rstrip(':').split()), i + 1
            role = GROUP_ROLES.get(' '.join(heading.group(1).lower().split()), '')
            members = []
            while j < len(lines) and _person(lines[j]) and not role_at(j + 1)[0]:
                members.append(lines[j])
                j += 1
            if len(members) >= 2:
                quote = ' '.join([line, *members])
                for name in members:
                    items.append(_item('staff', {'name': name, 'role': role, 'group': group}, quote, source,
                                       method='pattern'))
                i = j
                continue
        role, used = role_at(i + 1) if _person(line) else ('', 0)
        if not role:
            i += 1
            continue
        nxt = i + 1 + used
        email = EMAIL_RE.search(lines[nxt]) if nxt < len(lines) else None
        value = {'name': line, 'role': role, 'email': email.group(0).lower() if email else ''}
        quote = ' '.join(lines[i:nxt + (1 if email else 0)])
        items.append(_item('staff', value, quote, source, method='pattern'))
        i = nxt + (1 if email else 0)
    return items


def dated_events(source, today=None):
    """Event listings: a title line followed by a line with a calendar date ("Saturday, October 24, 2026 · 5:30 PM")."""
    today = today or _today()
    lines = [line.strip() for line in source['text'].split('\n') if line.strip()]
    items = []
    for i, line in enumerate(lines):
        match = MONTH_DATE_RE.search(line)
        if not match or i == 0:
            continue
        title = lines[i - 1]
        if len(title) > 80 or MONTH_DATE_RE.search(title) or TIME_RE.search(title) or title.endswith(('.', ':')):
            continue
        month = MONTHS.index(match.group(1)[:3].lower()) + 1
        year = int(match.group(3)) if match.group(3) else today.year
        try:
            when = date(year, month, int(match.group(2)))
        except ValueError:
            continue
        if not match.group(3) and when < today:
            when = date(year + 1, month, int(match.group(2)))
        if not _upcoming(when.isoformat(), today):
            continue
        clock = TIME_RE.search(line)
        hour = int(clock.group(1)) % 12 + (12 if clock and clock.group(3).lower() == 'p' else 0) if clock else 0
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        where = nxt if nxt and len(nxt) <= 60 and not MONTH_DATE_RE.search(nxt) and not nxt.endswith('.') else ''
        value = {'name': title, 'date': when.isoformat(), 'time': _twelve(hour, int(clock.group(2) or 0)) if clock else '',
                 'location': where}
        items.append(_item('events', value, f'{title} {line}', source, method='pattern'))
    return items


STREET_RE = re.compile(r'^\d{1,6}\s+(?:[A-Z][\w.\'-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|'
                       r'Way|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Circle|Terrace)\b')


def location_cards(source):
    """On a locations page: a campus name, then its street address, then (optionally) its service times."""
    menu = {text for _, text, in_nav in source.get('anchors', []) if in_nav}
    lines = [line.strip() for line in source['text'].split('\n') if line.strip() and line.strip() not in menu]
    items = []
    for i, line in enumerate(lines[1:], 1):
        name = lines[i - 1]
        if not STREET_RE.match(line) or len(name) > 60 or STREET_RE.match(name) or TIME_RE.search(name):
            continue
        times = lines[i + 1] if i + 1 < len(lines) and TIME_RE.search(lines[i + 1]) and len(lines[i + 1]) <= 120 else ''
        value = {'name': name, 'address': line, 'service_times': times}
        items.append(_item('locations', value, ' '.join(filter(None, (name, line, times))), source, method='pattern'))
    return items


def page_items(source, today=None):
    """(info claims, items) for one crawled page."""
    claims, items = jsonld(source, source.get('jsonld', []), today)
    kind = source.get('page_type')
    if kind == 'sermons':
        items += video_sermons(source, source.get('anchors', []), source.get('embeds', []))
    if kind not in ('home', 'events'):
        items += staff_cards(source)
    if kind == 'events':
        items += dated_events(source, today)
    if kind == 'locations':
        items += location_cards(source)
    return claims, items


def is_video(url):
    return bool(VIDEO_RE.match(url or ''))


def same_host(url, origin):
    return urlparse(url).netloc.lower().removeprefix('www.') == origin.lower().removeprefix('www.')
