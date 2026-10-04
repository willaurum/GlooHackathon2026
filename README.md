# GlooHackathon2026: belong.

Liberty University's Gloo Hackathon team repository.

belong. is one site for a church community, **Grace Community Church** (fictional), with these areas:

- **Home**: service times, what's on this week, and links into every area.
- **Guests**: *Plan your visit* (service times, what to expect, a parking and entrances map, and a "let us know you're coming" form) and the *Welcome team* screen greeters use on Sunday.
- **Serve**: browse ministry teams, see where volunteers are needed, match a member to a team, and review requests from the website chat.
- **Sermon Notes**: sermons are transcribed on Cloudflare and highlighted (Bible quotes, current events, stories), Bible references open the passage from YouVersion, and questions are answered only from the transcript, with timestamps.
- **Calendar**: church events and services, with optional AI summaries.
- **Give**: private giving to a church's funds and mission trips through Stripe Checkout, mission trip applications, and self-serve church sign-up with automatic Stripe setup.
- **Prayer map**: world regions with news and prayer prompts.

An **Ask Belong** chat assistant is available on every page.

## What is deployed

| Worker | URL | Purpose |
|---|---|---|
| `gloo-hackathon2026` | https://gloo-hackathon2026.jaronwilson2025.workers.dev | The React frontend (static assets, repo root `wrangler.jsonc`). |
| `gloo-hackathon2026-api-pastor-notes` | https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev | Church API (`api/`): a Cloudflare **Container** running the FastAPI backend, a **SQLite Durable Object** database, **R2** for sermon media, **Workers AI** for transcription and embeddings. Serves Serve, Guests, Calendar, Prayer map, the chat, Sermon Notes and Bible verses. |
| `gloo-hackathon2026-api-donate-giving` | https://gloo-hackathon2026-api-donate-giving.jaronwilson2025.workers.dev | Giving API (`api-giving/`): a Worker with one SQLite Durable Object per church plus a small registry object. |

### Branch and PR previews

Every team branch and every pull request gets its own preview, built by `.github/workflows/previews.yml`:

- Branch: `https://preview-<branch>-gloo-hackathon2026.jaronwilson2025.workers.dev` (for example `preview-jaron-frontend-gloo-hackathon2026`).
- Pull request: `https://preview-pr-<number>-gloo-hackathon2026.jaronwilson2025.workers.dev`, posted as a comment on the PR.

Previews proxy `/api` and `/giving-api` to the **live** APIs above, so a preview shows that branch's frontend against the backend currently deployed. See [PREVIEWS.md](PREVIEWS.md) for details.

## How we work

- Branch from `jaron-frontend`, the integration branch. Open a pull request into `jaron-frontend` and check its PR preview before it is merged.
- Before opening a PR, merge the latest `jaron-frontend` into your branch so conflicts are fixed on your side. `App.jsx`, `Layout.jsx` and `styles.css` change often.
- `jaron-frontend` goes to `main` once it is production ready. A push to `main` deploys the frontend and the APIs.

## Repo layout

| Path | What's in it |
|---|---|
| `frontend/src/App.jsx` | Hash routing and the page shell. Routes: `#/`, `#/guests/plan`, `#/guests/welcome`, `#/serve`, `#/serve/find`, `#/serve/saved`, `#/notes`, `#/notes/<id>`, `#/calendar`, `#/give`, `#/give/trips`, `#/give/staff`, `#/give/start`, `#/give/c/<church>`, `#/prayer/map`. A section with sub-pages opens its first sub-page. |
| `frontend/src/Layout.jsx` | `SECTIONS` (the navigation), sidebar on desktop, top bar and one-row bottom tab bar on phones, page header, `SubNav` sub-tabs. |
| `frontend/src/Home.jsx`, `Serve.jsx`, `Calendar.jsx`, `PrayerMap.jsx` | Those pages. |
| `frontend/src/VisitPage.jsx`, `WelcomeTeam.jsx`, `ChurchMap.jsx`, `visitMap.js` | Guests: Plan your visit, the greeter screen, and the parking and entrances map (each spot's color lives in `visitMap.js`). |
| `frontend/src/PastorNotes.jsx`, `verses.js` | Sermon Notes, and the Bible reference parser and passage loader. |
| `frontend/src/Give.jsx`, `GiveChurchBar.jsx`, `GiveSignup.jsx`, `GiveStaff.jsx`, `giving.js` | Giving, the church picker, church sign-up, the staff area, and the giving API client. |
| `frontend/src/ChatWidget.jsx`, `chatFormat.js`, `chatHistory.js`, `chatNavigation.js` | Ask Belong. |
| `frontend/src/styles.css` | Design tokens (`:root`) and all styles. |
| `frontend/src/api.js` | API helpers. `VITE_API_BASE` is the church API; `VITE_GIVING_API_BASE` is the giving API. |
| `frontend/src/data/` | Static data bundled into the site (`countryBorders.json` for the Prayer map). |
| `api/` | Church API Worker: container, church database Durable Object, Sermon Notes routes, `/api/verse`. |
| `api-giving/` | Giving Worker, with tests in `api-giving/test/`. |
| `backend/app/` | FastAPI app that runs in the container: ministries, matching, chat (`chat.py`), visits, events, prayer map, Sermon Notes (`pastor_notes.py`), SQL (`db.py`). Seed content is in the `*.json` files next to it. |
| `docker-compose.yml`, `db/` | Legacy local Postgres setup from the base branch. `db.py` now talks to the Durable Object, so this is not a working local stack on its own. |

## Build and deploy

Deploys are automatic:

- **Frontend previews**: `.github/workflows/previews.yml` on every push to a team branch and every pull request.
- **APIs**: `.github/workflows/deploy-backend.yml` deploys `api/` and `api-giving/` on a push to `main` that touches `api/`, `api-giving/` or `backend/`. It can also be run by hand (Actions > Deploy backend > Run workflow) against any branch. It uses the `CLOUDFLARE_API_TOKEN` repository secret, which needs Workers Scripts and Workers Containers edit access.

To build or deploy by hand:

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

Secrets are set with `npx wrangler secret put <NAME>` in the worker's directory (or with `--name <worker>` from anywhere). They are never in the repo.

| Secret | Worker | What it does |
|---|---|---|
| `NOTES_API_KEY` | `api/` | Required for Sermon Notes routes. The page asks for it once and keeps it in the browser tab only. |
| `NOTES_ADMIN_KEY` | `api/` | Changing the church config. |
| `YOUVERSION_APP_KEY` | `api/` | YouVersion Platform app key for Bible passages in Sermon Notes. Optional `YOUVERSION_BIBLE_ID` picks the version (default `3034`, Berean Standard Bible). |
| `YTDLP_COOKIES` | `api/` | Optional; helps YouTube downloads (see below). |
| `GLOO_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `api/` | Optional; switches the chat from demo replies to a real model. |
| `STRIPE_KEY_ENCRYPTION_KEY` | `api-giving/` | Encrypts each church's stored Stripe key. Without it, churches cannot connect Stripe. If it is lost or changed, churches must paste their Stripe keys again. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `api-giving/` | Legacy single-church settings from before church sign-up. Churches now connect their own Stripe key from the staff area. |

The Serve, Guests, Calendar, Prayer map, verse and chat routes are public, like the rest of a church website. Sermon Notes, uploads, the chat log and admin routes need a key.

## First-time guests

A guest opens "Plan your visit" (service times, what to expect, parking/kids/accessibility FAQs, a map, and upcoming newcomer events), then fills out "Let us know you're coming." On the day, tapping **"I'm here"** flips their visit to `arrived`; the "Welcome team" screen shows them in the waiting queue. A greeter taps **"On my way"** to claim them (status `on_the_way`), which updates the guest's own screen to "<host> is coming to meet you at the main entrance." The greeter then taps **"Met them"** to clear them (status `met`). Guests who untick "I'd like someone to meet me" still tap "I'm here"; greeters see them as "Prefers not to be met" and just tap **"Got it"**.

- `GET /api/church`: church info, FAQs, and events for the visit page.
- `POST /api/visits`: sign up; returns the visit with a `token` used to check its own status (no login). 400 if `service` isn't one of the church's service times.
- `GET /api/visits/{token}`: a guest's own visit by token.
- `POST /api/visits/{token}/arrive`: mark `arrived` (409 if not `planned`).
- `GET /api/visits`: staff queue, `{ waiting: [...arrived/on_the_way], planned: [...last 7 days] }`. Staff endpoints never return guest tokens.
- `POST /api/visits/{visit_id}/claim`: a greeter claims a waiting guest with `{ host }` (409 if not `arrived`).
- `POST /api/visits/{visit_id}/met`: clear a guest once greeted (409 if invalid).

The parking and entrances map is drawn over satellite imagery with Leaflet (`ChurchMap.jsx`, spots in `visitMap.js`); tapping a spot in the list highlights and zooms to it. The Google Maps and Apple Maps directions links use `EXAMPLE_CAMPUS.directionsQuery` in `visitMap.js`. New `church.json` info fields are added to existing databases on startup without overwriting existing values.

## Serve

Six fictional ministries, each with dated shifts, capacity, and onboarding requirements, are seeded from `backend/app/ministries.json`, and church info, FAQs, events and groups from `backend/app/church.json`. Seeding never overwrites existing rows.

- `GET /api/ministries`: departments, responsibilities, coverage, and sample contacts.
- `POST /api/matches`: a `description` (optional, up to 4,000 characters) and optional structured `preferences`; returns up to three AI-recommended ministries with reasons, details to confirm, and database-sourced contacts. Empty answers return every team to browse.
- `GET /api/connections`, `POST /api/connections`, `DELETE /api/connections/{connection_id}`: saved connections, deduplicated by ministry and member name.
- `GET /api/requests`, `PATCH /api/requests/{request_id}`: requests filed by the chat; approving a connection request also saves the connection.
- `GET /api/info`: public church details (address, service times) for the home page.

Find a place filters shifts deterministically (`backend/app/eligibility.py`: availability, service, frequency, requirements, open capacity) before the AI sees the catalog, then uses the chat's configured provider (`backend/app/recommendations.py`). With no provider it returns 503; a provider failure or invalid AI response returns 502. It never substitutes rule-based recommendations. Coverage numbers are the totals of each ministry's shifts. On startup, shifts and requirements missing from existing database rows are backfilled from the seed without overwriting saved values. Sample contacts use example.com and no introductions are sent. This is a single shared demo workspace without login.

### Website chat (Ask Belong)

The "Ask Belong" chat (the Ask tab on phones, bottom-right button on desktop) talks to `POST /api/chat`, which runs a tool-calling loop against Gloo AI (`backend/app/chat.py`). The model can look up church info and FAQs, events, small groups, and ministries, file a connection request, or hand a conversation off to staff (pastoral care, prayer, crisis). Tool errors go back to the model so it can correct itself; the loop stops after 6 steps.

- Set `GLOO_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) with `npx wrangler secret put` in `api/`; the Worker passes it into the container. Without a configured provider, the widget uses limited local demo replies for service times, events, groups, ministries, and requests, with a banner saying so. `GLOO_MODEL` defaults to `gloo-anthropic-claude-haiku-4.5`.
- Synthetic church content lives in `backend/app/church.json` and is seeded into `church_content` on startup.
- Nothing is sent to anyone automatically. Requests land in the `requests` table and appear under Serve > Saved; approving a connection request adds it to saved connections.
- Every user message, tool call, and reply is written to `chat_log`. `GET /api/chat/log/{session_id}` returns one session for auditing (API key required).
- The chat can suggest a page with a **Take me there** button: home, plan-visit, ministries, find-place, saved-connections, calendar, give, and prayer-map. A suggestion can also name a section to scroll to (home: service-times; plan-visit: service-times, what-to-expect, good-to-know, map, next-steps, sign-up), so "Where do I park?" lands on the parking card. The backend allowlists pages and sections (`SITE_PAGES` and `SITE_SECTIONS` in `chat.py`), and `frontend/src/chatNavigation.js` maps them to hash routes and element ids; the model cannot supply URLs or ids. To add a section, give the element an id and add it to both lists. For personalized serving suggestions, the chat points people to Find a place instead of ranking ministries itself.
- Guardrails: the system prompt keeps the assistant to church and site topics and tells it to decline everything else, and obvious prompt-override attempts ("ignore previous instructions", "system prompt", "developer mode") get a fixed reply without calling the model. These reduce off-topic use; they are not a guarantee.
- Replies may use **bold** and simple lists, rendered by `frontend/src/chatFormat.js` as React elements (never raw HTML).

#### HPC Ollama for local development

With the Liberty student VPN connected, keep an SSH tunnel open (replace `YOUR_USERNAME`):

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:11434:arrietty.hpc.lan:11434 YOUR_USERNAME@totoro.university.liberty.edu
```

Then set `AI_PROVIDER=ollama`, `OLLAMA_MODEL=gpt-oss:20b`, and `OLLAMA_BASE_URL=http://host.docker.internal:11434` (or `http://127.0.0.1:11434` outside Docker) for the backend. No API key is needed, and the chat adds `/v1` if it is missing. Both Find a place and the chat use it. This tunnel only works locally, not from Cloudflare.

#### Tests

```bash
python -m unittest backend.tests.test_chat backend.tests.test_eligibility backend.tests.test_recommendations backend.tests.test_shifts
node --test frontend/src/chatFormat.test.js frontend/src/chatHistory.test.js frontend/src/chatNavigation.test.js
```

Run the Python tests from the repo root with the backend requirements installed. They mock the database, so no church DB is needed.

## Sermon Notes

Upload a video (or paste a YouTube link). It is transcribed on Cloudflare (Whisper large-v3-turbo via Workers AI), chunked, embedded and stored, and questions are answered only from what the transcript supports. The sermon list and an open sermon have their own routes (`#/notes`, `#/notes/<id>`); on phones an open sermon takes over the page, with a back button.

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
  writes prose answers, but every passage it cites is string-verified
  against the actual transcript, and any quote that fails falls back to the
  verbatim answer. The LLM can only make answers *prettier*, never less
  grounded.

### Highlights and Bible passages

The transcript is highlighted by category (Bible quotes, Bible references, current events, politics, personal stories, Scripture claims), and each category can be toggled. When a Bible quote or reference highlight names a passage (for example "Luke 10:25-26", "1 Cor. 13:4" or "Psalm 23"), the label is tappable and opens the passage under that line, with the version, copyright and a "Read on YouVersion" link.

- `frontend/src/verses.js` turns labels into USFM references (all 66 books, common abbreviations, Roman numeral prefixes, ranges) and loads the text.
- `GET /api/verse?usfm=JHN.3.16-17` (public) reads the passage from the YouVersion Platform API with `YOUVERSION_APP_KEY` and caches it for 7 days. It returns 404 when no key is set and 400 for a bad reference.
- If the API has no key or fails, the page falls back to the public-domain World English Bible from bible-api.com.

### Known limitation: YouTube egress

YouTube intermittently refuses downloads from Cloudflare's server IPs, so a
YouTube link can fail with a clear `youtube_blocked` error. Two workarounds:

1. **Upload the video file instead**: the "Upload a file" tab. 100%
   reliable, never touches YouTube's servers.
2. **Set the `YTDLP_COOKIES` secret**: a permanent fix for YouTube links.

The block is flaky, not total, so the container retries on its own: yt-dlp
paces its requests and backs off on transient errors, and a bot check or rate
limit ("try again later") is retried after 30 s and again after 120 s before
the note fails with `youtube_blocked`. The delays come from
`YOUTUBE_RETRY_DELAYS` in the container environment (comma-separated seconds,
default `30,120`). yt-dlp is pinned with a minimum version rather than an exact
one, since YouTube support breaks on stale releases; a rebuild picks up the
latest.

## Give

Giving runs on its own Worker (`api-giving/`). Each church has its own SQLite Durable Object, so churches' data is fully separate, and a small `GivingRegistry` object keeps church names and web addresses unique and powers church search. The frontend talks to it through `VITE_GIVING_API_BASE` (or `/giving-api` on previews).

**Privacy.** Public pages show totals, goal progress and gift counts, never who gave. Every gift needs a name and email, and only signed-in church staff see them (in the Gifts list and CSV), for giving records and receipts. There is no "give anonymously" option; an `anonymous` field sent by an older page is ignored. Gifts recorded as anonymous before this change have no name stored, so they still show as "Anonymous" to staff.

**Monthly gifts: manage or cancel on the website.** The Give page links to "Manage or cancel a monthly gift" (`#/give/manage`), and the thank-you screen after a monthly gift has a "Manage or cancel" button.

- With Stripe connected, setup also creates one Stripe customer portal configuration per church (cancel immediately, update card, see receipts) with its hosted login page turned on. The public church endpoint returns that login page as `portalUrl`; a donor enters their email there and Stripe sends a code. The thank-you button opens a portal session for the customer who paid that checkout session, and only that customer (for 7 days after the gift).
- In demo mode (no Stripe key, including Grace Community) a monthly gift gets a private link, `#/give/manage/<church>.<token>`. Only a hash of the token is stored. The link shows the gift (never the name or email) and lets the donor cancel it. Links are also remembered in that browser, so the manage page lists them.
- Staff can cancel any monthly gift from the Gifts list (with Stripe, this cancels the subscription there too). Canceled monthly gifts show "Monthly gift canceled" to staff. Gifts already made still count toward totals.
- When a donor cancels in the Stripe portal, the `customer.subscription.deleted` webhook marks the gift canceled.

**For a church:**

1. **Sign up** (`#/give/start`, "Add your church"): name, city, currency and a staff password. The church gets a shareable giving link, `#/give/c/<slug>`, and starts with three funds: General giving, Tithes & offerings, and Missions. It stays in demo mode until Stripe is connected.
2. **Connect Stripe** in the staff area (`#/give/staff`) by pasting a Stripe secret key once. Use a test key first, then a restricted live key with write access to Products, Prices, Checkout Sessions, Webhook Endpoints, Customer portal and Subscriptions. The Worker checks the key with Stripe, stores it encrypted with `STRIPE_KEY_ENCRYPTION_KEY` (never returned to any client; staff only see a hint like `sk_test_…Ab12`), and creates:
   - one Product per fund and per mission trip, with preset Prices found again by `lookup_key` (plus monthly Prices for Tithes);
   - one webhook endpoint per church, so gifts are recorded even when the donor closes the tab, monthly tithes renew, and canceled monthly gifts are marked;
   - one customer portal configuration (found again by `metadata[belong_church]`), so donors can cancel a monthly gift themselves.

   Running setup again ("Re-run Stripe setup") reuses everything, so nothing is duplicated. It also adds any missing webhook events to an existing endpoint. A new fund or trip gets its own Product and Prices right away.
3. **Mission trips**: staff create trips with dates, location, goal, team spots and an open/closed switch for applications. People apply (name, email, phone, message) or give toward a specific trip. Staff accept, waitlist or decline, and add private notes. The public page only shows "3 of 12 spots filled".
4. **Staff area**: setup checklist, funds and trips, applications, a private gift list with CSV download, church details and password change.

Staff sign in with the church's password (stored hashed). Sign-in gives a 12-hour session token, stored only as a hash; attempts are rate limited per IP, and changing the password signs out other sessions. There is no password reset yet.

The built-in demo church, **Grace Community** (`grace-community`), is locked to demo mode, so no real Stripe key can be attached to it. Its staff password is the `ADMIN_KEY` var.

Routes (all under the Worker origin, CORS limited to `ALLOWED_ORIGIN`):

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | `/api/health` | none | Liveness; `churches: true` means church support is deployed. |
| `GET` / `POST` | `/api/churches` | none (rate-limited) | Search churches (`?q=`) / sign up a church. |
| `GET` | `/api/churches/{slug}` | none | Public church page: funds, trips, totals, presets, mode. |
| `POST` | `/api/churches/{slug}/checkout` | none (rate-limited) | Start a gift to a fund or trip (one-time or monthly); returns a Checkout URL (real or simulated). |
| `GET` | `/api/churches/{slug}/confirm/{session_id}` | own session | A gift's status after checkout. |
| `POST` | `/api/churches/{slug}/portal` | own session (rate-limited) | `{ session }` from a monthly gift's checkout; returns a Stripe customer portal URL for that session's customer. |
| `GET` / `POST` | `/api/churches/{slug}/manage/{token}`, `.../manage/{token}/cancel` | private link (rate-limited) | Demo mode: see or cancel one monthly gift. |
| `POST` | `/api/churches/{slug}/trips/{trip_id}/apply` | none (rate-limited) | Apply for a mission trip. |
| `POST` | `/api/churches/{slug}/webhooks/stripe` | Stripe signature | Records gifts, subscription renewals and canceled subscriptions. |
| `POST` | `/api/churches/{slug}/admin/login`, `/admin/logout` | password / session | Staff sign-in. |
| various | `/api/churches/{slug}/admin/...` | staff session | Overview, settings, password, Stripe connect/sync/disconnect, funds and trips, donations (and `POST /admin/donations/{id}/cancel` for a monthly gift), applications. |
| `GET` / `POST` | `/api/config`, `/api/gifts`, `/api/checkout`, `/api/confirm/{id}` | none | The original single-church API, now served by the demo church for older builds. `/api/gifts` returns only a count and total. |

- **Demo mode**: with no Stripe key connected, checkout is simulated and gifts are recorded as `demo`, so previews work with zero keys.
- **Testing without Stripe**: `api-giving/test/fake-stripe.mjs` is a small fake Stripe server and `api-giving/test/api.test.mjs` runs the API checks against `wrangler dev`. Point the Worker at the fake with the `STRIPE_API_BASE` var (default `https://api.stripe.com`); never set it in production.
- Checkout success and cancel links go back to the frontend origin that started the gift (it must be listed in `ALLOWED_ORIGIN`). A checkout started from a branch preview returns to the live site.

## Calendar

Church events and services, seeded from `backend/app/events.json`, with a form to add events.

- `GET /api/events`, `GET /api/events/{event_id}`, `POST /api/events`.
- `POST /api/events/{event_id}/summarize` and `POST /api/events/summarize-all`: optional AI summaries (`GET /api/ai/status` says whether a provider is configured).

## Prayer map

A world map of regions (`backend/app/regions.json`) with news headlines (`backend/app/news.json`) and prayer prompts for each region.

- `GET /api/regions`, `GET /api/news`.
- `GET /api/regions/{region_id}/prayer-angles`, `POST /api/regions/{region_id}/prayer-angles`: prayer prompts for a region, generated on request.
