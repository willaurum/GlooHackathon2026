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

The React frontend uses FastAPI, Postgres, and an AI endpoint (supporting any OpenAPI / OpenAI compatible endpoint or local Ollama). Six fictional ministries and church events are seeded on first backend startup. Startup creates the new tables on existing volumes without deleting data.

### AI Endpoint Configuration
The application connects to any OpenAPI / OpenAI-compatible endpoint or local/SSH-forwarded Ollama instance (default: `http://127.0.0.1:11434` or configured `AI_BASE_URL`):
- **Universal OpenAPI / OpenAI Compatibility:** Works with any OpenAI-compatible server (`/v1/chat/completions`, `/v1/models`), such as vLLM, LM Studio, LiteLLM, LocalAI, cloud OpenAI endpoints, or Ollama's built-in OpenAI API.
- **Default model:** `qwen3.8:27b` for bulletin event summaries.
- **Configurable (not hardcoded):**
  - Set `AI_BASE_URL` (or `OLLAMA_BASE_URL`), `AI_MODEL` (or `OLLAMA_MODEL`), and optional `AI_API_KEY` in `.env` or docker-compose.
  - Or switch models dynamically at runtime via the UI model selector in the status bar or `POST /api/ai/model`.

### API Endpoints
- `GET /api/ministries`: departments, responsibilities, coverage, and sample contacts.
- `POST /api/matches`: member name, skills, serving style, and availability; returns the top three open ministries.
- `GET /api/connections`: saved connections shared across this prototype workspace.
- `POST /api/connections`: save `{ "ministry_id": 1, "member": "Jamie" }`; repeated saves are deduplicated by ministry and member name.
- `DELETE /api/connections/{connection_id}`: remove a saved connection.
- `GET /api/events`: calendar events with date, time, location, category, description, and AI summary.
- `POST /api/events`: create a new church event.
- `POST /api/events/{event_id}/summarize`: request AI endpoint to generate a warm 2-sentence bulletin summary (optional `?model=` query param).
- `POST /api/events/summarize-all`: summarize events. Accepts `only_missing: true` in JSON body or query param to only summarize unsummarized events, or `only_missing: false` to remake all summaries.
- `GET /api/ai/status`: check connectivity to AI endpoint and list available models (with legacy `/api/ollama/status` alias).
- `POST /api/ai/model`: change the active default AI model dynamically (with legacy `/api/ollama/model` alias).

Run `docker compose up --build -d`, then open http://localhost:3000.

