"""Everything that touches SQL lives here.

The database is a SQLite Durable Object. It's reached over HTTP at CHURCH_DB_URL
(the Worker routes the `church-db` host to it). Each call sends a batch of
{sql, params} statements; the Durable Object runs a batch as one transaction.

Every church has its own database. The church a request is for is set by
church_scope.py (from the X-Church header the Worker adds) and every call here
goes to that church, so endpoints never pass a church around. The first call for
a church creates its tables; only the demo church is seeded with the JSON files.
"""

import datetime
import os
import hashlib
import json
import logging
import secrets
import sqlite3
import threading
import contextvars
from contextlib import contextmanager
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

CHURCH_DB_URL = os.environ.get("CHURCH_DB_URL", "http://church-db")

_USE_LOCAL_SQLITE = CHURCH_DB_URL.startswith("sqlite")

_client = httpx.Client(base_url="http://church-db" if _USE_LOCAL_SQLITE else CHURCH_DB_URL, timeout=30)
_sqlite_conns = {}

NOW = "(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
BLOG_SEEDED = "SELECT 1 FROM config WHERE key = 'blog_seeded'"
NEWS_POSTS_SEEDED = "SELECT 1 FROM config WHERE key = 'news_posts_seeded'"
CONFIG_FIELDS = ('name', 'timezone', 'default_language')
DEFAULT_CONFIG = {'name': 'Our Church', 'timezone': 'UTC', 'default_language': 'en'}
# Every chunk records the embedding model that made its vector; the Worker only compares a question with chunks
# from its current model (api/embed.ts). Rows from before the tag existed were Workers AI bge-base with cls pooling.
LEGACY_EMBED_TAG = 'workers-ai:@cf/baai/bge-base-en-v1.5:cls'
ANNOTATION_CATEGORIES = ('bible_quote', 'bible_paraphrase', 'recent_event',
                         'political_event', 'personal_story', 'inerrancy_claim')

# --- Which church ---

DEMO_CHURCH = 'grace-community'
# (slug, name, city) of the church this request or job is for.
_church = contextvars.ContextVar('church', default=(DEMO_CHURCH, '', ''))
_ready = set()
_initializing = set()
_init_lock = threading.RLock()


def _get_sqlite_conn(slug: str = DEMO_CHURCH):
    global _sqlite_conns
    if slug not in _sqlite_conns:
        db_dir = Path(os.environ.get("SQLITE_DB_DIR", "/app" if Path("/app").exists() else "."))
        db_file = db_dir / f"church_{slug}.db" if slug != DEMO_CHURCH else db_dir / "church.db"
        conn = sqlite3.connect(db_file, check_same_thread=False)
        conn.row_factory = lambda c, r: {col[0]: r[i] for i, col in enumerate(c.description)}
        _sqlite_conns[slug] = conn
    return _sqlite_conns[slug]


def _run_local_sqlite(slug, *statements):
    conn = _get_sqlite_conn(slug)
    results = []
    with conn:
        for sql, params in statements:
            p = [int(x) if isinstance(x, bool) else x for x in params]
            cursor = conn.execute(sql, p)
            rows = cursor.fetchall() if cursor.description else []
            rows_written = cursor.rowcount if cursor.rowcount > 0 else 0
            results.append({'rows': rows, 'rowsWritten': rows_written})
    return results


def current_church():
    return _church.get()[0]


@contextmanager
def use_church(slug, name='', city=''):
    """Send every database call in this block to one church."""
    token = _church.set((slug, name, city))
    try:
        yield
    finally:
        _church.reset(token)


def ready_churches():
    """Churches whose database this process has opened."""
    return sorted(_ready)


def _ensure_ready(slug):
    with _init_lock:
        if slug not in _ready and slug not in _initializing:
            initialize()


def run(*statements):
    """Run [(sql, params), ...] as one transaction in the current church. Returns one result per statement:
    {'rows': [...], 'rowsWritten': n}."""
    slug = current_church()
    if slug not in _ready:
        _ensure_ready(slug)

    # Local SQLite only when asked for explicitly (docker-compose sets CHURCH_DB_URL=sqlite).
    # A church-db failure must surface as an error, never as a silent switch to a local file.
    if _USE_LOCAL_SQLITE:
        return _run_local_sqlite(slug, *statements)

    batch = [{'sql': sql, 'params': [int(p) if isinstance(p, bool) else p for p in params]}
             for sql, params in statements]
    response = _client.post('/sql', json={'batch': batch}, headers={'X-Church': slug})
    response.raise_for_status()
    return response.json()['results']


def query(sql, params=()):
    return run((sql, params))[0]['rows']


def one(sql, params=()):
    rows = query(sql, params)
    return rows[0] if rows else None


def close():
    global _sqlite_conns
    _client.close()
    for conn in _sqlite_conns.values():
        try:
            conn.close()
        except Exception:
            pass
    _sqlite_conns.clear()



def _data(row):
    """JSON columns are stored as TEXT."""
    return json.loads(row['data'])


def initialize():
    """Open the current church: create its tables without resetting data. The demo church is
    seeded from the JSON files; a new church starts empty, with just its name and city."""
    slug, name, city = _church.get()
    with _init_lock:
        _initializing.add(slug)
        try:
            _create_tables(seed=slug == DEMO_CHURCH)
            _ensure_embed_column()
            _ensure_highlight_engine_column()
            if slug != DEMO_CHURCH:
                start_church(name or slug, city)
            _ready.add(slug)
        finally:
            _initializing.discard(slug)


def _ensure_embed_column():
    """Add chunks.embed_model to a database made before it existed; its rows are tagged as the legacy model.
    The Worker does the same (api/embed.ts), so either side may get there first."""
    def has_column():
        try:
            run(("SELECT embed_model FROM chunks LIMIT 0", ()))
            return True
        except Exception:
            return False
    if has_column():
        return
    try:
        run((f"ALTER TABLE chunks ADD COLUMN embed_model TEXT NOT NULL DEFAULT '{LEGACY_EMBED_TAG}'", ()))
    except Exception:
        if not has_column():
            raise


def _ensure_highlight_engine_column():
    """Add notes.highlight_engine (which model tagged the highlights) to a database made before it existed.
    Notes processed before then keep '' (unknown)."""
    def has_column():
        try:
            run(("SELECT highlight_engine FROM notes LIMIT 0", ()))
            return True
        except Exception:
            return False
    if has_column():
        return
    try:
        run(("ALTER TABLE notes ADD COLUMN highlight_engine TEXT NOT NULL DEFAULT ''", ()))
    except Exception:
        if not has_column():
            raise


def _create_tables(seed=True):
    """Create tables and seed content without resetting user data. One batch.
    With seed=False only the tables are made (every INSERT is left out)."""
    ministries = json.loads(Path(__file__).with_name('ministries.json').read_text(encoding='utf-8'))
    _add_news_columns()
    statements = [
        ("CREATE TABLE IF NOT EXISTS ministries (id INTEGER PRIMARY KEY, data TEXT NOT NULL)", ()),
        ("""CREATE TABLE IF NOT EXISTS connections (
            connection_id INTEGER PRIMARY KEY AUTOINCREMENT,
            ministry_id INTEGER NOT NULL REFERENCES ministries(id),
            member TEXT NOT NULL,
            UNIQUE (ministry_id, member)
        )""", ()),
        (f"""CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            done INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT {NOW}
        )""", ()),
        # Church-specific settings. Code stays church-agnostic; each deploy has its own row.
        ("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, data TEXT NOT NULL)", ()),
        # Pastor Notes: one row per video, its whisper segments, and embedded chunks for Q&A.
        (f"""CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('youtube', 'upload')),
            source_url TEXT,
            r2_key TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            error TEXT,
            duration REAL,
            word_count INTEGER,
            transcript TEXT,
            started_at TEXT,
            created_at TEXT NOT NULL DEFAULT {NOW},
            highlight_engine TEXT NOT NULL DEFAULT ''
        )""", ()),
        ("""CREATE TABLE IF NOT EXISTS segments (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            start REAL NOT NULL,
            "end" REAL NOT NULL,
            text TEXT NOT NULL,
            PRIMARY KEY (note_id, idx)
        )""", ()),
        ("""CREATE TABLE IF NOT EXISTS chunks (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            start REAL NOT NULL,
            "end" REAL NOT NULL,
            seg_from INTEGER NOT NULL,
            seg_to INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding TEXT NOT NULL,
            embed_model TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (note_id, idx)
        )""", ()),
        # Transcript passages tagged by category (Bible quote, personal story, ...), as segment ranges.
        (f"""CREATE TABLE IF NOT EXISTS annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            seg_from INTEGER NOT NULL,
            seg_to INTEGER NOT NULL,
            category TEXT NOT NULL CHECK (category IN ({', '.join(repr(c) for c in ANNOTATION_CATEGORIES)})),
            label TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 1.0
        )""", ()),
        # First-time guest sign-ups and their day-of arrival status.
        (f"""CREATE TABLE IF NOT EXISTS visits (
            visit_id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            contact TEXT NOT NULL DEFAULT '',
            service TEXT NOT NULL,
            party_size INTEGER NOT NULL DEFAULT 1,
            kids TEXT NOT NULL DEFAULT '',
            wants_host INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'planned',
            host TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT {NOW},
            arrived_at TEXT
        )""", ()),
        # Church info, FAQs, events and small groups the chat agent can look up.
        ("""CREATE TABLE IF NOT EXISTS church_content (
            kind TEXT NOT NULL,
            id INTEGER NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (kind, id)
        )""", ()),
        # Prayer map: missionary presence regions and curated regional news.
        ("CREATE TABLE IF NOT EXISTS regions (id INTEGER PRIMARY KEY, data TEXT NOT NULL)", ()),
        ("CREATE TABLE IF NOT EXISTS news_events (id INTEGER PRIMARY KEY, data TEXT NOT NULL)", ()),
        # Dated "From the field" updates, newest first on the Prayer map. Prayer points were removed.
        ("DROP TABLE IF EXISTS prayer_angles", ()),
        (f"""CREATE TABLE IF NOT EXISTS field_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region_id INTEGER NOT NULL REFERENCES regions(id),
            date TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT {NOW}
        )""", ()),
        # Requests filed by the chat agent. Nothing happens until staff approve them.
        (f"""CREATE TABLE IF NOT EXISTS requests (
            request_id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            ministry_id INTEGER REFERENCES ministries(id),
            name TEXT NOT NULL,
            contact TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT {NOW}
        )""", ()),
        # Applications to serve on a team, from the team's page or the chat. Staff review each one
        # (new → accepted, waitlisted or declined) in Church staff → Volunteers. Only what that team
        # needs is kept: contact details, and in their own words who they are, what they'd like to do and why.
        (f"""CREATE TABLE IF NOT EXISTS volunteer_applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ministry_id INTEGER NOT NULL,
            ministry_name TEXT NOT NULL,
            name TEXT NOT NULL,
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            note TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'website',
            legacy_request_id INTEGER UNIQUE,
            created_at TEXT NOT NULL DEFAULT {NOW}
        )""", ()),
        # Audit log of every chat turn and tool call.
        (f"""CREATE TABLE IF NOT EXISTS chat_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT {NOW}
        )""", ()),
        # News posts. kind 'update' is a short post that points somewhere (link_url) and never has
        # key takeaways; kind 'article' is a longer read with key takeaways and an optional link.
        (f"""CREATE TABLE IF NOT EXISTS blog_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT 'Church Staff',
            categories TEXT NOT NULL DEFAULT '[]',
            bullet_summary TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT {NOW},
            updated_at TEXT NOT NULL DEFAULT {NOW},
            kind TEXT NOT NULL DEFAULT 'article',
            link_url TEXT NOT NULL DEFAULT '',
            link_label TEXT NOT NULL DEFAULT ''
        )""", ()),
        ("INSERT OR IGNORE INTO config VALUES ('church', ?)", (json.dumps(DEFAULT_CONFIG),)),
        # A restart interrupts any job that was running; let it be retried.
        ("UPDATE notes SET status = 'failed', error = 'interrupted' WHERE status = 'processing'", ()),
    ]
    statements.append(('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, location TEXT NOT NULL, ministry_name TEXT, description TEXT NOT NULL, ai_summary TEXT)', ()))
    events_file = Path(__file__).with_name('events.json')
    if events_file.exists():
        # Each sample event is added once, with a marker per event: an event staff delete stays deleted
        # across container restarts, and an event added to events.json later still reaches the demo church.
        # It keeps its id unless staff events already took it, and is skipped if the same event is there.
        for event in json.loads(events_file.read_text(encoding='utf-8')):
            marker = f"event_seeded:{event['id']}"
            statements.append(('INSERT INTO events (id, title, category, date, time, location, ministry_name, description, ai_summary) '
                               'SELECT CASE WHEN EXISTS (SELECT 1 FROM events WHERE id = ?) THEN NULL ELSE ? END, ?, ?, ?, ?, ?, ?, ?, ? '
                               'WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = ?) '
                               'AND NOT EXISTS (SELECT 1 FROM events WHERE title = ? AND date = ?)',
                (event['id'], event['id'], event['title'], event['category'], event['date'], event['time'], event['location'],
                 event.get('ministry_name'), event['description'], event.get('ai_summary'), marker, event['title'], event['date'])))
            statements.append(("INSERT OR IGNORE INTO config VALUES (?, 'true')", (marker,)))
    statements += [("INSERT OR IGNORE INTO ministries VALUES (?, ?)", (m['id'], json.dumps(m))) for m in ministries]
    church = json.loads(Path(__file__).with_name('church.json').read_text(encoding='utf-8'))
    statements.append(("INSERT OR IGNORE INTO church_content VALUES ('info', 0, ?)", (json.dumps(church['info']),)))
    statements += [("INSERT OR IGNORE INTO church_content VALUES (?, ?, ?)", (kind, item['id'], json.dumps(item)))
                   for kind in ('faqs', 'events', 'groups') for item in church[kind]]
    # Prayer map seed data. A region's first update is added only together with the region itself,
    # so an update a church deletes does not come back on the next start.
    regions_file = Path(__file__).with_name('regions.json')
    if regions_file.exists():
        for region in json.loads(regions_file.read_text(encoding='utf-8')):
            updates = region.pop('updates', [])
            statements += [("""INSERT INTO field_updates (region_id, date, title, body, author)
                SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM regions WHERE id = ?)""",
                            (region['id'], u['date'], u.get('title', ''), u['body'], u.get('author', ''), region['id']))
                           for u in updates]
            statements.append(("INSERT OR IGNORE INTO regions VALUES (?, ?)", (region['id'], json.dumps(region))))
    # Real headlines (news_live.json, from scripts/fetch_news.py) replace the news after this batch;
    # the fictional news.json is only the fallback when there is no live snapshot.
    live_news = _live_news()
    news_file = Path(__file__).with_name('news.json')
    if news_file.exists() and not live_news:
        for item in json.loads(news_file.read_text(encoding='utf-8')):
            statements.append(("INSERT OR IGNORE INTO news_events VALUES (?, ?)", (item['id'], json.dumps(item))))

    # Seed 2 initial blog posts
    post1_cats = json.dumps(["Faith & Discipleship", "Community", "Spiritual Growth"])
    post1_bullets = json.dumps([
        "Life transitions can test our sense of security, but enduring joy is found in God's steadfast presence rather than changing circumstances.",
        "Honest prayer and small group fellowship provide essential community anchors during seasons of uncertainty.",
        "Practicing daily gratitude and meditating on Scripture helps cultivate peace and mutual grace across the church family."
    ])
    post1_content = (
        "Life has a way of shifting our footing when we least expect it. Whether transitioning to a new career, "
        "welcoming a child, or grieving a difficult loss, changes can test our sense of security and clarity. In these seasons, "
        "we are invited to remember that our hope is not anchored in our shifting circumstances, but in the steadfast love and faithfulness of Christ.\n\n"
        "True spiritual joy is not the absence of difficulty; it is the presence of God in the midst of it. When we engage in honest prayer and open our "
        "lives to Christian community, we discover that we never have to walk uncharted seasons alone. Our church small groups and weekly fellowship remind "
        "us that we are part of a family bound together by grace.\n\n"
        "As we step into this upcoming season together, let us practice daily gratitude, remain rooted in Scripture, and extend grace generously to ourselves "
        "and those around us. In every season of change, God is quietly at work molding us into who He made us to be."
    )
    statements.append((f"""INSERT INTO blog_posts (id, title, content, author, categories, bullet_summary, created_at, updated_at)
        SELECT 1, 'Walking in Faith: Cultivating Joy in Seasons of Change', ?, 'Pastor Marcus Vance', ?, ?, {NOW}, {NOW}
        WHERE NOT EXISTS (SELECT 1 FROM blog_posts WHERE id = 1) AND NOT EXISTS ({BLOG_SEEDED})""", (post1_content, post1_cats, post1_bullets)))

    post2_cats = json.dumps(["Local Outreach", "Volunteering", "Compassion Ministry"])
    post2_bullets = json.dumps([
        "God's kingdom is revealed most powerfully through everyday, faithful acts of kindness and practical care.",
        "Serving local families with food distribution and mentoring shows neighbors they are valued and loved.",
        "Volunteering shifts our focus outward, fostering personal spiritual renewal while meeting real community needs."
    ])
    post2_content = (
        "It is easy to imagine that making a difference in the world requires grand gestures or extraordinary platforms. Yet throughout the Gospels, "
        "Jesus consistently revealed the kingdom of God through simple, faithful acts: sharing a meal, washing feet, listening with compassion, and meeting immediate physical needs.\n\n"
        "Here at Grace Community, our local outreach ministries and community food drives are built on this same conviction. When volunteers show up on a Saturday morning "
        "to pack grocery hampers or mentor a neighborhood child, we are offering more than practical aid; we are communicating to our neighbors that they are seen, valued, and loved by God.\n\n"
        "Stepping out to serve also transforms our own hearts. It moves our attention from our personal anxieties to the needs of others, expanding our vision of what God is doing "
        "across our city. We encourage everyone, whether you have an hour a month or a day a week, to find a place to connect and serve."
    )
    statements.append((f"""INSERT INTO blog_posts (id, title, content, author, categories, bullet_summary, created_at, updated_at)
        SELECT 2, 'The Heart of Service: How Everyday Acts Build Lasting Hope', ?, 'Elena Rostova, Outreach Director', ?, ?, {NOW}, {NOW}
        WHERE NOT EXISTS (SELECT 1 FROM blog_posts WHERE id = 2) AND NOT EXISTS ({BLOG_SEEDED})""", (post2_content, post2_cats, post2_bullets)))
    # The sample posts are seeded once. Without this marker every container start (deploys, and waking
    # after sleepAfter) would bring back a sample post that staff had deleted.
    statements.append(("INSERT OR IGNORE INTO config VALUES ('blog_seeded', 'true')", ()))

    # More News posts: mostly short updates that point somewhere, plus articles with key takeaways.
    # Seeded once, like the sample posts above (a separate marker, so a church seeded before these existed gets them).
    for post in json.loads(Path(__file__).with_name('news_posts.json').read_text(encoding='utf-8')):
        posted = post['date'] + 'T12:00:00Z'
        categories = post.get('categories') or [post['category']]
        statements.append((f"""INSERT INTO blog_posts (title, content, author, categories, bullet_summary, kind, link_url, link_label, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM blog_posts WHERE title = ?) AND NOT EXISTS ({NEWS_POSTS_SEEDED})""",
            (post['title'], post['content'], post.get('author', 'Church Staff'), json.dumps(categories),
             json.dumps(post.get('bullet_summary', [])), post.get('kind', 'update'),
             post.get('link_url', ''), post.get('link_label', ''), posted, posted, post['title'])))
    statements.append(("INSERT OR IGNORE INTO config VALUES ('news_posts_seeded', 'true')", ()))

    statements.append(("INSERT INTO items (title, done) SELECT 'Stand up the docker stack', 1 "
                       "WHERE NOT EXISTS (SELECT 1 FROM items) UNION ALL "
                       "SELECT 'Build something on top of it', 0 WHERE NOT EXISTS (SELECT 1 FROM items)", ()))
    run(*(s for s in statements if seed or not s[0].lstrip().upper().startswith('INSERT')))
    _move_testimonies_to_updates()
    _move_connection_requests_to_applications()
    if not seed:
        return
    if live_news:
        # Only when the snapshot shipped with this build is new to this church: a container start must not
        # undo a POST /api/news/refresh, and a deploy with a newer snapshot still takes effect.
        stamp = hashlib.sha256(json.dumps(live_news, sort_keys=True).encode('utf-8')).hexdigest()[:16]
        applied = one("SELECT data FROM config WHERE key = 'news_snapshot'")
        if not applied or _data(applied) != stamp:
            replace_news(live_news, snapshot=stamp)
    # Backfill shift schedules and requirements into existing ministries without overwriting.
    seeds = {m['id']: m for m in ministries}
    updates = []
    for row in query("SELECT id, data FROM ministries"):
        if row['id'] in seeds:
            existing = _data(row)
            merged = backfill_ministry(existing, seeds[row['id']])
            if merged != existing:
                updates.append(("UPDATE ministries SET data = ? WHERE id = ?", (json.dumps(merged), row['id'])))
    if updates:
        run(*updates)
    # Backfill new seed fields into the existing info row without overwriting.
    _row = one("SELECT data FROM church_content WHERE kind = 'info'")
    if _row:
        _existing = _data(_row)
        _merged = {**church['info'], **_existing}
        run(("UPDATE church_content SET data = ? WHERE kind = 'info'", (json.dumps(_merged),)))


NEWS_COLUMNS = (("kind", "'article'"), ("link_url", "''"), ("link_label", "''"))


def _add_news_columns():
    """Blog posts became News posts: add the kind and link columns to a table made before them."""
    row = one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blog_posts'")
    if not row:
        return
    missing = [(name, default) for name, default in NEWS_COLUMNS if name not in row['sql']]
    if missing:
        run(*((f"ALTER TABLE blog_posts ADD COLUMN {name} TEXT NOT NULL DEFAULT {default}", ()) for name, default in missing))


def backfill_ministry(existing, seed):
    """Add missing shifts and eligibility metadata from the seed; saved schedules and counts win."""
    merged = json.loads(json.dumps(existing))
    merged.setdefault('shifts', seed.get('shifts', []))
    merged.setdefault('requirements', seed.get('requirements', []))
    seed_shifts = {shift['id']: shift for shift in seed.get('shifts', [])}
    for shift in merged['shifts']:
        seed_shift = seed_shifts.get(shift.get('id'))
        if seed_shift:
            for key in ('services', 'frequencies'):
                shift.setdefault(key, seed_shift.get(key, []))
    return merged


def with_shift_coverage(ministry):
    """Keep existing API coverage fields grounded in the scheduled positions."""
    if 'shifts' not in ministry:
        return ministry
    return {**ministry,
            'filled': sum(shift['filled'] for shift in ministry['shifts']),
            'total': sum(shift['total'] for shift in ministry['shifts'])}


def list_ministries():
    return [with_shift_coverage(_data(row)) for row in query("SELECT data FROM ministries ORDER BY id")]


def get_ministry(ministry_id):
    row = one("SELECT data FROM ministries WHERE id = ?", (ministry_id,))
    return with_shift_coverage(_data(row)) if row else None


def get_church_info():
    return _data(one("SELECT data FROM church_content WHERE kind = 'info'"))


def get_site():
    row = one("SELECT data FROM church_content WHERE kind = 'site'")
    return _data(row) if row else None


def get_page(slug):
    row = one("SELECT data FROM church_content WHERE kind = 'pages' AND json_extract(data, '$.slug') = ?", (slug,))
    return _data(row) if row else None


def list_content(kind):
    return [_data(row) for row in query("SELECT data FROM church_content WHERE kind = ? ORDER BY id", (kind,))]


# --- A church: its first details, and its content as one document ---

# The info fields every church has. A new church starts with these empty except its name and city.
BLANK_INFO = {'name': '', 'city': '', 'address': '', 'phone': '', 'email': '', 'office_hours': '',
              'services': [], 'about': '', 'first_visit': '', 'care_team': '', 'map_query': ''}
CONTENT_KINDS = ('faqs', 'events', 'groups', 'staff', 'locations', 'sermons', 'pages')
EVENT_COLUMNS = ('title', 'category', 'date', 'time', 'location', 'ministry_name', 'description', 'ai_summary')


def start_church(name, city=''):
    """The first rows of a new church: its info and config. Never overwrites."""
    info = {**BLANK_INFO, 'name': name, 'city': city, 'map_query': city}
    run(("INSERT OR IGNORE INTO church_content VALUES ('info', 0, ?)", (json.dumps(info),)),
        ("INSERT OR IGNORE INTO config VALUES ('church', ?)", (json.dumps({**DEFAULT_CONFIG, 'name': name}),)))


def export_content():
    """Everything a church shows, in the import shape (see replace_content and README.md)."""
    return {'info': get_church_info(), **{kind: list_content(kind) for kind in CONTENT_KINDS}, 'site': get_site(),
            'ministries': [_data(row) for row in query("SELECT data FROM ministries ORDER BY id")],
            'calendar': list_events(), 'regions': list_regions()}


def replace_content(content):
    """Replace the sections present in `content` (info, faqs, events, groups, staff, locations, sermons, ministries,
    calendar, regions)
    in one transaction. Sections left out are not touched. Items need ids (see church_content.py).
    A ministry that saved connections or requests still point at is kept, so they stay readable."""
    statements = []
    if 'info' in content:
        statements += [
            ("INSERT INTO church_content VALUES ('info', 0, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data",
             (json.dumps(content['info']),)),
            ("UPDATE config SET data = json_set(data, '$.name', ?) WHERE key = 'church'", (content['info']['name'],)),
        ]
    if 'site' in content:
        statements.append(("INSERT INTO church_content VALUES ('site', 0, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data",
                           (json.dumps(content['site']),)))
    for kind in CONTENT_KINDS:
        if kind in content:
            statements.append(("DELETE FROM church_content WHERE kind = ?", (kind,)))
            statements += [("INSERT INTO church_content VALUES (?, ?, ?)", (kind, item['id'], json.dumps(item)))
                           for item in content[kind]]
    if 'ministries' in content:
        keep = [m['id'] for m in content['ministries']]
        statements.append((f"""DELETE FROM ministries WHERE id NOT IN ({', '.join('?' * len(keep)) or 'SELECT NULL WHERE 0'})
            AND id NOT IN (SELECT ministry_id FROM connections)
            AND id NOT IN (SELECT ministry_id FROM requests WHERE ministry_id IS NOT NULL)""", tuple(keep)))
        statements += [("INSERT INTO ministries VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
                        (m['id'], json.dumps(m))) for m in content['ministries']]
    if 'calendar' in content:
        statements.append(("DELETE FROM events", ()))
        statements += [(f"INSERT INTO events (id, {', '.join(EVENT_COLUMNS)}) VALUES (?, {', '.join('?' * len(EVENT_COLUMNS))})",
                        (e['id'], *(e.get(c) for c in EVENT_COLUMNS))) for e in content['calendar']]
    if 'regions' in content:
        keep = [r['id'] for r in content['regions']]
        statements += [("DELETE FROM field_updates", ()),
                       (f"DELETE FROM regions WHERE id NOT IN ({', '.join('?' * len(keep)) or 'SELECT NULL WHERE 0'})", tuple(keep))]
        for region in content['regions']:
            data = {k: v for k, v in region.items() if k != 'updates'}
            statements.append(("INSERT INTO regions VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
                               (region['id'], json.dumps(data))))
            statements += [("INSERT INTO field_updates (id, region_id, date, title, body, author) VALUES (?, ?, ?, ?, ?, ?)",
                            (u.get('id'), region['id'], u['date'], u['title'], u['body'], u['author']))
                           for u in region['updates']]
    if statements:
        run(*statements)
    return export_content()


REQUEST_COLUMNS = "request_id, kind, ministry_id, name, contact, details, status, created_at"


def create_request(kind, name, contact='', details='', ministry_id=None):
    return one(f"""INSERT INTO requests (kind, ministry_id, name, contact, details) VALUES (?, ?, ?, ?, ?)
        RETURNING {REQUEST_COLUMNS}""", (kind, ministry_id, name, contact, details))


def find_pending_request(kind, ministry_id, name):
    return one("""SELECT request_id FROM requests WHERE kind = ? AND ministry_id IS ?
        AND lower(name) = lower(?) AND status = 'pending'""", (kind, ministry_id, name))


def list_requests():
    return query("""SELECT r.*, json_extract(m.data, '$.name') AS ministry_name FROM requests r
        LEFT JOIN ministries m ON m.id = r.ministry_id ORDER BY r.request_id DESC""")


def set_request_status(request_id, status):
    """Approving a connection request also adds it to saved connections, in the same transaction."""
    updated, _ = run(
        (f"UPDATE requests SET status = ? WHERE request_id = ? RETURNING {REQUEST_COLUMNS}", (status, request_id)),
        ("""INSERT INTO connections (ministry_id, member)
            SELECT ministry_id, name FROM requests
            WHERE request_id = ? AND status = 'approved' AND kind = 'connection' AND ministry_id IS NOT NULL
            ON CONFLICT (ministry_id, member) DO NOTHING""", (request_id,)),
    )
    return updated['rows'][0] if updated['rows'] else None


def log_chat(session_id, kind, data):
    query("INSERT INTO chat_log (session_id, kind, data) VALUES (?, ?, ?)", (session_id, kind, json.dumps(data)))


def get_chat_log(session_id):
    rows = query("SELECT kind, data, created_at FROM chat_log WHERE session_id = ? ORDER BY id", (session_id,))
    return [{**row, 'data': _data(row)} for row in rows]


def list_connections():
    rows = query("""SELECT m.data, c.connection_id, c.member FROM connections c
        JOIN ministries m ON m.id = c.ministry_id ORDER BY c.connection_id""")
    return [{**with_shift_coverage(_data(row)), 'connection_id': row['connection_id'], 'member': row['member']} for row in rows]


def save_connection(ministry_id, member):
    ministry = get_ministry(ministry_id)
    if ministry is None:
        return None
    row = one("""INSERT INTO connections (ministry_id, member) VALUES (?, ?)
        ON CONFLICT (ministry_id, member) DO UPDATE SET member = excluded.member
        RETURNING connection_id, member""", (ministry_id, member))
    return {**ministry, **row}


def remove_connection(connection_id):
    return run(("DELETE FROM connections WHERE connection_id = ?", (connection_id,)))[0]['rowsWritten'] > 0


def remove_request(request_id):
    return run(("DELETE FROM requests WHERE request_id = ?", (request_id,)))[0]['rowsWritten'] > 0


# --- Volunteer applications (Church staff → Volunteers → Serving teams) ---

VOLUNTEER_STATUSES = ('new', 'accepted', 'waitlisted', 'declined')


APPLICATION_COLUMNS = 'id, ministry_id, ministry_name, name, email, phone, message, status, note, source, created_at'


def create_volunteer_application(ministry, name, email='', phone='', message='', source='website'):
    return one(f"""INSERT INTO volunteer_applications (ministry_id, ministry_name, name, email, phone, message, source)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING {APPLICATION_COLUMNS}""",
        (ministry['id'], ministry['name'], name, email, phone, message, source))


def find_open_application(ministry_id, email='', phone=''):
    """A new or waitlisted application from the same person for the same team, so it isn't filed twice."""
    return one(f"""SELECT {APPLICATION_COLUMNS} FROM volunteer_applications WHERE ministry_id = ? AND status IN ('new', 'waitlisted')
        AND ((? != '' AND lower(email) = lower(?)) OR (? != '' AND phone = ?))""", (ministry_id, email, email, phone, phone))


def list_volunteer_applications():
    return query(f"SELECT {APPLICATION_COLUMNS} FROM volunteer_applications ORDER BY id DESC")


def review_volunteer_application(application_id, status=None, note=None):
    """Staff set the status and/or a private note. Returns None when there is no such application."""
    sets, params = [], []
    if status is not None:
        sets.append('status = ?'); params.append(status)
    if note is not None:
        sets.append('note = ?'); params.append(note)
    if not sets:
        return one(f"SELECT {APPLICATION_COLUMNS} FROM volunteer_applications WHERE id = ?", (application_id,))
    return one(f"UPDATE volunteer_applications SET {', '.join(sets)} WHERE id = ? RETURNING {APPLICATION_COLUMNS}", (*params, application_id))


def _item(row):
    return {**row, 'done': bool(row['done'])} if row else None


def list_items():
    return [_item(row) for row in query("SELECT id, title, done FROM items ORDER BY id")]


def add_item(title: str):
    return _item(one("INSERT INTO items (title) VALUES (?) RETURNING id, title, done", (title,)))


def set_item_done(item_id: int, done: bool):
    return _item(one("UPDATE items SET done = ? WHERE id = ? RETURNING id, title, done", (done, item_id)))


def delete_item(item_id: int) -> bool:
    return run(("DELETE FROM items WHERE id = ?", (item_id,)))[0]['rowsWritten'] > 0


# --- Church config ---

def get_config():
    return {**DEFAULT_CONFIG, **_data(one("SELECT data FROM config WHERE key = 'church'"))}


def update_config(fields):
    merged = {**get_config(), **{k: v for k, v in fields.items() if k in CONFIG_FIELDS}}
    query("UPDATE config SET data = ? WHERE key = 'church'", (json.dumps(merged),))
    return merged


# --- Pastor Notes ---

NOTE_COLUMNS = "id, title, source_kind, source_url, status, error, duration, word_count, created_at, highlight_engine"


def create_note(note_id, title, source_kind, source_url=None, r2_key=None):
    return one(f"""INSERT INTO notes (id, title, source_kind, source_url, r2_key) VALUES (?, ?, ?, ?, ?)
        RETURNING {NOTE_COLUMNS}""", (note_id, title, source_kind, source_url, r2_key))


def list_notes():
    return query(f"SELECT {NOTE_COLUMNS} FROM notes ORDER BY created_at DESC, id")


def get_note(note_id):
    return one(f"SELECT {NOTE_COLUMNS}, r2_key FROM notes WHERE id = ?", (note_id,))


def get_transcript(note_id):
    return one("SELECT id, title, status, transcript AS text, word_count, duration FROM notes WHERE id = ?", (note_id,))


def list_segments(note_id):
    return query('SELECT idx, start, "end", text FROM segments WHERE note_id = ? ORDER BY idx', (note_id,))


def list_annotations(note_id):
    return query("""SELECT seg_from, seg_to, category, label, confidence FROM annotations
        WHERE note_id = ? ORDER BY seg_from, id""", (note_id,))


def claim_note(note_id, stale_minutes=30):
    """Atomically mark a note as processing. Returns False if another job holds it."""
    row = one(f"""UPDATE notes SET status = 'processing', error = NULL, started_at = {NOW}
        WHERE id = ? AND (status IN ('queued', 'failed')
            OR (status = 'processing' AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)))
        RETURNING id""", (note_id, f'-{stale_minutes} minutes'))
    return row is not None


def queue_note(note_id):
    """Put a failed note back in the queue. Returns False if it is queued, running, or ready."""
    return one("UPDATE notes SET status = 'queued', error = NULL WHERE id = ? AND status = 'failed' RETURNING id",
               (note_id,)) is not None


def fail_note(note_id, error):
    query("UPDATE notes SET status = 'failed', error = ? WHERE id = ?", (error[:300], note_id))


def save_transcript(note_id, segments, chunks, duration, annotations=(), highlight_engine=''):
    """Replace a note's segments, chunks and annotations and mark it ready, in one transaction.
    highlight_engine names the model(s) that tagged the annotations (for example gloo:gloo-qwen-3.7-flash)."""
    text = ' '.join(s['text'] for s in segments).strip()
    statements = [("DELETE FROM segments WHERE note_id = ?", (note_id,)),
                  ("DELETE FROM chunks WHERE note_id = ?", (note_id,)),
                  ("DELETE FROM annotations WHERE note_id = ?", (note_id,))]
    statements += [('INSERT INTO segments (note_id, idx, start, "end", text) VALUES (?, ?, ?, ?, ?)',
                    (note_id, i, s['start'], s['end'], s['text'])) for i, s in enumerate(segments)]
    # A chunk without a vector (embeddings were unavailable) is stored with '' for both; the Worker embeds it later.
    statements += [('INSERT INTO chunks (note_id, idx, start, "end", seg_from, seg_to, text, embedding, embed_model) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (note_id, i, c['start'], c['end'], c['seg_from'], c['seg_to'], c['text'],
                     *((json.dumps(c['embedding']), c.get('embed_model') or '') if c.get('embedding') else ('', ''))))
                   for i, c in enumerate(chunks)]
    statements += [('INSERT INTO annotations (note_id, seg_from, seg_to, category, label, confidence) '
                    'VALUES (?, ?, ?, ?, ?, ?)',
                    (note_id, a['seg_from'], a['seg_to'], a['category'], a['label'], a['confidence']))
                   for a in annotations]
    statements.append(("""UPDATE notes SET status = 'ready', error = NULL, transcript = ?, duration = ?, word_count = ?,
        highlight_engine = ? WHERE id = ?""", (text, duration, len(text.split()), highlight_engine or '', note_id)))
    run(*statements)


def replace_annotations(note_id, annotations, highlight_engine):
    """Replace a note's annotations and record which model tagged them, in one transaction."""
    statements = [("DELETE FROM annotations WHERE note_id = ?", (note_id,))]
    statements += [('INSERT INTO annotations (note_id, seg_from, seg_to, category, label, confidence) '
                    'VALUES (?, ?, ?, ?, ?, ?)',
                    (note_id, a['seg_from'], a['seg_to'], a['category'], a['label'], a['confidence']))
                   for a in annotations]
    statements.append(("UPDATE notes SET highlight_engine = ? WHERE id = ?", (highlight_engine or '', note_id)))
    run(*statements)


def set_highlight_engine(note_id, highlight_engine):
    query("UPDATE notes SET highlight_engine = ? WHERE id = ?", (highlight_engine, note_id))


def delete_note(note_id):
    """Delete a note unless a job is running on it. Returns (deleted_row_or_None, busy)."""
    row = get_note(note_id)
    if row is None:
        return None, False
    if row['status'] == 'processing':
        return row, True
    run(("DELETE FROM segments WHERE note_id = ?", (note_id,)),
        ("DELETE FROM chunks WHERE note_id = ?", (note_id,)),
        ("DELETE FROM annotations WHERE note_id = ?", (note_id,)),
        ("DELETE FROM notes WHERE id = ?", (note_id,)))
    return row, False


def queued_note_ids():
    return [row['id'] for row in query("SELECT id FROM notes WHERE status = 'queued' ORDER BY created_at")]

# --- Calendar events ---


def list_events():
    return query("""SELECT id, title, category, date, time, location, ministry_name, description, ai_summary
        FROM events ORDER BY date ASC, time ASC""")


def get_event(event_id):
    return one("""SELECT id, title, category, date, time, location, ministry_name, description, ai_summary
        FROM events WHERE id = ?""", (event_id,))


def update_event_summary(event_id, ai_summary):
    return one("""UPDATE events SET ai_summary = ? WHERE id = ?
        RETURNING id, title, category, date, time, location, ministry_name, description, ai_summary""",
               (ai_summary, event_id))


def delete_event(event_id):
    """Remove one calendar event. True if it existed."""
    return one("DELETE FROM events WHERE id = ? RETURNING id", (event_id,)) is not None


def create_event(title, category, date, time, location, description, ministry_name=None, ai_summary=None):
    return one("""INSERT INTO events (title, category, date, time, location, ministry_name, description, ai_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id, title, category, date, time, location, ministry_name, description, ai_summary""",
               (title, category, date, time, location, ministry_name, description, ai_summary))


# --- First-time guest visits ---

STAFF_VISIT_COLUMNS = "visit_id, name, contact, service, party_size, kids, wants_host, status, host, created_at, arrived_at"


def create_visit(name, contact, service, party_size, kids, wants_host):
    token = secrets.token_urlsafe(16)
    return one(f"""INSERT INTO visits (token, name, contact, service, party_size, kids, wants_host)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING *""", (token, name, contact, service, party_size, kids, int(wants_host)))


def get_visit_by_token(token):
    return one("SELECT * FROM visits WHERE token = ?", (token,))


def mark_arrived(token):
    return one(f"""UPDATE visits SET status = 'arrived', arrived_at = {NOW}
        WHERE token = ? AND status = 'planned'
        RETURNING *""", (token,))


def list_visits(statuses):
    placeholders = ', '.join('?' * len(statuses))
    return query(f"""SELECT {STAFF_VISIT_COLUMNS} FROM visits
        WHERE status IN ({placeholders}) ORDER BY arrived_at, created_at""", tuple(statuses))


def list_planned_visits(limit=20):
    return query(f"""SELECT {STAFF_VISIT_COLUMNS} FROM visits
        WHERE status = 'planned' AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
        ORDER BY created_at DESC LIMIT ?""", (limit,))


def set_visit_host(visit_id, host):
    return one(f"""UPDATE visits SET status = 'on_the_way', host = ?
        WHERE visit_id = ? AND status = 'arrived'
        RETURNING {STAFF_VISIT_COLUMNS}""", (host, visit_id))


def mark_met(visit_id):
    return one(f"""UPDATE visits SET status = 'met'
        WHERE visit_id = ? AND status IN ('arrived', 'on_the_way')
        RETURNING {STAFF_VISIT_COLUMNS}""", (visit_id,))


# --- Prayer map: regions, field updates, and news ---


def _field_update(row):
    return {'id': row['id'], 'date': row['date'], 'title': row['title'], 'body': row['body'], 'author': row['author']}


def _updates_by_region():
    """Every region's field updates, newest first."""
    out = {}
    for row in query("SELECT id, region_id, date, title, body, author FROM field_updates ORDER BY date DESC, id DESC"):
        out.setdefault(row['region_id'], []).append(_field_update(row))
    return out


def list_regions():
    updates = _updates_by_region()
    regions = [_data(row) for row in query("SELECT data FROM regions ORDER BY id")]
    return [{**region, 'updates': updates.get(region['id'], [])} for region in regions]


def get_region(region_id):
    return next((r for r in list_regions() if r['id'] == region_id), None)


def _move_connection_requests_to_applications():
    """Team requests the chat filed for the old Serve > Saved inbox become volunteer applications, once
    (legacy_request_id is unique), so staff still review them in Church staff → Volunteers."""
    run(("""INSERT OR IGNORE INTO volunteer_applications
            (ministry_id, ministry_name, name, email, phone, message, status, source, legacy_request_id, created_at)
        SELECT r.ministry_id, COALESCE(json_extract(m.data, '$.name'), 'A serving team'), r.name,
            CASE WHEN instr(r.contact, '@') THEN r.contact ELSE '' END,
            CASE WHEN instr(r.contact, '@') THEN '' ELSE r.contact END,
            r.details, CASE r.status WHEN 'approved' THEN 'accepted' WHEN 'declined' THEN 'declined' ELSE 'new' END,
            'chat', r.request_id, r.created_at
        FROM requests r LEFT JOIN ministries m ON m.id = r.ministry_id
        WHERE r.kind = 'connection' AND r.ministry_id IS NOT NULL""", ()))


def _move_testimonies_to_updates():
    """Older regions kept one `testimony` string; make it the region's first dated update."""
    old = [(row['id'], _data(row)) for row in query("SELECT id, data FROM regions WHERE data LIKE '%\"testimony\"%'")]
    statements = []
    for region_id, region in old:
        testimony = region.pop('testimony', '')
        if testimony and not one("SELECT 1 FROM field_updates WHERE region_id = ?", (region_id,)):
            statements.append(("INSERT INTO field_updates (region_id, date, title, body, author) VALUES (?, ?, '', ?, '')",
                               (region_id, datetime.date.today().isoformat(), testimony)))
        statements.append(("UPDATE regions SET data = ? WHERE id = ?", (json.dumps(region), region_id)))
    if statements:
        run(*statements)


def list_news():
    return [_data(row) for row in query("SELECT data FROM news_events ORDER BY id")]


def _live_news():
    live_file = Path(__file__).with_name('news_live.json')
    return json.loads(live_file.read_text(encoding='utf-8')) if live_file.exists() else []


def replace_news(items, snapshot=None):
    """Replace every news row of the current church with `items`, in one transaction. `snapshot` records
    which shipped news_live.json this was, so startup does not apply the same snapshot again."""
    marker = [("INSERT INTO config VALUES ('news_snapshot', ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data",
               (json.dumps(snapshot),))] if snapshot else []
    run(("DELETE FROM news_events", ()),
        *[("INSERT INTO news_events VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
           (item['id'], json.dumps(item))) for item in items],
        *marker)


# --- Blog posts ---

BLOG_COLUMNS = "id, title, content, author, categories, bullet_summary, created_at, updated_at, kind, link_url, link_label"
POST_KINDS = ('update', 'article')


def _format_blog_post(row):
    if not row:
        return None
    categories = row.get("categories")
    if isinstance(categories, str):
        try:
            categories = json.loads(categories)
        except Exception:
            categories = [categories] if categories else []
    elif not isinstance(categories, list):
        categories = []

    bullet_summary = row.get("bullet_summary")
    if isinstance(bullet_summary, str):
        try:
            parsed = json.loads(bullet_summary)
            if isinstance(parsed, list):
                bullet_summary = parsed
            else:
                bullet_summary = [s.strip() for s in bullet_summary.split("\n") if s.strip()]
        except Exception:
            bullet_summary = [s.strip() for s in bullet_summary.split("\n") if s.strip()]
    elif not isinstance(bullet_summary, list):
        bullet_summary = []

    kind = row.get("kind") if row.get("kind") in POST_KINDS else "article"
    return {
        "id": row["id"],
        "kind": kind,
        "title": row["title"],
        "content": row["content"],
        "author": row.get("author") or "Church Staff",
        "categories": categories,
        # Updates are short enough to read whole; only articles carry key takeaways.
        "bullet_summary": bullet_summary if kind == "article" else [],
        "link_url": row.get("link_url") or "",
        "link_label": row.get("link_label") or "",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def list_blog_posts(category: str | None = None, kind: str | None = None):
    rows = query(f"SELECT {BLOG_COLUMNS} FROM blog_posts ORDER BY created_at DESC, id DESC")
    posts = [_format_blog_post(r) for r in rows]
    if kind in POST_KINDS:
        posts = [p for p in posts if p["kind"] == kind]
    if category and category.strip():
        cat_lower = category.strip().lower()
        posts = [p for p in posts if any(cat_lower == c.lower() for c in p["categories"])]
    return posts


def get_blog_post(post_id: int):
    row = one(f"SELECT {BLOG_COLUMNS} FROM blog_posts WHERE id = ?", (post_id,))
    return _format_blog_post(row)


def create_blog_post(title: str, content: str, author: str, categories: list[str], bullet_summary: list[str] | None = None,
                     kind: str = 'article', link_url: str = '', link_label: str = ''):
    kind = kind if kind in POST_KINDS else 'article'
    cats_json = json.dumps(categories if isinstance(categories, list) else [])
    summary_json = json.dumps(bullet_summary if kind == 'article' and isinstance(bullet_summary, list) else [])
    row = one(f"""INSERT INTO blog_posts (title, content, author, categories, bullet_summary, kind, link_url, link_label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, {NOW}, {NOW})
        RETURNING {BLOG_COLUMNS}""", (title.strip(), content.strip(), author.strip() or "Church Staff", cats_json, summary_json,
                                      kind, link_url.strip(), link_label.strip()))
    return _format_blog_post(row)


def update_blog_post_summary(post_id: int, bullet_summary: list[str]):
    summary_json = json.dumps(bullet_summary if isinstance(bullet_summary, list) else [])
    row = one(f"""UPDATE blog_posts SET bullet_summary = ?, updated_at = {NOW}
        WHERE id = ?
        RETURNING {BLOG_COLUMNS}""", (summary_json, post_id))
    return _format_blog_post(row)


def delete_blog_post(post_id: int):
    return run(("DELETE FROM blog_posts WHERE id = ?", (post_id,)))[0]['rowsWritten'] > 0


def list_blog_categories():
    posts = list_blog_posts()
    unique_cats = set()
    for p in posts:
        for cat in p.get("categories", []):
            if cat.strip():
                unique_cats.add(cat.strip())
    return sorted(unique_cats)

