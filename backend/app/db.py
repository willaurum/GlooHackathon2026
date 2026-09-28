"""Everything that touches SQL lives here.

The database is a SQLite Durable Object. It's reached over HTTP at CHURCH_DB_URL
(the Worker routes the `church-db` host to it). Each call sends a batch of
{sql, params} statements; the Durable Object runs a batch as one transaction.
"""

import os
import json
from pathlib import Path

import httpx

CHURCH_DB_URL = os.environ.get("CHURCH_DB_URL", "http://church-db")

_client = httpx.Client(base_url=CHURCH_DB_URL, timeout=30)

NOW = "(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
CONFIG_FIELDS = ('name', 'timezone', 'default_language')
DEFAULT_CONFIG = {'name': 'Our Church', 'timezone': 'UTC', 'default_language': 'en'}


def run(*statements):
    """Run [(sql, params), ...] as one transaction. Returns one result per statement:
    {'rows': [...], 'rowsWritten': n}."""
    batch = [{'sql': sql, 'params': [int(p) if isinstance(p, bool) else p for p in params]}
             for sql, params in statements]
    response = _client.post('/sql', json={'batch': batch})
    response.raise_for_status()
    return response.json()['results']


def query(sql, params=()):
    return run((sql, params))[0]['rows']


def one(sql, params=()):
    rows = query(sql, params)
    return rows[0] if rows else None


def close():
    _client.close()


def _data(row):
    """JSON columns are stored as TEXT."""
    return json.loads(row['data'])


def initialize():
    """Create tables and seed content without resetting user data. One batch."""
    ministries = json.loads(Path(__file__).with_name('ministries.json').read_text(encoding='utf-8'))
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
            created_at TEXT NOT NULL DEFAULT {NOW}
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
            PRIMARY KEY (note_id, idx)
        )""", ()),
        ("INSERT OR IGNORE INTO config VALUES ('church', ?)", (json.dumps(DEFAULT_CONFIG),)),
        # A restart interrupts any job that was running; let it be retried.
        ("UPDATE notes SET status = 'failed', error = 'interrupted' WHERE status = 'processing'", ()),
    ]
    statements += [("INSERT OR IGNORE INTO ministries VALUES (?, ?)", (m['id'], json.dumps(m))) for m in ministries]
    statements.append(("INSERT INTO items (title, done) SELECT 'Stand up the docker stack', 1 "
                       "WHERE NOT EXISTS (SELECT 1 FROM items) UNION ALL "
                       "SELECT 'Build something on top of it', 0 WHERE NOT EXISTS (SELECT 1 FROM items)", ()))
    run(*statements)


def list_ministries():
    return [_data(row) for row in query("SELECT data FROM ministries ORDER BY id")]


def get_ministry(ministry_id):
    row = one("SELECT data FROM ministries WHERE id = ?", (ministry_id,))
    return _data(row) if row else None


def list_connections():
    rows = query("""SELECT m.data, c.connection_id, c.member FROM connections c
        JOIN ministries m ON m.id = c.ministry_id ORDER BY c.connection_id""")
    return [{**_data(row), 'connection_id': row['connection_id'], 'member': row['member']} for row in rows]


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

NOTE_COLUMNS = "id, title, source_kind, source_url, status, error, duration, word_count, created_at"


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


def save_transcript(note_id, segments, chunks, duration):
    """Replace a note's segments and chunks and mark it ready, in one transaction."""
    text = ' '.join(s['text'] for s in segments).strip()
    statements = [("DELETE FROM segments WHERE note_id = ?", (note_id,)),
                  ("DELETE FROM chunks WHERE note_id = ?", (note_id,))]
    statements += [('INSERT INTO segments (note_id, idx, start, "end", text) VALUES (?, ?, ?, ?, ?)',
                    (note_id, i, s['start'], s['end'], s['text'])) for i, s in enumerate(segments)]
    statements += [('INSERT INTO chunks (note_id, idx, start, "end", seg_from, seg_to, text, embedding) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (note_id, i, c['start'], c['end'], c['seg_from'], c['seg_to'], c['text'], json.dumps(c['embedding'])))
                   for i, c in enumerate(chunks)]
    statements.append(("""UPDATE notes SET status = 'ready', error = NULL, transcript = ?, duration = ?, word_count = ?
        WHERE id = ?""", (text, duration, len(text.split()), note_id)))
    run(*statements)


def delete_note(note_id):
    """Delete a note unless a job is running on it. Returns (deleted_row_or_None, busy)."""
    row = get_note(note_id)
    if row is None:
        return None, False
    if row['status'] == 'processing':
        return row, True
    run(("DELETE FROM segments WHERE note_id = ?", (note_id,)),
        ("DELETE FROM chunks WHERE note_id = ?", (note_id,)),
        ("DELETE FROM notes WHERE id = ?", (note_id,)))
    return row, False


def queued_note_ids():
    return [row['id'] for row in query("SELECT id FROM notes WHERE status = 'queued' ORDER BY created_at")]
