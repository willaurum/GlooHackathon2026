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

## Website chat agent

The "Ask Belong" widget (bottom right) talks to `POST /api/chat`, which runs a tool-calling loop against Gloo AI (`backend/app/chat.py`). The model can look up church info and FAQs, events, small groups, and ministries, file a connection request, or hand a conversation off to staff (pastoral care, prayer, crisis). Tool errors go back to the model so it can correct itself; the loop stops after 6 steps.

- Set `GLOO_API_KEY` in `.env` (from Gloo AI Studio > API Credentials) and run `docker compose up -d` again. Without a key the widget shows a "not configured" banner. `GLOO_MODEL` defaults to `gloo-anthropic-claude-haiku-4.5`.
- Synthetic church content lives in `backend/app/church.json` and is seeded into `church_content` on startup.
- Nothing is sent to anyone automatically. Requests land in the `requests` table and appear on the Saved connections page; approving a connection request adds it to saved connections.
- Every user message, tool call, and reply is written to `chat_log`. `GET /api/chat/log/{session_id}` returns one session for auditing.

## Donate / Giving

A church-agnostic giving area that runs on Cloudflare Workers — a pure-JS Worker routes to a single SQLite Durable Object. It is a separate worker from the Docker/FastAPI app above; the React "Give" page talks to the Worker's public origin directly.

```
api/          The giving Worker: GivingDO (SQLite Durable Object) + routes
frontend/     The React app; the "Give" page lives in frontend/src/Give.jsx
wrangler.jsonc  The preview static-assets Worker that serves the built frontend
```

The **Give** page is modeled on a single-fund giving flow: preset amount buttons and a free-text "enter any amount" field (both sourced from config), an anonymous-donation toggle, a goal progress bar, and a "Recent Support" feed of recent gifts. Presets, the goal title/amount, and presets all live in the Durable Object config and are changeable through the admin-key-gated route.

Stripe Checkout handles one-time gifts — on "Continue to Payment" the page calls our Worker, which creates the Stripe Checkout session server-side (no direct browser→Stripe) and redirects the donor to Stripe's hosted page, so card data never reaches our servers. Gifts are recorded when the `checkout.session.completed` webhook arrives.

Routes (all under the Worker origin, CORS scoped to the preview only):

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | `/api/health` | — | Liveness + current mode (`demo`/`live`). |
| `GET` | `/api/config` | — | Public config: church name, currency, presets, goal, amount raised. |
| `GET` | `/api/gifts` | — | "Recent Support" feed — recent donor name (anonymous masked), amount, time. No emails. |
| `PUT` / `POST` | `/api/config` | admin key | Update church name, currency, presets, and goal. |
| `POST` | `/api/checkout` | — (rate-limited) | Start a gift; returns a Checkout URL (real or simulated). |
| `GET` | `/api/confirm/{session_id}` | own session | Look up a gift's status after checkout. |
| `POST` | `/api/webhooks/stripe` | Stripe signature | Records the gift on `checkout.session.completed` (idempotent on session id). |
| `GET` | `/api/admin/gifts` | admin key | Full gift list — names and emails, admin-only. |
| `POST` | `/api/admin/bootstrap-stripe` | admin key | From just a key: create/verify the products + prices for the presets and register the `checkout.session.completed` webhook endpoint, then persist the price ids (and webhook signing secret) in config. |

- **Demo mode** is the default: with no `STRIPE_SECRET_KEY` set, gifts are recorded as `demo`, checkout is simulated, and the page shows a "demo mode" banner — so the preview is fully usable with zero keys.
- **Stripe is only exercised for real once a key is present.** Set `wrangler secret put STRIPE_SECRET_KEY` (and optionally `STRIPE_WEBHOOK_SECRET`) in `api/`. With a real or Stripe **test** key, the same code runs live Checkout, the bootstrap route, and real webhook verification. Until a key is supplied the branch only verifies the demo path — no rework when a key is added later.
- **Bootstrap**: `POST /api/admin/bootstrap-stripe` (admin key) does the Stripe-dashboard work over HTTPS — verifying the key, creating a product + price per configured preset, and registering a `checkout.session.completed` webhook endpoint pointed at the Worker. The resulting price ids and the webhook signing secret are persisted in config so the checkout flow can use them.
- `ADMIN_KEY` (a Worker var) gates config writes, the gift list, and bootstrap; it is compared in constant time. Donor-facing routes never expose a donor's email; anonymous donors are masked in the public feed.
- Deploy the preview first, then the API worker: `wrangler deploy` at the repo root (serves `frontend/dist`), and `npx wrangler deploy` in `api/`.
