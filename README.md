# GlooHackathon2026 — Belong

Liberty University's Gloo Hackathon team repository.

Belong is one site for a church community, **Grace Community Church** (fictional), with four areas:

- **Serve**: browse ministry teams, see where volunteers are needed, match a member to a team, and review requests from the website chat.
- **Sermon Notes**: sermons are transcribed on Cloudflare, and you can ask questions that are answered only from the transcript, with timestamps.
- **Give**: one-time gifts through Stripe Checkout (demo mode until a key is set).
- **Calendar**: browse and add church events and services, with optional AI-generated summaries.

An **Ask Belong** chat assistant is available on every page.

## What is deployed

| Worker | URL | Purpose |
|---|---|---|
| `preview-frontend-gloo-hackathon2026` | https://preview-frontend-gloo-hackathon2026.jaronwilson2025.workers.dev | The React frontend (static assets, repo root `wrangler.jsonc`). |
| `gloo-hackathon2026-api-pastor-notes` | https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev | Church API (`api/`): a Cloudflare **Container** running the FastAPI backend, a **SQLite Durable Object** database, **R2** for sermon media, **Workers AI** for transcription and embeddings. Serves Serve, the chat and Sermon Notes. |
| `gloo-hackathon2026-api-donate-giving` | https://gloo-hackathon2026-api-donate-giving.jaronwilson2025.workers.dev | Giving API (`api-giving/`): a Worker + SQLite Durable Object. |

Both APIs accept a comma-separated `ALLOWED_ORIGIN` list, so several frontend previews can share them.

## First-time guests

A guest opens "Plan your visit" (service times, what to expect, parking/kids/accessibility FAQs, a map, and upcoming newcomer events), then fills out "Let us know you're coming." On the day, tapping **"I'm here"** flips their visit to `arrived`; the "Welcome team" screen shows them in the waiting queue. A greeter taps **"On my way"** to claim them (status `on_the_way`), which updates the guest's own screen to "<host> is coming to meet you at the main entrance." The greeter then taps **"Met them"** to clear them (status `met`). Guests who untick "I'd like someone to meet me" still tap "I'm here"; greeters see them as "Prefers not to be met" and just tap **"Got it"**.

- `GET /api/church`: church info, FAQs, and events for the visit page.
- `POST /api/visits`: sign up; returns the visit with a `token` used to check its own status (no login). 400 if `service` isn't one of the church's service times.
- `GET /api/visits/{token}`: a guest's own visit by token.
- `POST /api/visits/{token}/arrive`: mark `arrived` (409 if not `planned`).
- `GET /api/visits`: staff queue — `{ waiting: [...arrived/on_the_way], planned: [...last 7 days] }`. Staff endpoints never return guest tokens.
- `POST /api/visits/{visit_id}/claim`: a greeter claims a waiting guest with `{ host }` (409 if not `arrived`).
- `POST /api/visits/{visit_id}/met`: clear a guest once greeted (409 if invalid).

The map uses keyless Google Maps embed and directions URLs (no API key), built from `map_query` in `backend/app/church.json`. New `church.json` info fields are added to existing databases on startup without overwriting existing values.

## Repo layout

| Path | What's in it |
|---|---|
| `frontend/src/App.jsx` | Routing (`#/`, `#/serve`, `#/serve/find`, `#/serve/saved`, `#/notes`, `#/give`) and page shell. |
| `frontend/src/Layout.jsx` | Sidebar (desktop), top bar + bottom tab bar (phones), page header, sub-tabs. |
| `frontend/src/Home.jsx`, `Serve.jsx`, `PastorNotes.jsx`, `Give.jsx`, `ChatWidget.jsx` | The pages and the chat. |
| `frontend/src/styles.css` | Design tokens (`:root`) and all styles. |
| `frontend/src/api.js` | API helpers. `VITE_API_BASE` is the church API; `VITE_GIVING_API_BASE` is the giving API. |
| `api/` | Church API Worker: container, church database Durable Object, Sermon Notes routes. |
| `api-giving/` | Giving Worker. |
| `backend/app/` | FastAPI app that runs in the container: ministries, matching, chat (`chat.py`), Sermon Notes (`pastor_notes.py`), SQL (`db.py`). |
| `docker-compose.yml`, `db/` | Legacy local Postgres setup from the base branch. `db.py` now talks to the Durable Object, so this is not a working local stack on its own. |

## Build and deploy

```bash
# frontend
cd frontend && npm ci
VITE_API_BASE=https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev npm run build
cd .. && npx wrangler deploy          # repo root: serves frontend/dist

# APIs
cd api && npm ci && npx wrangler deploy          # rebuilds the container image
cd ../api-giving && npm ci && npx wrangler deploy
```

For local API development run `npx wrangler dev` in `api/` or `api-giving/`.

## Keys and access

Secrets are set with `npx wrangler secret put <NAME>` in the worker's directory. They are never in the repo.

| Secret | Worker | What it does |
|---|---|---|
| `NOTES_API_KEY` | `api/` | Required for Sermon Notes routes. The page asks for it once and keeps it in the browser tab only. |
| `NOTES_ADMIN_KEY` | `api/` | Changing the church config. |
| `YTDLP_COOKIES` | `api/` | Optional; helps YouTube downloads (see below). |
| `GLOO_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `api/` | Optional; switches the chat from demo replies to a real model. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `api-giving/` | Optional; switches giving from demo to live Stripe. |

The Serve and chat routes (`/api/ministries`, `/api/matches`, `/api/connections`, `/api/requests`, `/api/chat`, `/api/info`) are public, like the rest of a church website. Sermon Notes, uploads, the chat log and admin routes need a key. A copy of the generated Sermon Notes keys is kept on the laptop at `~/.config/pastor-notes/` (owner-only), because Workers secrets cannot be read back.

## Serve

Six fictional ministries are seeded from `backend/app/ministries.json`, and church info, FAQs, events and groups from `backend/app/church.json`. Seeding never overwrites existing rows.

- `GET /api/ministries`: departments, responsibilities, coverage, and sample contacts.
- `POST /api/matches`: member name, skills, serving style, and availability, plus an optional `description` in their own words. With an AI provider configured and a description given, AI returns up to three open ministries with reasons and details to confirm (`engine: "ai"`); otherwise, or if the AI fails, simple rules rank the top three (`engine: "rules"`).
- `GET /api/connections`, `POST /api/connections`, `DELETE /api/connections/{connection_id}`: saved connections, deduplicated by ministry and member name.
- `GET /api/requests`, `PATCH /api/requests/{request_id}`: requests filed by the chat; approving a connection request also saves the connection.
- `GET /api/info`: public church details (address, service times) for the home page.

Without an AI provider, matching uses simple rules. Sample contacts use example.com and no introductions are sent. This is a single shared demo workspace without login.

### Website chat (Ask Belong)

The "Ask Belong" chat (the Ask tab on phones, bottom-right button on desktop) talks to `POST /api/chat`, which runs a tool-calling loop against Gloo AI (`backend/app/chat.py`). The model can look up church info and FAQs, events, small groups, and ministries, file a connection request, or hand a conversation off to staff (pastoral care, prayer, crisis). Tool errors go back to the model so it can correct itself; the loop stops after 6 steps.

- Set `GLOO_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) with `npx wrangler secret put` in `api/`; the Worker passes it into the container. Without a configured provider, the widget uses limited local demo replies for service times, events, groups, ministries, and requests, with a banner saying so. `GLOO_MODEL` defaults to `gloo-anthropic-claude-haiku-4.5`.
- Synthetic church content lives in `backend/app/church.json` and is seeded into `church_content` on startup.
- Nothing is sent to anyone automatically. Requests land in the `requests` table and appear under Serve > Saved; approving a connection request adds it to saved connections.
- Every user message, tool call, and reply is written to `chat_log`. `GET /api/chat/log/{session_id}` returns one session for auditing (API key required).

Demo connection requests start with “connect me” or “sign me up”. Supply the full ministry name, “my name is Jamie”, and an email or phone number; missing details can be supplied in follow-up messages. Say “cancel” to stop. Requests are saved for staff review, not delivered as notifications. Approval does not send an introduction.

The widget keeps the visible transcript but sends only recent context, so long chats remain within the API limits. Demo mode is keyword-based and does not provide general conversational understanding.

Chat regression checks: `python -m unittest discover -s backend/tests` (backend dependencies required), and `node --test frontend/src/chatHistory.test.js`.

### HPC Ollama for local development

With the Liberty student VPN connected, keep this SSH tunnel open (replace `YOUR_USERNAME`):

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:11434:arrietty.hpc.lan:11434 YOUR_USERNAME@totoro.university.liberty.edu
```

In your ignored `.env`, set `AI_PROVIDER=ollama`, `OLLAMA_MODEL=gpt-oss:20b`, and `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` for Docker Desktop. No Ollama API key is needed. Use `http://127.0.0.1:11434/v1` instead when running the backend directly on Windows. Rebuild with `docker compose up --build -d`. Both Find a place and the chat use the configured provider. The VPN and SSH tunnel must remain connected; this local tunnel does not configure access for Cloudflare deployments.

Verify the tunnel with `Invoke-RestMethod http://127.0.0.1:11434/api/tags`. Verify the backend selection at `/api/chat/status`; configuration status alone does not confirm model health.

## Sermon Notes

Upload a video (or paste a YouTube link). It is transcribed on Cloudflare (Whisper large-v3-turbo via Workers AI), chunked, embedded and stored, and questions are answered only from what the transcript supports.

### How it works

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

### Known limitation: YouTube egress

YouTube intermittently refuses downloads from Cloudflares server IPs, so a
YouTube link can fail with a clear `youtube_blocked` error. Two workarounds:

1. **Upload the video file instead** — the "Upload a file" tab. 100%
   reliable, never touches YouTubes servers.
2. **Set the `YTDLP_COOKIES` secret** — a permanent fix for YouTube links.

Retrying a YouTube link sometimes succeeds (the block is flaky, not total).

## Donate / Giving

A church-agnostic giving area that runs on Cloudflare Workers — a pure-JS Worker routes to a single SQLite Durable Object. It is a separate worker from the church API; the React "Give" page talks to the Worker's public origin directly (`VITE_GIVING_API_BASE`).

The **Give** page is modeled on a single-fund giving flow: preset amount buttons and a free-text "enter any amount" field (both sourced from config), an anonymous-donation toggle, a goal progress bar, and a "Recent Support" feed of recent gifts. Presets, the goal title/amount, and presets all live in the Durable Object config and are changeable through the admin-key-gated route.

Stripe Checkout handles one-time gifts — on "Continue to Payment" the page calls our Worker, which creates the Stripe Checkout session server-side (no direct browser→Stripe) and redirects the donor to Stripe's hosted page, so card data never reaches our servers. Gifts are recorded when the `checkout.session.completed` webhook arrives.

Routes (all under the Worker origin, CORS limited to the origins in `ALLOWED_ORIGIN`):

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
- **Stripe is only exercised for real once a key is present.** Set `wrangler secret put STRIPE_SECRET_KEY` (and optionally `STRIPE_WEBHOOK_SECRET`) in `api-giving/`. With a real or Stripe **test** key, the same code runs live Checkout, the bootstrap route, and real webhook verification. Until a key is supplied the branch only verifies the demo path — no rework when a key is added later.
- **Bootstrap**: `POST /api/admin/bootstrap-stripe` (admin key) does the Stripe-dashboard work over HTTPS — verifying the key, creating a product + price per configured preset, and registering a `checkout.session.completed` webhook endpoint pointed at the Worker. The resulting price ids and the webhook signing secret are persisted in config so the checkout flow can use them.
- `ADMIN_KEY` (a Worker var) gates config writes, the gift list, and bootstrap; it is compared in constant time. Donor-facing routes never expose a donor's email; anonymous donors are masked in the public feed.
- Checkout success/cancel links go back to the frontend origin that started the gift (it must be listed in `ALLOWED_ORIGIN`).
