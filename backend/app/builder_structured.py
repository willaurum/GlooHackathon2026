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
MONTH_DATE_RE = re.compile(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th|h)?'
                           r'(?:,?\s+(\d{4}))?\b', re.I)
WEEKDAY_RE = re.compile(r'\b(mon|tue|wed|thu|fri|sat|sun)(?:day|s|nes|rs|ur|urday)?[a-z]*\b\.?', re.I)
WEEKDAYS = ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')


def infer_date(month, day, text, today, year=None):
    """The date for "October 25" as of `today`: a stated year is used as is; otherwise this year, or next year once
    it has passed. When `text` names a weekday ("Sunday, October 25"), the year must agree with it (this year or
    the next two), and a date no year agrees with is None: better no date than a wrong one."""
    try:
        if year:
            return date(year, month, day)
        date(2000, month, day)  # a real day of the year (29 February included)
    except ValueError:
        return None
    weekday = WEEKDAY_RE.search(text or '')
    wanted = WEEKDAYS.index(weekday.group(1).lower()) if weekday else None
    for y in (today.year, today.year + 1, today.year + 2):
        try:
            when = date(y, month, day)
        except ValueError:
            continue
        if when >= today and (wanted is None or when.weekday() == wanted):
            return when
    return None
TIME_RE = re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b', re.I)
ROLE_RE = re.compile(r'\b(pastor|minister|director|coordinator|elder|deacon|administrator|manager|assistant|leader|'
                     r'secretary|bishop|priest|rector|vicar|chaplain|staff|ministry|ministries|worship|youth|children|'
                     r'student|operations|executive|treasurer|accountant|receptionist|custodian|facilities|music)\b', re.I)
# A person's role names what they do. "Student Missions" under "World Changers" is a ministry, not a person in a role.
# Singular, like ROLE_RE: "Deacons" on its own line is a heading over a list of names, not someone's role.
ROLE_NOUN_RE = re.compile(r'\b(pastor|minister|director|coordinator|elder|deacon|deaconess|administrator|manager|assistant|'
                          r'leader|secretary|bishop|priest|rector|vicar|chaplain|treasurer|accountant|receptionist|'
                          r'custodian|chair|chairman|chairwoman|chairperson|president|trustee|intern|teacher|staff)\b', re.I)
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

def ics_events(source, text, today=None):
    """Upcoming events (within EVENT_HORIZON_DAYS) and recurring ones from an iCal feed, recurrences expanded
    (builder_calendar.events)."""
    from . import builder_calendar
    return builder_calendar.events(source, text, today or _today(), EVENT_HORIZON_DAYS, MAX_FEED_ITEMS)


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


# Capitalized lines that are headings or places, not people ("Service Times", "Harvest Point Church").
NOT_NAME_RE = re.compile(r'\b(church|chapel|parish|fellowship|campus|times?|services?|ministr(y|ies)|team|welcome|about|'
                         r'contact|events?|sermons?|groups?|our|the|of|and|for|worship|staff|elders|deacons|kids|youth|'
                         r'students?|visit|give|giving|road|street|avenue|sundays?|mondays?|tuesdays?|wednesdays?|'
                         r'thursdays?|fridays?|saturdays?|what|we|us|believe|beliefs|home|bulletin|news|calendar|'
                         r'announcements?|prayer|history|story|mission|vision|faith|hymns?|prelude|postlude|benediction|'
                         r'doxology|offertory|scripture|reading|message|blessings)\b', re.I)
# Lines of an order of worship ("Call to Worship", "Hymn of Response") sit next to the names that lead them; they are
# not those people's roles. A bare section word ("Ministries") is a menu or heading, not a role either.
LITURGY_RE = re.compile(r'\b(call to worship|prelude|postlude|hymns?|benediction|doxology|offertory|offering|scripture|'
                        r'reading|message|sermon|invocation|response|announcements|welcome|communion|anthem|choir|'
                        r'responsive|confession|assurance|creed|lord\W?s prayer|passing of the peace)\b', re.I)
BARE_ROLE_RE = re.compile(r'(ministry|ministries|worship|youth|children|music|staff|students?|leaders?|leadership)', re.I)
# A letter's sign-off ("Blessings,", "In Christ,") followed by a titled name: the person who wrote it, in that role.
SIGN_OFF_RE = re.compile(r'^(blessings|in christ|in him|sincerely|grace and peace|grace & peace|peace|love|with love|'
                         r'yours in christ|your pastor|warmly|in his service|serving together)\W*$', re.I)
TITLED_RE = re.compile(r'^(rev\.?|reverend|pastor|dr\.?|father|fr\.?|elder|deacon|bishop)\s+(.+)$', re.I)
TITLE_ROLES = {'rev': 'Pastor', 'rev.': 'Pastor', 'reverend': 'Pastor', 'pastor': 'Pastor', 'father': 'Priest',
               'fr': 'Priest', 'fr.': 'Priest', 'elder': 'Elder', 'deacon': 'Deacon', 'bishop': 'Bishop'}


def _person(line):
    if NOT_NAME_RE.search(re.sub(r'^(?i:rev|reverend|pastor|dr|mr|mrs|ms|fr|father|elder|deacon|bishop)\.?\s+', '', line)):
        return False
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
        if len(role) > 60 or not ROLE_NOUN_RE.search(role) or EMAIL_RE.search(role) or re.search(r'\d|[.!?]$', role) \
                or LITURGY_RE.search(role) or BARE_ROLE_RE.fullmatch(role.strip(' :')):
            return '', 0
        if WRAPPED_ROLE.search(role) and i + 1 < len(lines) and len(role) + len(lines[i + 1]) <= 90:
            # "Deacon of" / "New Member Assimilation": the next line finishes the role unless it is an email, a role
            # of its own, or the name on the next card (a name followed by its role).
            rest = lines[i + 1]
            next_card = _person(rest) and i + 2 < len(lines) and ROLE_NOUN_RE.search(lines[i + 2]) \
                and not EMAIL_RE.search(lines[i + 2])
            if not EMAIL_RE.search(rest) and not ROLE_NOUN_RE.search(rest) and not next_card \
                    and not re.search(r'[.!?]$', rest):
                return f'{role} {rest}', 2
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
        titled = TITLED_RE.match(line) if not role and i and SIGN_OFF_RE.match(lines[i - 1]) and _person(line) else None
        if titled and TITLE_ROLES.get(titled.group(1).lower()):
            # "Blessings, / Pastor Dan Whitfield" signs a letter: Dan Whitfield, Pastor.
            items.append(_item('staff', {'name': titled.group(2).strip(), 'role': TITLE_ROLES[titled.group(1).lower()]},
                               f'{lines[i - 1]} {line}', source, method='pattern'))
            i += 1
            continue
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
        when = infer_date(month, int(match.group(2)), line[:match.start()], today,
                          int(match.group(3)) if match.group(3) else None)
        if when is None or not _upcoming(when.isoformat(), today):
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
