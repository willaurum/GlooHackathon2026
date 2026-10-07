"""Church calendars: finding the calendar a church's site embeds or links, and reading iCal feeds.

Every church keeps its calendar somewhere different: a Google Calendar embed, Planning Center's Church Center, Tockify,
an Outlook published calendar, Teamup, The Events Calendar on WordPress, or a plain .ics link. `detect` recognizes
them on the crawled pages (plain code, nothing is fetched) and works out the public iCal feed when the provider has
one; otherwise the calendar is kept as a link.

A feed whose host's robots.txt allows it is read during the import like any other feed. Many providers'
feed hosts ask crawlers to stay away (Google Calendar's does), so those are never read during the crawl: the review
step asks the church "Import its upcoming events?", and only after the church says yes is that one feed read, as a
calendar app would when someone subscribes to it (builder.import_calendar). That is the only fetch Tekton makes
without robots.txt's permission, and only for feed addresses Tekton derived itself (is_feed_url).

`events` reads an iCal feed into event items: recurring events are expanded (RRULE: DAILY, WEEKLY, MONTHLY and
YEARLY with INTERVAL, BYDAY including ordinals like 1SU and -1TU, BYMONTHDAY, BYMONTH, COUNT, UNTIL; EXDATE;
RECURRENCE-ID overrides; cancelled events skipped), times are shown in the calendar's own time zone, and only what
happens from today through EVENT_HORIZON_DAYS is kept. A weekly or daily event becomes one highlight ("Weekly on
Wednesday at 7:00 PM"); everything else becomes dated calendar entries.
"""
import base64
import calendar as month_calendar
import re
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import parse_qs, quote, unquote, urlparse

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python 3.9+ always has zoneinfo
    ZoneInfo, ZoneInfoNotFoundError = None, Exception

MAX_CALENDARS = 10
MAX_FEED_BYTES = 5_000_000
MAX_IMPORTED = 200
MAX_STEPS = 5000  # periods walked per recurring event, so one odd rule cannot stall the import
DAY_CODES = ('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU')
DAY_NAMES = {'SU': 'Sunday', 'MO': 'Monday', 'TU': 'Tuesday', 'WE': 'Wednesday', 'TH': 'Thursday', 'FR': 'Friday',
             'SA': 'Saturday'}

# Calendar feed addresses Tekton derives itself; only these may be read with the church's consent (and the fetch
# bridge, api/builderfetch.ts, accepts its 'calendar' kind only for the same patterns).
FEED_PATTERNS = (
    re.compile(r'^https://calendar\.google\.com/calendar/ical/[^/?#]+/public/basic\.ics$', re.I),
    re.compile(r'^https://(?:www\.)?google\.com/calendar/ical/[^/?#]+/public/basic\.ics$', re.I),
    re.compile(r'^https://tockify\.com/api/feeds/ics/[\w-]+$', re.I),
    re.compile(r'^https://outlook\.(?:office365|office|live)\.com/owa/calendar/[^?#]+/calendar\.ics$', re.I),
    re.compile(r'^https://ics\.teamup\.com/feed/[\w-]+/\d+\.ics$', re.I),
    re.compile(r'^https://[^/?#]+/[^?#]*\.ics(?:\?[^#]*)?$', re.I),
    re.compile(r'^https://[^/?#]+/[^?#]*\?(?:[^#]*&)?ical=1(?:&[^#]*)?$', re.I),
)

# Providers whose public calendars have no feed address Tekton can work out: kept as a link to the church's calendar.
LINK_ONLY = (
    ('churchcenter.com', 'Church Center (Planning Center)', re.compile(r'(^|\.)churchcenter\.com$'), re.compile(r'^/calendar')),
    ('churchsuite.com', 'ChurchSuite', re.compile(r'(^|\.)churchsuite\.(com|co\.uk)$'), re.compile(r'calendar|events')),
    ('elvanto.net', 'Elvanto', re.compile(r'(^|\.)elvanto\.(net|com\.au|eu)$'), re.compile(r'calendar|events')),
    ('breezechms.com', 'Breeze', re.compile(r'(^|\.)breezechms\.com$'), re.compile(r'calendar|events')),
    ('subsplash.com', 'Subsplash', re.compile(r'(^|\.)subsplash\.com$'), re.compile(r'calendar|events')),
    ('elexio.com', 'Elexio', re.compile(r'(^|\.)elexio\.com$'), re.compile(r'calendar|events')),
    ('ministryplatform', 'MinistryPlatform', re.compile(r'ministryplatform'), re.compile(r'calendar|events')),
)


def is_feed_url(url):
    """True for a calendar feed address of a shape Tekton derives (FEED_PATTERNS)."""
    return isinstance(url, str) and len(url) <= 500 and any(p.match(url) for p in FEED_PATTERNS)


def _google_ids(url):
    """Calendar ids named by a Google Calendar embed or link: src= (one or more), or cid= (an id or its base64)."""
    query = parse_qs(urlparse(url).query)
    ids = list(query.get('src', []))
    for cid in query.get('cid', []):
        if '@' in cid or '.' in cid:
            ids.append(cid)
            continue
        try:
            decoded = base64.urlsafe_b64decode(cid + '=' * (-len(cid) % 4)).decode('utf-8')
        except (ValueError, UnicodeDecodeError):
            continue
        if re.fullmatch(r'[\w.+%-]+@[\w.-]+', decoded):
            ids.append(decoded)
    path = urlparse(url).path
    feed = re.search(r'/calendar/ical/([^/]+)/public/', path)
    if feed:
        ids.append(unquote(feed.group(1)))
    # Google's own public calendars (holidays, sports: ...@group.v.calendar.google.com) are not the church's events.
    return [i.strip() for i in dict.fromkeys(ids) if re.fullmatch(r'[\w.+%-]+@[\w.-]+', i.strip())
            and not i.strip().endswith('@group.v.calendar.google.com')]


def _google_name(calendar_id, title):
    title = re.sub(r'^\s*(google\s+)?calendar\s*[,:\-–]\s*', '', title or '', flags=re.I).strip()
    if title and title.lower() not in ('calendar', 'google calendar'):
        return title[:120]
    local, _, domain = calendar_id.partition('@')
    if domain in ('gmail.com', 'googlemail.com'):
        return local.replace('.', ' ').replace('_', ' ').strip().title()[:120]
    return ''


def _provider(url, title=''):
    """[(provider, name, feed_url or '')] for one embed or link address; [] when it is not a calendar."""
    parsed = urlparse(url)
    host, path = (parsed.hostname or '').lower(), parsed.path or ''
    if parsed.scheme == 'webcal':
        return [('iCal', title, 'https://' + url.split('://', 1)[1])]
    if parsed.scheme not in ('http', 'https'):
        return []
    if host in ('calendar.google.com', 'www.google.com', 'google.com') and path.startswith('/calendar'):
        return [('Google Calendar', _google_name(cid, title),
                 f'https://calendar.google.com/calendar/ical/{quote(cid, safe="")}/public/basic.ics')
                for cid in _google_ids(url)]
    if host == 'tockify.com':
        name = re.match(r'^/(?:api/feeds/ics/|embed/)?([\w-]+)', path)
        if name and name.group(1) not in ('api', 'pricing', 'login', 'signup', 'help'):
            return [('Tockify', title, f'https://tockify.com/api/feeds/ics/{name.group(1)}')]
    if re.fullmatch(r'outlook\.(office365|office|live)\.com', host) and path.startswith('/owa/calendar/'):
        base = re.sub(r'/(calendar\.html|calendar\.ics|reachcalendar\.ics)$', '', path)
        return [('Outlook', title, f'https://{host}{base}/calendar.ics')]
    if host in ('teamup.com', 'www.teamup.com'):
        key = re.match(r'^/(ks[\w-]+)', path)
        if key:
            return [('Teamup', title, f'https://ics.teamup.com/feed/{key.group(1)}/0.ics')]
    if host == 'ics.teamup.com':
        return [('Teamup', title, url)]
    for _, provider, host_re, path_re in LINK_ONLY:
        if host_re.search(host) and path_re.search(path):
            return [(provider, title, '')]
    if re.search(r'\.ics$', path, re.I) or re.search(r'(^|&)ical=1(&|$)', parsed.query):
        return [('iCal', title, url if parsed.scheme == 'https' else 'https://' + url.split('://', 1)[1])]
    return []


def detect(sources):
    """The calendars the church's pages embed or link, at most MAX_CALENDARS, each once:
    {id, provider, name, feed_url, page_url, page_title, embed_url, robots_allowed, status, count}."""
    found = {}
    for source in sources:
        if source.get('kind', 'page') != 'page':
            continue
        candidates = [(src, title, True) for src, title in source.get('embeds') or []]
        candidates += [(href, text, False) for href, text, *_ in source.get('anchors') or []]
        candidates += [(href, '', False) for href in source.get('links') or [] if str(href).lower().startswith('webcal:')]
        candidates += [(f'https://tockify.com/{name}', '', True) for name in source.get('calendar_hints') or []]
        for address, title, embedded in candidates:
            for provider, name, feed_url in _provider(str(address), str(title or '')):
                key = feed_url or address
                if key in found or len(found) >= MAX_CALENDARS:
                    continue
                if feed_url and not is_feed_url(feed_url):
                    feed_url = ''
                found[key] = {
                    'id': f'cal{len(found) + 1}', 'provider': provider,
                    'name': (name or (source.get('title') or '').split('|')[0].strip() or provider)[:120],
                    'feed_url': feed_url, 'page_url': source.get('url') or '', 'page_title': source.get('title') or '',
                    'embed_url': address if embedded else '', 'robots_allowed': None,
                    'status': 'found' if feed_url else 'link', 'count': 0,
                }
    return list(found.values())


def label(entry):
    """How the review and progress feed name a calendar: "FBC Schedule (Google Calendar)"."""
    name, provider = entry.get('name') or '', entry.get('provider') or 'calendar'
    return f'{name} ({provider})' if name and name != provider else provider


# ---------------------------------------------------------------- reading iCal


def unfold(text):
    """iCal content lines with folded continuations joined."""
    lines = []
    for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        if line[:1] in (' ', '\t') and lines:
            lines[-1] += line[1:]
        elif line:
            lines.append(line)
    return lines


def _unescape(value):
    return value.replace('\\n', ' ').replace('\\N', ' ').replace('\\,', ',').replace('\\;', ';').replace('\\\\', '\\')


def _property(line):
    """(NAME, {PARAM: value}, value) for one content line."""
    head, _, value = line.partition(':')
    name, *params = head.split(';')
    return name.upper(), {k.upper(): v.strip('"') for k, _, v in (p.partition('=') for p in params)}, value.strip()


def _zone(name):
    if not name or ZoneInfo is None:
        return None
    try:
        return ZoneInfo(name.strip().strip('/'))
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


def _moment(value, params, zone):
    """(date, time or None, raw) in the calendar's time zone, or None when the value is not a date."""
    match = re.match(r'^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$', value)
    if not match:
        return None
    try:
        day = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None
    if match.group(4) is None or params.get('VALUE', '').upper() == 'DATE':
        return day, None, value
    clock = time(int(match.group(4)) % 24, int(match.group(5)))
    if match.group(7) and zone is not None:  # UTC, shown in the calendar's own zone
        local = datetime.combine(day, clock, tzinfo=timezone.utc).astimezone(zone)
        return local.date(), local.time().replace(second=0, microsecond=0, tzinfo=None), value
    return day, clock, value


def _twelve(clock):
    if clock is None:
        return ''
    hour = clock.hour % 12 or 12
    return f'{hour}:{clock.minute:02d} {"PM" if clock.hour >= 12 else "AM"}'


def _rule(text):
    rule = {}
    for part in text.split(';'):
        key, _, value = part.partition('=')
        rule[key.upper()] = value
    return rule


def _by_day(rule):
    """[(ordinal or None, weekday 0-6)] from BYDAY ("MO,WE", "1SU", "-1TU")."""
    out = []
    for token in rule.get('BYDAY', '').split(','):
        match = re.fullmatch(r'([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)', token.strip().upper())
        if match:
            out.append((int(match.group(1)) if match.group(1) else None, DAY_CODES.index(match.group(2))))
    return out


def _month_days(year, month, rule, start):
    """The days of one month a MONTHLY (or YEARLY within a month) rule picks."""
    days_in = month_calendar.monthrange(year, month)[1]
    picked = set()
    for value in rule.get('BYMONTHDAY', '').split(','):
        if re.fullmatch(r'[+-]?\d{1,2}', value.strip()):
            n = int(value)
            n = n if n > 0 else days_in + 1 + n
            if 1 <= n <= days_in:
                picked.add(n)
    for ordinal, weekday in _by_day(rule):
        matches = [d for d in range(1, days_in + 1) if date(year, month, d).weekday() == weekday]
        if ordinal is None:
            picked.update(matches)
        elif 1 <= abs(ordinal) <= len(matches):
            picked.add(matches[ordinal - 1] if ordinal > 0 else matches[ordinal])
    if not rule.get('BYMONTHDAY') and not rule.get('BYDAY'):
        if start.day <= days_in:
            picked.add(start.day)
    return [date(year, month, d) for d in sorted(picked)]


def _until(rule, zone):
    value = rule.get('UNTIL', '')
    moment = _moment(value, {}, zone) if value else None
    return moment[0] if moment else None


def occurrences(start, rule, end, exdates=(), zone=None):
    """The dates (from `start`, through `end`) a recurrence rule produces, minus exdates. Unsupported rules
    (BYSETPOS, BYWEEKNO, BYYEARDAY, HOURLY...) give only the start date, so they are never invented."""
    freq = rule.get('FREQ', '').upper()
    if freq not in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') or any(k in rule for k in ('BYSETPOS', 'BYWEEKNO', 'BYYEARDAY',
                                                                                         'BYHOUR', 'BYMINUTE')):
        return [start] if start <= end and start not in exdates else []
    try:
        interval = max(1, int(rule.get('INTERVAL') or 1))
        count = int(rule['COUNT']) if rule.get('COUNT') else None
    except ValueError:
        return [start]
    until = _until(rule, zone)
    stop = min(end, until) if until else end
    months = [int(m) for m in rule.get('BYMONTH', '').split(',') if m.strip().isdigit() and 1 <= int(m) <= 12]
    out, seen, steps = [], 0, 0
    period = 0
    if count is None:
        # Without COUNT nothing before the window matters, so jump ahead in whole intervals (dates stay aligned).
        if freq == 'DAILY':
            period = max(0, ((stop - timedelta(days=400)) - start).days // interval)
        elif freq == 'WEEKLY':
            period = max(0, ((stop - timedelta(days=400)) - start).days // 7 // interval)
        elif freq == 'MONTHLY':
            period = max(0, ((stop.year - start.year) * 12 + stop.month - start.month - 14) // interval)
    while steps < MAX_STEPS:
        steps += 1
        if freq == 'DAILY':
            day = start + timedelta(days=period * interval)
            batch = [day] if not months or day.month in months else []
        elif freq == 'WEEKLY':
            week = start - timedelta(days=start.weekday()) + timedelta(weeks=period * interval)
            weekdays = sorted({w for _, w in _by_day(rule)} or {start.weekday()})
            batch = [week + timedelta(days=w) for w in weekdays]
        elif freq == 'MONTHLY':
            index = start.month - 1 + period * interval
            year, month = start.year + index // 12, index % 12 + 1
            batch = [] if months and month not in months else _month_days(year, month, rule, start)
        else:
            year = start.year + period * interval
            batch = []
            for month in months or [start.month]:
                if rule.get('BYDAY') or rule.get('BYMONTHDAY'):
                    batch += _month_days(year, month, rule, start)
                elif start.day <= month_calendar.monthrange(year, month)[1]:
                    batch.append(date(year, month, start.day))
        if batch and min(batch) > stop:
            break
        for day in batch:
            if day < start or day > stop:
                continue
            seen += 1
            if count is not None and seen > count:
                return out
            if day not in exdates:
                out.append(day)
        period += 1
    return out


def _parse(text):
    """(calendar time zone, [event dict]) from iCal text."""
    lines = unfold(text)
    zone_name = next((_property(l)[2] for l in lines if l.upper().startswith('X-WR-TIMEZONE')), '')
    zone_name = zone_name or next((_property(l)[2] for l in lines if l.upper().startswith('TZID:')), '')
    zone = _zone(zone_name)
    events, event, depth = [], None, 0
    for line in lines:
        upper = line.upper()
        if upper == 'BEGIN:VEVENT':
            event, depth = {'EXDATE': []}, 0
        elif upper == 'END:VEVENT' and event is not None:
            events.append(event)
            event = None
        elif event is not None and upper.startswith('BEGIN:'):
            depth += 1  # an alarm inside the event: its lines are not the event's
        elif event is not None and upper.startswith('END:'):
            depth -= 1
        elif event is not None and depth == 0 and ':' in line:
            name, params, value = _property(line)
            if name == 'EXDATE':
                event['EXDATE'] += [(v, params) for v in value.split(',')]
            elif name not in event:
                event[name] = (value, params)
    return zone, events


def events(source, text, today, horizon_days, limit, quote_name=''):
    """Event items (builder_structured shape) from an iCal feed: upcoming one-time events and occurrences with their
    date, weekly and daily ones as one highlight each, nearest first, at most `limit`."""
    from .builder_structured import _item
    zone, parsed = _parse(text)
    end = today + timedelta(days=horizon_days)
    overridden, items, seen = set(), [], set()
    for event in parsed:
        if 'RECURRENCE-ID' in event:
            moment = _moment(event['RECURRENCE-ID'][0], event['RECURRENCE-ID'][1], zone)
            if moment:
                overridden.add((event.get('UID', ('', {}))[0], moment[0]))
    for event in parsed:
        name = _unescape(event.get('SUMMARY', ('', {}))[0]).strip()
        if not name or event.get('STATUS', ('', {}))[0].upper() == 'CANCELLED' or 'DTSTART' not in event:
            continue
        moment = _moment(event['DTSTART'][0], event['DTSTART'][1], zone)
        if not moment:
            continue
        start, clock, raw = moment
        value = {'name': name[:200], 'location': _unescape(event.get('LOCATION', ('', {}))[0])[:200],
                 'description': _unescape(event.get('DESCRIPTION', ('', {}))[0])[:2000]}
        quote = f'{name} {raw}' if not quote_name else f'{quote_name}: {name} {raw}'
        rule = _rule(event['RRULE'][0]) if 'RRULE' in event and 'RECURRENCE-ID' not in event else None
        if rule is None:
            if today <= start <= end:
                items.append(_item('events', {**value, 'date': start.isoformat(), 'time': _twelve(clock)}, quote, source))
            continue
        uid = event.get('UID', ('', {}))[0]
        exdates = {m[0] for m in (_moment(v, p, zone) for v, p in event['EXDATE']) if m}
        exdates |= {d for u, d in overridden if u == uid}
        days = [d for d in occurrences(start, rule, end, exdates, zone) if d >= today]
        if not days:
            continue  # a rule that has ended (or not started yet within the window)
        freq, interval = rule.get('FREQ', '').upper(), rule.get('INTERVAL') or '1'
        until = _until(rule, zone)
        ongoing = not rule.get('COUNT') and (until is None or until >= end)  # a class of 3 weeks keeps its dates
        if freq in ('WEEKLY', 'DAILY') and interval == '1' and len(days) >= 2 and ongoing:
            if freq == 'DAILY':
                when = 'Daily'
            else:
                weekdays = sorted({w for _, w in _by_day(rule)} or {start.weekday()})
                when = 'Weekly on ' + ', '.join(DAY_NAMES[DAY_CODES[w]] for w in weekdays)
            items.append(_item('events', {**value, 'when': when + (f' at {_twelve(clock)}' if clock else '')}, quote, source))
            continue
        for day in days:
            items.append(_item('events', {**value, 'date': day.isoformat(), 'time': _twelve(clock)}, quote, source))
    out, keys = [], set()
    for item in sorted(items, key=lambda i: (i['value'].get('date') or '9999', i['value']['name'].lower())):
        key = (item['value']['name'].lower(), item['value'].get('date', ''), item['value'].get('time', ''), item['value'].get('when', ''))
        if key not in keys:
            keys.add(key)
            out.append(item)
    return out[:limit]
