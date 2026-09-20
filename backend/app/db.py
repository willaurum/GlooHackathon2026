"""Everything that touches SQL lives here."""

import os

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
