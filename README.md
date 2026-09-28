# GlooHackathon2026 — Pastor Notes

Transcription + grounded Q&A for sermons, built entirely on Cloudflare.
Upload a video (or paste a YouTube link), and it is transcribed on
Cloudflare (Whisper large-v3-turbo via Workers AI), chunked, embedded,
and stored — then you can ask questions about it and only get answers
the transcript actually supports.

Part of the Gloo Hackathon 2026. This branch: `pastor-notes`.

## What is deployed

| Worker | Purpose |
|---|---|
| `gloo-hackathon2026-api-pastor-notes` | The backend: a Cloudflare **Container** (Python FastAPI + ffmpeg + yt-dlp) backed by a **SQLite Durable Object**, with **R2** for media and **Workers AI** for models. |
| `preview-pastor-notes-gloo-hackathon2026` | The frontend preview (React/Vite) for this branch. |

The branch is **church-agnostic by design**: the church name, contact info
and any per-church config lives in a Durable Object (settable at runtime
with the admin key), and all secrets are per-deployment. Any church gets
their own subdomain + their own keys.

## How it works

```
YouTube URL / file upload
        |
        v
Container (ffmpeg + yt-dlp) ----> R2 (raw media)
        |
        v  Workers AI: whisper-large-v3-turbo
   transcript + timestamped segments
        |
        v  Workers AI: bge-base-en-v1.5 (embeddings)
   chunks in the SQLite Durable Object
        |
        v  ask a question
   ranked chunks -> grounded answer with citations
```

**Grounded Q&A (the important part).** Every question is answered in two
independent modes:

- **Extractive (default, no AI key needed):** the best-matching verbatim
  transcript passages, each with a timestamp citation. A passage must pass
  a similarity floor **and** a keyword-overlap ground check to be returned;
  otherwise the answer is "Not found in this note."
- **`workers-ai` LLM engine (optional):** set `NOTES_ANSWER_ENGINE=workers-ai`
  in `api/wrangler.jsonc` and redeploy. A Llama-3.1-8B (Workers AI) then
  writes prose answers — but every passage it cites is string-verified
  against the actual transcript, and any quote that fails falls back to the
  verbatim answer. The LLM can only make answers *prettier*, never less
  grounded.

## Keys / secrets

All are set on the API worker with `npx wrangler secret put <NAME>` (run from
`api/`). They are never in code, never in the repo.

| Secret | Required | What it does |
|---|---|---|
| `NOTES_API_KEY` | yes | Gates every `/api/*` route. The frontend holds it in the browser session only (paste it on the page). No key configured => all API calls return 503. |
| `NOTES_ADMIN_KEY` | for config changes | Required to change the church config (name, contact, etc.). |
| `YTDLP_COOKIES` | no | Your YouTube cookies, to get past YouTube blocking Cloudflare server IPs. See note below. |

A copy of the generated keys is kept on the laptop at
`~/.config/pastor-notes/` (owner-only) because Workers secrets cannot be
read back.

## Known limitation: YouTube egress

YouTube intermittently refuses downloads from Cloudflares server IPs, so a
YouTube link can fail with a clear `youtube_blocked` error. Two workarounds:

1. **Upload the video file instead** — the "Upload a file" tab. 100%
   reliable, never touches YouTubes servers.
2. **Set the `YTDLP_COOKIES` secret** — a permanent fix for YouTube links.

Retrying a YouTube link sometimes succeeds (the block is flaky, not total).

## Run it locally

The old `docker compose` setup (nginx + FastAPI + Postgres) is the base
branchs dev loop and still works for the *original* app. For the Pastor
Notes stack (Workers + Durable Object + R2 + Workers AI) use the wrangler
dev flow:

```bash
cd api
npm install
npx wrangler dev      # local Durable Object + R2 emulation
```

The container build itself:

```bash
docker build -t gloo-pastor-notes:latest backend/
```

## Repo layout (this branch)

| Path | Whats in it |
|---|---|
| `api/` | The Workers backend: `wrangler.jsonc`, the Container worker, the SQLite Durable Object, R2, Workers AI calls, and the grounded-Q&A engine. |
| `backend/` | The Python container image (FastAPI, ffmpeg, yt-dlp). |
| `frontend/src/PastorNotes.jsx` | The preview page: key entry, YouTube/upload tabs, notes list, transcript + ask view. |
| `db/` | Legacy Postgres schema from the base branch (unused by this stack). |

## Deploy checklist (per church)

1. `wrangler deploy` the API worker to the churchs subdomain.
2. `wrangler secret put` the churchs `NOTES_API_KEY` + `NOTES_ADMIN_KEY`.
3. (Optional) `YTDLP_COOKIES` if they want YouTube links to be reliable.
4. Set the churchs name/contact via the admin config endpoint.
5. Point their frontend at the API workers URL.

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
