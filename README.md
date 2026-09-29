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
- `POST /api/matches`: accepts `{ "description": "A paragraph about yourself..." }` (1–4,000 characters); AI returns up to three suitable open ministries in recommended order, with reasons, details to confirm, and database-sourced ministry contacts.
- `GET /api/connections`: saved connections shared across this prototype workspace.
- `POST /api/connections`: save `{ "ministry_id": 1, "member": "Jamie" }`; repeated saves are deduplicated by ministry and member name.
- `DELETE /api/connections/{connection_id}`: remove a saved connection.

Find a place uses the configured AI provider and fallback from the backend. Set `GLOO_API_KEY` for the default Gloo provider, or configure `AI_PROVIDER` / `AI_FALLBACK` and their corresponding keys. With no configured provider it returns HTTP 503; provider failures or invalid AI responses return HTTP 502. It never substitutes rule-based recommendations. The chat's ministry search still uses rules. Sample contacts use example.com; no introductions are sent. This is a single shared demo workspace without login or user isolation. Members with the same name are treated as the same person for duplicate saves.

Saved connections survive page refreshes and container restarts through the existing Postgres volume. Removing the volume deletes them. There is no ministry editor yet; seed content is starter data, while the database is the runtime source of truth.

Run `docker compose up --build -d`, then open http://localhost:3000. For frontend development, keep the backend and database running and run `npm install` and `npm run dev` in `frontend`; Vite proxies API calls to port 8000.

## Website chat agent

### HPC Ollama for local development

With the Liberty student VPN connected, keep this SSH tunnel open (replace `YOUR_USERNAME`):

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:11434:arrietty.hpc.lan:11434 YOUR_USERNAME@totoro.university.liberty.edu
```

In your ignored `.env`, set `AI_PROVIDER=ollama`, `OLLAMA_MODEL=gpt-oss:20b`, and `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` for Docker Desktop. No Ollama API key is needed. Use `http://127.0.0.1:11434/v1` instead when running the backend directly on Windows. Rebuild with `docker compose up --build -d`. Both Find a place and the chat use the configured provider. The VPN and SSH tunnel must remain connected; this local tunnel does not configure access for Cloudflare deployments.

Verify the tunnel with `Invoke-RestMethod http://127.0.0.1:11434/api/tags`. Verify the backend selection at `/api/chat/status`; configuration status alone does not confirm model health.

The "Ask Belong" widget (bottom right) talks to `POST /api/chat`, which runs a tool-calling loop against Gloo AI (`backend/app/chat.py`). The model can look up church info and FAQs, events, small groups, and ministries, file a connection request, or hand a conversation off to staff (pastoral care, prayer, crisis). Tool errors go back to the model so it can correct itself; the loop stops after 6 steps.

- Set `GLOO_API_KEY` in `.env` (from Gloo AI Studio > API Credentials) and run `docker compose up -d` again. Without a configured provider, the widget uses limited local demo replies for service times, events, groups, ministries, and requests. `GLOO_MODEL` defaults to `gloo-anthropic-claude-haiku-4.5`.
- Synthetic church content lives in `backend/app/church.json` and is seeded into `church_content` on startup.
- Nothing is sent to anyone automatically. Requests land in the `requests` table and appear on the Saved connections page; approving a connection request adds it to saved connections.
- Every user message, tool call, and reply is written to `chat_log`. `GET /api/chat/log/{session_id}` returns one session for auditing.

Demo connection requests start with “connect me” or “sign me up”. Supply the full ministry name, “my name is Jamie”, and an email or phone number; missing details can be supplied in follow-up messages. Say “cancel” to stop. Requests are saved for staff review, not delivered as notifications. Approval does not send an introduction.

The widget keeps the visible transcript but sends only recent context, so long chats remain within the API limits. Demo mode is keyword-based and does not provide general conversational understanding.

Chat regression checks: `python -m unittest discover -s backend/tests` (backend dependencies required), and `node --test frontend/src/chatHistory.test.js`.
