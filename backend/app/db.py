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
        conn.execute("""CREATE TABLE IF NOT EXISTS events (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            date DATE NOT NULL,
            time TEXT NOT NULL,
            location TEXT NOT NULL,
            ministry_name TEXT,
            description TEXT NOT NULL,
            ai_summary TEXT
        )""")
        for ministry in json.loads(Path(__file__).with_name('ministries.json').read_text(encoding='utf-8')):
            conn.execute("INSERT INTO ministries VALUES (%s, %s) ON CONFLICT DO NOTHING",
                         (ministry['id'], Jsonb(ministry)))
        events_file = Path(__file__).with_name('events.json')
        if events_file.exists():
            for event in json.loads(events_file.read_text(encoding='utf-8')):
                conn.execute("""INSERT INTO events (id, title, category, date, time, location, ministry_name, description, ai_summary)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO NOTHING""",
                    (event['id'], event['title'], event['category'], event['date'], event['time'],
                     event['location'], event.get('ministry_name'), event['description'], event.get('ai_summary')))
            conn.execute("SELECT setval(pg_get_serial_sequence('events', 'id'), coalesce(max(id), 1)) FROM events")


def list_ministries():
    with pool.connection() as conn:
        return [row['data'] for row in conn.execute("SELECT data FROM ministries ORDER BY id").fetchall()]


def list_connections():
    with pool.connection() as conn:
        rows = conn.execute("""SELECT m.data, c.connection_id, c.member FROM connections c
            JOIN ministries m ON m.id = c.ministry_id ORDER BY c.connection_id""").fetchall()
        return [{**row['data'], 'connection_id': row['connection_id'], 'member': row['member']} for row in rows]


def save_connection(ministry_id, member):
    with pool.connection() as conn:
        ministry = conn.execute("SELECT data FROM ministries WHERE id = %s", (ministry_id,)).fetchone()
        if ministry is None:
            return None
        row = conn.execute("""INSERT INTO connections (ministry_id, member) VALUES (%s, %s)
            ON CONFLICT (ministry_id, member) DO UPDATE SET member = EXCLUDED.member
            RETURNING connection_id, member""", (ministry_id, member)).fetchone()
        return {**ministry['data'], **row}


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


def list_events():
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id, title, category, date, time, location, ministry_name, description, ai_summary FROM events ORDER BY date ASC, time ASC"
        ).fetchall()
        return [
            {
                **row,
                "date": row["date"].isoformat()
                if hasattr(row["date"], "isoformat")
                else str(row["date"]),
            }
            for row in rows
        ]


def get_event(event_id: int):
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT id, title, category, date, time, location, ministry_name, description, ai_summary FROM events WHERE id = %s",
            (event_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            **row,
            "date": row["date"].isoformat()
            if hasattr(row["date"], "isoformat")
            else str(row["date"]),
        }


def update_event_summary(event_id: int, ai_summary: str):
    with pool.connection() as conn:
        row = conn.execute(
            "UPDATE events SET ai_summary = %s WHERE id = %s RETURNING id, title, category, date, time, location, ministry_name, description, ai_summary",
            (ai_summary, event_id),
        ).fetchone()
        if row is None:
            return None
        return {
            **row,
            "date": row["date"].isoformat()
            if hasattr(row["date"], "isoformat")
            else str(row["date"]),
        }


def create_event(
    title: str,
    category: str,
    date: str,
    time: str,
    location: str,
    description: str,
    ministry_name: str = None,
    ai_summary: str = None,
):
    with pool.connection() as conn:
        row = conn.execute(
            """INSERT INTO events (title, category, date, time, location, ministry_name, description, ai_summary)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, title, category, date, time, location, ministry_name, description, ai_summary""",
            (
                title,
                category,
                date,
                time,
                location,
                ministry_name,
                description,
                ai_summary,
            ),
        ).fetchone()
        return {
            **row,
            "date": row["date"].isoformat()
            if hasattr(row["date"], "isoformat")
            else str(row["date"]),
        }
