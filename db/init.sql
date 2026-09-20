-- Runs once, the first time the postgres volume is created.

CREATE TABLE IF NOT EXISTS items (
    id         SERIAL PRIMARY KEY,
    title      TEXT      NOT NULL,
    done       BOOLEAN   NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO items (title, done) VALUES
    ('Stand up the docker stack', TRUE),
    ('Build something on top of it', FALSE);
