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

## Prayer map prototype

A second page, "Prayer map," explores a different aesthetic and a three-stage AI pipeline. It deliberately avoids a photorealistic "God's Eye View" globe in favor of a soft, low-fidelity map (a keyless CARTO basemap, desaturated via a CSS filter scoped to the tile layer only) — reflective rather than tactical. The visual rule is **sharp facts, soft people**: real news events get exact pins on real cities; missionary presence only ever gets a soft glowing shape drawn over an entire country, with no exact point, city, or name — a privacy constraint enforced by the schema itself (`RegionOut` forbids extra fields and simply has no coordinate field to leak).

- `GET /api/regions`: fictional missionary "presence" regions — country, codename, field of ministry, and testimony. No coordinates.
- `GET /api/news`: regional news pinned on each country's capital. Real headlines from `backend/app/news_live.json` (see below) when that snapshot exists; otherwise curated, fictional events seeded from `backend/app/news.json` as the offline fallback.
- `POST /api/news/refresh`: pulls live English stories for the six region countries from NewsData.io (`NEWSDATA_API_KEY`, free key), asks the team's Ollama server (SSH tunnel; `OLLAMA_BASE_URL` / `OLLAMA_MODEL`, see `.env.example`; Gloo/OpenAI/Anthropic selectable with `AI_PROVIDER`) for a one-sentence summary of each, and replaces all current news rows. If no provider answers, each summary is the article's own description. For a reliable demo, pre-fetch a snapshot instead: `cd backend && python -m scripts.fetch_news` writes `backend/app/news_live.json`, which the backend loads on every start.
- `GET /api/regions/{region_id}/prayer-angles`: the history of generated summaries/prayer points for a region.
- `POST /api/regions/{region_id}/prayer-angles`: runs the three-stage pipeline — retrieval (news filtered by the region's country), synthesis (`backend/app/ai.py`, currently a stubbed templating function standing in for a future LLM call), and returns a new situational summary + specific prayer points slanted toward a fresh angle (safety, provision, gospel access, endurance, or local relationships). Powers the "Generate another angle" button.

Angle history is shared workspace-wide and persists in Postgres, matching how saved connections already work in this prototype. Country borders for the glow regions are a hand-filtered, ~6KB subset of the public-domain Natural Earth 1:110m dataset, vendored at `frontend/src/data/countryBorders.json`.
