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

## First-time guests

A guest opens "Plan your visit" (service times, what to expect, parking/kids/accessibility FAQs, a map, and upcoming newcomer events), then fills out "Let us know you're coming." On the day, tapping **"I'm here"** flips their visit to `arrived`; the "Welcome team" screen shows them in the waiting queue. A greeter taps **"On my way"** to claim them (status `on_the_way`), which updates the guest's own screen to "<host> is coming to meet you at the main entrance." The greeter then taps **"Met them"** to clear them (status `met`). Guests who untick "I'd like someone to meet me" still tap "I'm here"; greeters see them as "Prefers not to be met" and just tap **"Got it"**.

- `GET /api/church`: church info, FAQs, and events for the visit page.
- `POST /api/visits`: sign up `{ name, contact, service, party_size, kids, wants_host }`; returns the visit with a `token` used to check its own status (no login). 400 if `service` isn't one of the church's service times.
- `GET /api/visits/{token}`: a guest's own visit by token.
- `POST /api/visits/{token}/arrive`: mark `arrived` (409 if not `planned`).
- `GET /api/visits`: staff queue — `{ waiting: [...arrived/on_the_way], planned: [...sign-ups from the last 7 days] }`. Staff endpoints never return guest tokens.
- `POST /api/visits/{visit_id}/claim`: a greeter claims a waiting guest with `{ host }` (409 if not `arrived`).
- `POST /api/visits/{visit_id}/met`: clear a guest once they've been greeted (409 if invalid).

The map uses keyless Google Maps embed and directions URLs (no API key), built from `map_query` in `backend/app/church.json`. The church address is fictional, so `map_query` is deliberately city-level: the street address matches a real residence. New `church.json` info fields are added to existing databases on startup without overwriting existing values. The guest's screen updating when a greeter claims them is done by polling `GET /api/visits/{token}` every few seconds — real SMS/push notifications are future work.

## Website chat agent

The "Ask Belong" widget (bottom right) talks to `POST /api/chat`, which runs a tool-calling loop against Gloo AI (`backend/app/chat.py`). The model can look up church info and FAQs, events, small groups, and ministries, file a connection request, or hand a conversation off to staff (pastoral care, prayer, crisis). Tool errors go back to the model so it can correct itself; the loop stops after 6 steps.

- Set `GLOO_API_KEY` in `.env` (from Gloo AI Studio > API Credentials) and run `docker compose up -d` again. Without a key the widget shows a "not configured" banner. `GLOO_MODEL` defaults to `gloo-anthropic-claude-haiku-4.5`.
- Synthetic church content lives in `backend/app/church.json` and is seeded into `church_content` on startup.
- Nothing is sent to anyone automatically. Requests land in the `requests` table and appear on the Saved connections page; approving a connection request adds it to saved connections.
- Every user message, tool call, and reply is written to `chat_log`. `GET /api/chat/log/{session_id}` returns one session for auditing.
