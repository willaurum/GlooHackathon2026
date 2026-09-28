# GlooHackathon2026

Liberty University's Gloo Hackathon Team Repository

A minimal three-service web app, all in Docker:

```
frontend  React (Vite) served by nginx, proxies /api -> backend
backend   FastAPI
db        Postgres
```

## Run it

```bash
docker compose up --build
```

Then open <http://localhost:3000>. The API is at <http://localhost:8000/api/health>,
with interactive docs at <http://localhost:8000/docs>.

Defaults work out of the box — copy `.env.example` to `.env` only if you want to
change the database credentials.

## What each piece does

| Path | What's in it |
|---|---|
| `frontend/src/App.jsx` | The Belong dashboard, matching form, and saved connections. |
| `frontend/nginx.conf` | Serves the built bundle, sends `/api` to the backend. |
| `backend/app/main.py` | The HTTP routes — list, add, toggle, delete. |
| `backend/app/db.py` | Connection pool and the SQL queries. |
| `db/init.sql` | Schema, applied the first time the Postgres volume is created. |

## Notes

- Postgres and the backend publish ports (5432, 8000) so you can poke at them
  directly. Only port 3000 is needed to use the app — drop the others from
  `docker-compose.yml` if you'd rather not expose them.
- The Postgres data lives in the `db_data` volume. `docker compose down -v`
  wipes it and re-runs `db/init.sql` on the next start.
- Changing `db/init.sql` after the first start does nothing until you drop that
  volume — it only runs on an empty data directory.

## Belong prototype

The React frontend now uses FastAPI and Postgres. Six fictional ministries are seeded from `backend/app/ministries.json` on first backend startup. Startup creates the new tables on existing volumes without deleting data; existing ministry records are not overwritten by subsequent seed runs.

- `GET /api/ministries`: departments, responsibilities, coverage, and sample contacts.
- `POST /api/matches`: member name, skills, serving style, and availability; returns the top three open ministries.
- `GET /api/connections`: saved connections shared across this prototype workspace.
- `POST /api/connections`: save `{ "ministry_id": 1, "member": "Jamie" }`; repeated saves are deduplicated by ministry and member name.
- `DELETE /api/connections/{connection_id}`: remove a saved connection.

Matching currently uses simple backend rules, not Gloo AI. Replacing that ranking with Gloo is the next integration step. Sample contacts use example.com; no introductions are sent. This is a single shared demo workspace without login or user isolation. Members with the same name are treated as the same person for duplicate saves.

Saved connections survive page refreshes and container restarts through the existing Postgres volume. Removing the volume deletes them. There is no ministry editor yet; seed content is starter data, while the database is the runtime source of truth.

Run `docker compose up --build -d`, then open http://localhost:3000. For frontend development, keep the backend and database running and run `npm install` and `npm run dev` in `frontend`; Vite proxies API calls to port 8000.

## Pastor Notes API (Cloudflare)

Turn a sermon video (YouTube link or uploaded file) into a stored transcript, then ask
questions that are answered only from what was said, with timestamped citations.

```
api/        Worker: auth, uploads to R2, grounded Q&A, and the ChurchDB (SQLite Durable Object)
backend/    FastAPI container: yt-dlp + ffmpeg ingest, Workers AI transcription, the other routes
frontend/   Preview site, with a Pastor Notes page (deployed from the root wrangler.jsonc)
```

Models (Workers AI, no key needed): `@cf/openai/whisper-large-v3-turbo` (speech to text),
`@cf/baai/bge-base-en-v1.5` (embeddings), and optionally `@cf/meta/llama-3.1-8b-instruct-fp8`
for written answers.

### Endpoints

Every `/api/*` route except `/api/health` needs an `X-API-Key` header.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | No key needed |
| GET | `/api/church` | This deploy's church config |
| PUT | `/api/admin/config` | Needs `X-Admin-Key` too. Fields: `name`, `timezone`, `default_language` |
| POST | `/api/notes` | `{"title", "youtube_url"}` → 202 |
| POST | `/api/notes/upload?title=` | Raw `video/*` or `audio/*` body, up to 95 MB → 202 |
| GET | `/api/notes`, `/api/notes/:id` | List, or one note's status |
| GET | `/api/notes/:id/transcript`, `/api/notes/:id/segments` | Once the note is `ready` |
| POST | `/api/notes/:id/ask` | `{"question"}` → `{found, answer, citations, engine}` |
| POST | `/api/notes/:id/retry` | Failed notes only |
| DELETE | `/api/notes/:id` | Also deletes the uploaded file |

### How answers stay grounded

A transcript chunk supports a question only if it is close in meaning **and** shares a topic
word with the question. With nothing supporting it, the answer is "Not found in this note."
By default (`NOTES_ANSWER_ENGINE=extractive`) the answer is the matching transcript sentences,
word for word, each with its timestamp. With `workers-ai` (or a `GEMINI_API_KEY` secret) a model writes the answer, and it is only
used if every quote it cites is really in the transcript and its topic words come from the cited
passages; otherwise (or if the model finds nothing) the verbatim answer is returned.

### Deploy (one church per deploy)

Church details live in the database, not the code; keys are Workers secrets.

```bash
cd api && npm install
npx wrangler r2 bucket create gloo-hackathon2026-pastor-notes-media
npx wrangler deploy
npx wrangler secret put NOTES_API_KEY       # required; the API returns 503 until it is set
npx wrangler secret put NOTES_ADMIN_KEY     # optional; enables PUT /api/admin/config
npx wrangler secret put YTDLP_COOKIES       # optional; YouTube cookies.txt if YouTube blocks downloads
cd ../frontend && VITE_API_BASE=https://<api-worker-url> npm run build && cd .. && npx --prefix api wrangler deploy
```

YouTube sometimes blocks downloads from cloud servers; the note then fails with
`youtube_blocked`. Upload the file instead, or set `YTDLP_COOKIES`.

For local development of this branch use `cd api && npx wrangler dev`; `docker compose`
still expects Postgres.
