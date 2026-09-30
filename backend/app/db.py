"""Everything that touches SQL lives here."""

import os
import json
from pathlib import Path

from psycopg.types.json import Jsonb

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://gloo:gloo@db:5432/gloo"
)

# open=False so importing this module doesn't require the DB to be up yet;
# main.py opens the pool on startup.
pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=5,
    open=False,
    kwargs={"row_factory": dict_row},
)


def initialize():
    """Add prototype tables on existing volumes without resetting user data."""
    with pool.connection() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS ministries (id INTEGER PRIMARY KEY, data JSONB NOT NULL)")
        conn.execute("""CREATE TABLE IF NOT EXISTS connections (
            connection_id SERIAL PRIMARY KEY,
            ministry_id INTEGER NOT NULL REFERENCES ministries(id),
            member TEXT NOT NULL,
            UNIQUE (ministry_id, member)
        )""")
        for ministry in json.loads(Path(__file__).with_name('ministries.json').read_text(encoding='utf-8')):
            conn.execute("INSERT INTO ministries VALUES (%s, %s) ON CONFLICT DO NOTHING",
                         (ministry['id'], Jsonb(ministry)))
            # Backfill only missing shifts; preserve all other existing ministry data.
            conn.execute("""UPDATE ministries SET data = jsonb_set(data, '{shifts}', %s)
                WHERE id = %s AND NOT (data ? 'shifts')""",
                (Jsonb(ministry['shifts']), ministry['id']))
        # Church info, FAQs, events and small groups the chat agent can look up.
        conn.execute("""CREATE TABLE IF NOT EXISTS church_content (
            kind TEXT NOT NULL,
            id INTEGER NOT NULL,
            data JSONB NOT NULL,
            PRIMARY KEY (kind, id)
        )""")
        church = json.loads(Path(__file__).with_name('church.json').read_text(encoding='utf-8'))
        conn.execute("INSERT INTO church_content VALUES ('info', 0, %s) ON CONFLICT DO NOTHING", (Jsonb(church['info']),))
        for kind in ('faqs', 'events', 'groups'):
            for item in church[kind]:
                conn.execute("INSERT INTO church_content VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                             (kind, item['id'], Jsonb(item)))
        # Requests filed by the chat agent. Nothing happens until staff approve them.
        conn.execute("""CREATE TABLE IF NOT EXISTS requests (
            request_id SERIAL PRIMARY KEY,
            kind TEXT NOT NULL,
            ministry_id INTEGER REFERENCES ministries(id),
            name TEXT NOT NULL,
            contact TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
        # Audit log of every chat turn and tool call.
        conn.execute("""CREATE TABLE IF NOT EXISTS chat_log (
            id SERIAL PRIMARY KEY,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            data JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")


def with_shift_coverage(ministry):
    """Keep existing API coverage fields grounded in the scheduled positions."""
    if 'shifts' not in ministry:
        return ministry
    return {**ministry,
            'filled': sum(shift['filled'] for shift in ministry['shifts']),
            'total': sum(shift['total'] for shift in ministry['shifts'])}


def list_ministries():
    with pool.connection() as conn:
        return [with_shift_coverage(row['data']) for row in conn.execute("SELECT data FROM ministries ORDER BY id").fetchall()]


def get_ministry(ministry_id):
    with pool.connection() as conn:
        row = conn.execute("SELECT data FROM ministries WHERE id = %s", (ministry_id,)).fetchone()
        return with_shift_coverage(row['data']) if row else None


def get_church_info():
    with pool.connection() as conn:
        return conn.execute("SELECT data FROM church_content WHERE kind = 'info'").fetchone()['data']


def list_content(kind):
    with pool.connection() as conn:
        rows = conn.execute("SELECT data FROM church_content WHERE kind = %s ORDER BY id", (kind,)).fetchall()
        return [row['data'] for row in rows]


def create_request(kind, name, contact='', details='', ministry_id=None):
    with pool.connection() as conn:
        return conn.execute("""INSERT INTO requests (kind, ministry_id, name, contact, details)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING request_id, kind, ministry_id, name, contact, details, status, created_at""",
            (kind, ministry_id, name, contact, details)).fetchone()


def find_pending_request(kind, ministry_id, name):
    with pool.connection() as conn:
        return conn.execute("""SELECT request_id FROM requests WHERE kind = %s AND ministry_id IS NOT DISTINCT FROM %s
            AND lower(name) = lower(%s) AND status = 'pending'""", (kind, ministry_id, name)).fetchone()


def list_requests():
    with pool.connection() as conn:
        rows = conn.execute("""SELECT r.*, m.data->>'name' AS ministry_name FROM requests r
            LEFT JOIN ministries m ON m.id = r.ministry_id ORDER BY r.request_id DESC""").fetchall()
        return rows


def set_request_status(request_id, status):
    """Approving a connection request also adds it to saved connections."""
    with pool.connection() as conn:
        row = conn.execute("UPDATE requests SET status = %s WHERE request_id = %s RETURNING *",
                           (status, request_id)).fetchone()
        if row and status == 'approved' and row['kind'] == 'connection':
            conn.execute("""INSERT INTO connections (ministry_id, member) VALUES (%s, %s)
                ON CONFLICT (ministry_id, member) DO NOTHING""", (row['ministry_id'], row['name']))
        return row


def log_chat(session_id, kind, data):
    with pool.connection() as conn:
        conn.execute("INSERT INTO chat_log (session_id, kind, data) VALUES (%s, %s, %s)",
                     (session_id, kind, Jsonb(data)))


def get_chat_log(session_id):
    with pool.connection() as conn:
        return conn.execute("SELECT kind, data, created_at FROM chat_log WHERE session_id = %s ORDER BY id",
                            (session_id,)).fetchall()


def list_connections():
    with pool.connection() as conn:
        rows = conn.execute("""SELECT m.data, c.connection_id, c.member FROM connections c
            JOIN ministries m ON m.id = c.ministry_id ORDER BY c.connection_id""").fetchall()
        return [{**with_shift_coverage(row['data']), 'connection_id': row['connection_id'], 'member': row['member']} for row in rows]


def save_connection(ministry_id, member):
    with pool.connection() as conn:
        ministry = conn.execute("SELECT data FROM ministries WHERE id = %s", (ministry_id,)).fetchone()
        if ministry is None:
            return None
        row = conn.execute("""INSERT INTO connections (ministry_id, member) VALUES (%s, %s)
            ON CONFLICT (ministry_id, member) DO UPDATE SET member = EXCLUDED.member
            RETURNING connection_id, member""", (ministry_id, member)).fetchone()
        return {**with_shift_coverage(ministry['data']), **row}


def remove_connection(connection_id):
    with pool.connection() as conn:
        return conn.execute("DELETE FROM connections WHERE connection_id = %s", (connection_id,)).rowcount > 0


def list_items():
    with pool.connection() as conn:
        return conn.execute(
            "SELECT id, title, done FROM items ORDER BY id"
        ).fetchall()


def add_item(title: str):
    with pool.connection() as conn:
        return conn.execute(
            "INSERT INTO items (title) VALUES (%s) RETURNING id, title, done",
            (title,),
        ).fetchone()


def set_item_done(item_id: int, done: bool):
    with pool.connection() as conn:
        return conn.execute(
            "UPDATE items SET done = %s WHERE id = %s RETURNING id, title, done",
            (done, item_id),
        ).fetchone()


def delete_item(item_id: int) -> bool:
    with pool.connection() as conn:
        cur = conn.execute("DELETE FROM items WHERE id = %s", (item_id,))
        return cur.rowcount > 0
