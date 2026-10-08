# Features and their APIs

Each area of a church site, how it behaves and the routes behind it. [Back to the README](../README.md)

## First-time guests

A guest opens "Plan your visit" (service times, what to expect, parking/kids/accessibility FAQs, a map, and upcoming newcomer events), then fills out "Let us know you're coming." On the day, tapping **"I'm here"** flips their visit to `arrived`; the "Welcome team" screen shows them in the waiting queue. A greeter taps **"On my way"** to claim them (status `on_the_way`), which updates the guest's own screen to "<host> is coming to meet you at the main entrance." A guest who arrives without their phone can be checked in by a greeter from the planned list with **"They're here"**, or by typing their name under **"Check in a guest"**: matching sign-ups get a **"Check in <name>"** button, and a name nobody signed up with can be checked in as a new guest (a walk-in). The greeter then taps **"Met them"** to clear them (status `met`). Guests who untick "I'd like someone to meet me" still tap "I'm here"; greeters see them as "Prefers not to be met" and just tap **"Got it"**.

- `GET /api/church`: church info, FAQs, and events for the visit page.
- `POST /api/visits`: sign up; returns the visit with a `token` used to check its own status (no login). 400 if `service` isn't one of the church's service times.
- `GET /api/visits/{token}`: a guest's own visit by token.
- `POST /api/visits/{token}/arrive`: mark `arrived` (409 if not `planned`).
- `GET /api/visits`: staff queue, `{ waiting: [...arrived/on_the_way], planned: [...last 7 days] }`. Staff endpoints never return guest tokens.
- `POST /api/visits/{visit_id}/checkin` (staff): check in a planned guest at the door (409 if not `planned`).
- `POST /api/visits/new/checkin` (staff): check in a walk-in by name (`{name, party_size?}`); creates an `arrived` visit with service "Walk-in".
- `POST /api/visits/{visit_id}/claim`: a greeter claims a waiting guest with `{ host }` (409 if not `arrived`).
- `POST /api/visits/{visit_id}/met`: clear a guest once greeted (409 if invalid).

The parking and entrances map is drawn over satellite imagery with Leaflet (`ChurchMap.jsx`, spots in `visitMap.js`); tapping a spot in the list highlights and zooms to it. The Google Maps and Apple Maps directions links use `EXAMPLE_CAMPUS.directionsQuery` in `visitMap.js`. New `church.json` info fields are added to existing databases on startup without overwriting existing values.

## Serve

Six fictional ministries, each with dated shifts, capacity, and onboarding requirements, are seeded from `backend/app/ministries.json`, and church info, FAQs, events and groups from `backend/app/church.json`. Seeding never overwrites existing rows.

- `GET /api/ministries`: departments, responsibilities, coverage, and sample contacts.
- `POST /api/matches`: a `description` (optional, up to 4,000 characters) and optional structured `preferences`; returns up to three AI-recommended ministries with reasons, details to confirm, and database-sourced contacts. Empty answers return every team to browse.
- `POST /api/ministries/{id}/apply` (public): apply to serve on a team with only what it needs: name, email, optional phone, and a `message` of 250 to 1000 characters in their own words: who they are, what they'd like to do and why (422 otherwise). The applicant only gets back that it was received; a second open application from the same email to the same team is not filed twice. Rate limited (429): 5 per visitor in 10 minutes and 100 per church in an hour, counted in the container by `CF-Connecting-IP` (`backend/app/ratelimit.py`).
- `GET /api/volunteers`, `PUT /api/volunteers/{id}` (staff): the applications, newest first, and a status (`new`, `accepted`, `waitlisted`, `declined`) and private note. Changing the status requires a note explaining it (400 otherwise), on trip applications too; that note becomes the staff note. Church staff → **Volunteers** shows them under **Serving teams**, next to **Mission trips** (the giving API's trip applications).
- `GET /api/connections`, `POST /api/connections`, `DELETE /api/connections/{connection_id}`: legacy saved connections (the old Serve > Saved tab); the site no longer shows them.
- `GET /api/requests`, `PATCH /api/requests/{request_id}`: care requests the chat passed to staff (pastoral care, prayer, crisis), shown in Church staff → **Care requests**. Team requests the chat filed before applications existed are moved to volunteer applications once.
- `GET /api/info`: public church details (address, service times) for the home page.

Find a place filters shifts deterministically (`backend/app/eligibility.py`: availability, service, frequency, requirements, open capacity) before the AI sees the catalog, then uses the chat's configured provider (`backend/app/recommendations.py`). With no provider it returns 503; a provider failure or invalid AI response returns 502. It never substitutes rule-based recommendations. Coverage numbers are the totals of each ministry's shifts. On startup, shifts and requirements missing from existing database rows are backfilled from the seed without overwriting saved values. Sample contacts use example.com and no introductions are sent. Applications, like care requests, are for signed-in staff on every church, the demo church included.

### Website chat (Ask Tekton)

The "Ask Tekton" chat (the Ask tab on phones, bottom-right button on desktop) talks to `POST /api/chat`, which runs a tool-calling loop against Gloo AI (`backend/app/chat.py`). The model can look up church info and FAQs, events, small groups, and ministries, file an application to a team (marked as from the chat; staff confirm its requirements when they reach out), or hand a conversation off to staff (pastoral care, prayer, crisis). Tool errors go back to the model so it can correct itself; the loop stops after 6 model rounds or 8 tool calls.

- Set `GLOO_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) with `npx wrangler secret put` in `api/`; the Worker passes it into the container. Without a configured provider, the widget uses limited local demo replies for service times, events, groups, ministries, and requests, with a banner saying so. `GLOO_MODEL` defaults to `gloo-qwen-3.7-flash`.
- Synthetic church content lives in `backend/app/church.json` and is seeded into `church_content` on startup.
- Nothing is sent to anyone automatically. Team applications appear in Church staff → Volunteers and care requests in Church staff → Care requests.
- Every user message, tool call, and reply is written to `chat_log`. `GET /api/chat/log/{session_id}` returns one session for auditing (API key required).
- The chat can suggest a page with a **Take me there** button: home, plan-visit, ministries, find-place, calendar, give, and prayer-map. A suggestion can also name a section to scroll to (home: service-times; plan-visit: service-times, what-to-expect, good-to-know, map, next-steps, sign-up), so "Where do I park?" lands on the parking card. The backend allowlists pages and sections (`SITE_PAGES` and `SITE_SECTIONS` in `chat.py`), and `frontend/src/chatNavigation.js` maps them to hash routes and element ids; the model cannot supply URLs or ids. To add a section, give the element an id and add it to both lists. The chat can also link to a page imported from the church's old website (`page: imported` with the slug from `list_pages`), which opens `#/p/<slug>`. For personalized serving suggestions, the chat points people to Find a place instead of ranking ministries itself.
- Guardrails: the system prompt keeps the assistant to church and site topics and tells it to decline everything else, and obvious prompt-override attempts ("ignore previous instructions", "system prompt", "developer mode") get a fixed reply without calling the model. These reduce off-topic use; they are not a guarantee.
- Replies may use **bold** and simple lists, rendered by `frontend/src/chatFormat.js` as React elements (never raw HTML).

#### Which AI does what

On Cloudflare, Gloo does all the language work, embeddings included. The one exception is transcription: Whisper stays on Workers AI because Gloo has no speech-to-text model (its [model catalog](https://platform.ai.gloo.com/platform/v2/models) lists none).

| Job | Model | When the model is unavailable |
| --- | --- | --- |
| Website chat, Find a place | Gloo (`GLOO_MODEL`, default `gloo-qwen-3.7-flash`) | Chat: `AI_FALLBACK` if set, else a "not configured" or office-contact reply. Find a place: the teams that fit the visitor's answers (deterministic filter). |
| Calendar summaries, blog summaries | Gloo (`GLOO_MODEL`) | The request reports an AI error; nothing is saved. |
| Blog categories | Gloo (`GLOO_MODEL`) | Keyword rules (`NLP_KEYWORD_RULES` in `backend/app/blog_ai.py`), so a post always gets categories. |
| Sermon-note questions | Gloo (`GLOO_MODEL`) | The extractive answerer: verbatim transcript quotes with timestamps, no model. |
| Sermon highlights (Bible quotes, personal stories, ...) | Gloo (`GLOO_NOTES_MODEL`, else `GLOO_MODEL`) | Per window: Workers AI `NOTES_LLM_MODEL` (llama-3.1-8b) through the Worker's `/llm` bridge, else that window is skipped. Highlights never fail a note. |
| Passage and question embeddings for sermon-note search | Gloo, `gloo-baai-bge-base-en-v1.5` (`GLOO_EMBED_MODEL`) | Keyword search over the same passages. |
| Transcribing sermon audio | Workers AI, `@cf/openai/whisper-large-v3-turbo` | The note fails with `transcription_failed` and can be retried. |

Every Gloo call uses `https://platform.ai.gloo.com/ai/v2/guarded/chat/completions` (embeddings: `/ai/v2/direct/embeddings`) with a Bearer key and `auto_routing: false`, and waits up to 60 seconds: `gloo-qwen-3.7-flash` reasons before it answers, and Cloudflare ends a proxied request after about 100. Replies are parsed leniently (a `<think>` block, a code fence or a sentence around the JSON is fine).

**Sermon highlights.** The container splits the transcript into windows of about 1,500 words, tags up to 3 windows at a time with Gloo, and stores which model did it on the note: `GET /api/notes/<id>` returns `highlight_engine`, for example `gloo:gloo-qwen-3.7-flash`. A note where some windows fell back says so (`gloo:...+workers-ai:@cf/meta/llama-3.1-8b-instruct-fp8`), `none` means no window could be tagged, and notes processed before this field existed show `""`.

- **Quotes versus references:** `bible_quote` means the speaker actually reads or recites a verse ("In the beginning God created the heavens and the earth"). Naming a passage, inviting people to open it ("let me invite you to open to Genesis chapter 1") or retelling it is `bible_paraphrase`, shown as "Bible references". The prompt defines both with examples, and a cheap check after the model (`_reference_not_quote` in `pastor_notes.py`) turns a "quote" into a reference when its words are navigation language ("turn to", "open to", "chapter", "let me invite you") with no clause that reads like verse text.
- **Re-categorize a note:** `POST /api/notes/<id>/recategorize` (or `/api/churches/<slug>/notes/<id>/recategorize`), with the `X-API-Key` or a staff session, re-runs highlights from the stored transcript. Nothing is downloaded or transcribed again. It answers 202 at once; `GET /api/notes/<id>` shows `highlight_engine: "recategorizing"` until it is done (a minute or two), then the model that tagged it. Notes processed before a prompt change keep their old labels until they are re-categorized:

  ```bash
  curl -fsS -X POST -H "X-API-Key: $NOTES_API_KEY" \
      https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev/api/churches/grace-community/notes/<id>/recategorize
  ```

**Sermon-note answers** come from Gloo when `GLOO_API_KEY` is set, and from the extractive answerer otherwise. Asking for `extractive` explicitly always wins, and any model answer that fails the citation check falls back to it.

**Deliberate non-model rules.** These stay deterministic because they are fast, free and do their job: the chat's prompt-override filter (`OVERRIDE_PATTERNS` in `chat.py`, in front of Gloo's guarded endpoint), Find a place's eligibility filter (availability and requirements), and the Prayer Map news filter in `newsdata.py` (drops ads, stock tickers and non-English items, and keeps headlines that name the country).

On the laptop build (`jaron-frontend`, `AI_PROVIDER=ollama`) the chat, Find a place, summaries and blog categories use the local Ollama through the same provider settings; sermon highlights use Gloo when `GLOO_API_KEY` is set there too.

Gloo serves embeddings (`POST https://platform.ai.gloo.com/ai/v2/direct/embeddings`, OpenAI-shaped; see [Gloo's guide](https://docs.gloo.com/api-guides/embeddings)), and `api/embed.ts` is the one place that calls it, for ingest (the container's `/embed` bridge) and for questions.

**Embeddings are tagged with their model.** Every chunk stores `embed_model` (for example `gloo:gloo-baai-bge-base-en-v1.5`), and a question is only compared with chunks that carry the current tag. Chunks stored before the switch were made by Workers AI (`@cf/baai/bge-base-en-v1.5`, cls pooling); they are tagged `workers-ai:@cf/baai/bge-base-en-v1.5:cls` and are never compared with Gloo vectors. Changing `GLOO_EMBED_MODEL` works the same way: old chunks simply stop matching the tag.

- **Re-embedding is lazy:** the first question on a note re-embeds its stale chunks from the stored chunk text. Nothing is transcribed again.
- **Backfill a whole church:** `POST /api/churches/<slug>/notes/reembed` (or `/api/notes/reembed` for the demo church), with the `X-API-Key` or a staff session. Each call does up to `?limit=` chunks (default 256, max 1024), saves after every batch of 64, and returns `{"embedded", "remaining", "done"}`. Call it again until `done` is true; it resumes where it stopped. Each church is its own database, so run it once per church:

  ```bash
  until curl -fsS -X POST -H "X-API-Key: $NOTES_API_KEY" \
      https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev/api/churches/grace-community/notes/reembed \
      | tee /dev/stderr | grep -q '"done":true'; do sleep 1; done
  ```
- **If Gloo embeddings fail or there is no key,** ingest still saves the transcript and the chunks, marked unembedded, and the note is ready. Questions then rank passages by shared topic words instead (`"retrieval": "keyword"` in the answer, with a `retrieval_reason`), and the chunks are embedded on a later question or backfill. Nothing falls back to embedding with a different model.

#### Tests

```bash
python -m unittest backend.tests.test_chat backend.tests.test_eligibility backend.tests.test_recommendations backend.tests.test_shifts backend.tests.test_churches
node --test frontend/src/*.test.js api/test/churches.test.mjs
```

Run the Python tests from the repo root with the backend requirements installed. They mock the database, so no church DB is needed.

## Sermon Notes

Upload a video (or paste a YouTube link). It is transcribed on Cloudflare (Whisper large-v3-turbo via Workers AI), chunked, embedded with Gloo (`gloo-baai-bge-base-en-v1.5`), highlighted by Gloo and stored, and questions are answered only from what the transcript supports. The sermon list and an open sermon have their own routes (`#/notes`, `#/notes/<id>`); on phones an open sermon takes over the page, with a back button.

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
        v  Gloo: gloo-baai-bge-base-en-v1.5 (embeddings, tagged with the model)
        v  Gloo: GLOO_NOTES_MODEL (highlights by category)
   chunks + highlights in the SQLite Durable Object
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
- **Gloo answers (when `GLOO_API_KEY` is set):** Gloo (`GLOO_MODEL`) writes
  prose answers, but every passage it cites is string-verified against the
  actual transcript, and any quote that fails falls back to the verbatim
  answer. The model can only make answers *prettier*, never less grounded.

### Highlights and Bible passages

The transcript is highlighted by category (Bible quotes, Bible references, current events, politics, personal stories, Scripture claims), and each category can be toggled. When a Bible quote or reference highlight names a passage (for example "Luke 10:25-26", "1 Cor. 13:4" or "Psalm 23"), the label is tappable and opens the passage under that line, with the version, copyright and a "Read on YouVersion" link.

- `frontend/src/verses.js` turns labels into USFM references (all 66 books, common abbreviations, Roman numeral prefixes, ranges) and loads the text.
- `GET /api/verse/versions` (public) lists the English Bibles the app key is licensed for (`GET /v1/bibles?language_ranges[]=en` on YouVersion, cached 6 hours), then the public-domain `web` and `kjv` ones not already listed: `{ default, listed, versions: [{ id, abbreviation, title, language, copyright, source }] }`. If the listing fails it offers just the default plus WEB and KJV, and that answer is not cached.
- `GET /api/verse?usfm=JHN.3.16-17&version=<id>` (public) reads the passage from the YouVersion Platform API with `YOUVERSION_APP_KEY` and caches it for 7 days per version and passage. `version` must be an id from that listing, or `web` / `kjv` (served from bible-api.com); anything else gets the default. If YouVersion fails, it answers from bible-api.com in the matching public-domain translation, else WEB, with `fallback: true` and `version` naming what came back. It returns 404 when no key is set (for a YouVersion version) and 400 for a bad reference.
- Readers pick the version under Reading in the Sermon Notes side panel; the choice is kept in localStorage with text size and timestamps.
- If the API is unreachable, the page falls back to bible-api.com itself: KJV for `kjv`, else the World English Bible.

### YouTube links: the YouTube helper

YouTube refuses most downloads from Cloudflare's data-center IPs, so a YouTube
link sent straight from the container usually fails. The **YouTube helper**
(`scripts/youtube-helper/`) fixes that: a small Python service that runs on
Jaron's dev server (`jaron-dev-server`, a home internet connection YouTube
accepts) and downloads only the audio with yt-dlp.

- **Order:** with `YT_HELPER_URL` and `YT_HELPER_KEY` set on the API Worker, a
  YouTube note is fetched through the helper first. If the helper is down or
  fails, the container tries yt-dlp directly (the old path, below). If that
  fails too, the note fails with "YouTube wouldn't let us download this video.
  Upload the video file instead (in YouTube Studio: Content > the video > ⋮ >
  Download)." A private or too-long video fails right away with its own message.
- **Wiring:** the container calls `http://youtube-helper/fetch`; the Worker's
  `youtube-helper` outbound handler (`api/ythelper.ts`) adds the key and forwards
  only `POST /fetch` to `YT_HELPER_URL`, so the container never sees the key.
- **The helper:** `POST /fetch {"url": ...}` with `Authorization: Bearer <key>`
  (checked in constant time) returns the audio (m4a when YouTube has it), or a
  JSON error. It accepts only youtube.com and youtu.be video links and hands
  yt-dlp the canonical `watch?v=<id>` link, so it cannot be pointed anywhere
  else. It enforces the same limits as the backend (`MAX_DURATION_SEC` 5400 and
  the 95 MB upload cap), runs at most two downloads at once, deletes its temp
  files, never logs the key, and updates yt-dlp every time it starts. A
  50-minute sermon downloads in about 12 seconds.
- **Where it runs:** a systemd user service, `youtube-helper`, on
  `127.0.0.1:8096`, published with Tailscale Funnel at
  `https://jaron-dev-server.tail90b62a.ts.net:8443` (that is `YT_HELPER_URL`).
  Funnel on port 443 is not used, so the dev server's tailnet-only pages stay
  private. The key is `~/.secrets/youtube-helper-key.txt`.

On the dev server:

```bash
scripts/youtube-helper/install.sh              # first time, or after changing helper.py: venv, key, unit, start
systemctl --user status youtube-helper         # is it running?
systemctl --user restart youtube-helper        # restart (also updates yt-dlp)
systemctl --user stop youtube-helper           # stop it; Sermon Notes falls back as described above
journalctl --user -u youtube-helper -f         # logs
tailscale funnel --bg --https=8443 http://127.0.0.1:8096   # publish it (once; survives restarts)
tailscale funnel --https=8443 off              # unpublish it
curl https://jaron-dev-server.tail90b62a.ts.net:8443/health
```

**When the helper is down** (the dev server is off or the service is stopped),
nothing breaks: YouTube links fall back to the direct download, and if YouTube
blocks that, the page asks for a file upload, which always works.

#### Direct download (the fallback)

Without the helper, YouTube intermittently refuses downloads from Cloudflare's
server IPs, so a YouTube link can fail with `youtube_blocked`. Workarounds:

1. **Upload the video file instead**: the "Upload a file" tab. 100%
   reliable, never touches YouTube's servers.
2. **Set the `YTDLP_COOKIES` secret**.

The block is flaky, not total, so the container retries on its own: yt-dlp
paces its requests and backs off on transient errors, and a bot check or rate
limit ("try again later") is retried after 30 s and again after 120 s before
the note fails with `youtube_blocked`. The delays come from
`YOUTUBE_RETRY_DELAYS` in the container environment (comma-separated seconds,
default `30,120`). yt-dlp is pinned with a minimum version rather than an exact
one, since YouTube support breaks on stale releases; a rebuild picks up the
latest.

#### Tests

```bash
python -m unittest backend.tests.test_youtube_helper backend.tests.test_youtube_helper_service backend.tests.test_youtube_download
node --test api/test/ythelper.test.mjs frontend/src/noteErrors.test.js
```

## Give

Giving runs on its own Worker (`api-giving/`). Each church has its own SQLite Durable Object, so churches' data is fully separate, and a small `GivingRegistry` object keeps church names and web addresses unique and lists them for the platform team (`#/platform`). The frontend talks to it through `VITE_GIVING_API_BASE` (or `/giving-api` on previews).

**Privacy.** Public pages show totals, goal progress and gift counts, never who gave. The Give form only asks for the fund, amount and one-time or monthly. Stripe Checkout asks the donor for their name (`name_collection[individual][enabled]=true`; on an older Stripe API version without it, the billing address form, which includes the name) and email. When the payment completes, the `checkout.session.completed` webhook (or the confirm lookup when the donor returns first) saves `customer_details.individual_name`/`name` and `customer_details.email` on the gift, and monthly renewals reuse them. Only signed-in church staff see them (in the Gifts list and CSV), for giving records and receipts; a gift still in Checkout shows "Waiting for Stripe". Name, email or `anonymous` sent by an older page are ignored. Demo gifts have no Stripe page, so they are recorded as "Demo donor" with no email. Gifts recorded as anonymous before have no name stored, so they still show as "Anonymous" to staff.

**Monthly gifts: manage or cancel on the website.** The Give page links to "Manage or cancel a monthly gift" (`#/give/manage`), and the thank-you screen after a monthly gift has a "Manage or cancel" button.

- With Stripe connected, setup also creates one Stripe customer portal configuration per church (cancel immediately, update card, see receipts) with its hosted login page turned on. The public church endpoint returns that login page as `portalUrl`; a donor enters their email there and Stripe sends a code. The thank-you button opens a portal session for the customer who paid that checkout session, and only that customer (for 7 days after the gift).
- In demo mode (no Stripe key, including Grace Community) a monthly gift gets a private link, `#/give/manage/<church>.<token>` (also under `#/c/<slug>/give/manage/...`). Only a hash of the token is stored. The link shows the gift (never the name or email) and lets the donor cancel it. Links are also remembered in that browser, so the manage page lists them.
- Staff can cancel any monthly gift from the Gifts list (with Stripe, this cancels the subscription there too). Canceled monthly gifts show "Monthly gift canceled" to staff. Gifts already made still count toward totals.
- When a donor cancels in the Stripe portal, the `customer.subscription.deleted` webhook marks the gift canceled.

**For a church:**

1. **Sign in to the existing church** (`#/staff`): use your staff email and password. For the initial Owner account, use the configured shared Owner login with email blank, then create your Owner account under Team. Owners can add Site admins. A church created from Tekton (`#/new`) gets its Owner account from the email and password typed in the Create your church form.
2. **Connect Stripe** in the staff area (`#/staff`) by pasting a Stripe secret key once. Use a test key first, then a restricted live key with write access to Products, Prices, Checkout Sessions, Webhook Endpoints, Customer portal and Subscriptions. The Worker checks the key with Stripe, stores it encrypted with `STRIPE_KEY_ENCRYPTION_KEY` (never returned to any client; staff only see a hint like `sk_test_…Ab12`), and creates:
   - one Product per fund and per mission trip, with preset Prices found again by `lookup_key` (plus monthly Prices for Tithes);
   - one webhook endpoint per church, so gifts are recorded even when the donor closes the tab, monthly tithes renew, and canceled monthly gifts are marked;
   - one customer portal configuration (found again by `metadata[belong_church]`), so donors can cancel a monthly gift themselves.

   Running setup again ("Re-run Stripe setup") reuses everything, so nothing is duplicated. It also adds any missing webhook events to an existing endpoint. A new fund or trip gets its own Product and Prices right away.
3. **Mission trips**: staff create trips with dates, location, goal, team spots and an open/closed switch for applications. People apply (name, email, phone, and why they want to go in 100 to 1000 characters) or give toward a specific trip. Staff accept, waitlist or decline, and add private notes. The public page only shows "3 of 12 spots filled".
4. **Staff area**: setup checklist, funds and trips, applications, a private gift list with CSV download, church details and password change.

Staff sign in with their own email and password (stored hashed). Sign-in gives a 12-hour session token, stored only as a hash; attempts are rate limited per IP, and changing the password signs out other sessions. There is no password reset yet.

The built-in demo church, **Grace Community** (`grace-community`), is locked to demo mode, so no real Stripe key can be attached to it. Its staff password is the `ADMIN_KEY` var.

Routes (all under the Worker origin, CORS limited to `ALLOWED_ORIGIN`):

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | `/api/health` | none | Liveness; `churches: true` means church support is deployed. |
| `GET` | `/api/churches` | none | Only the public demo church, whatever the query. Churches are not listed or searchable; kept so older builds still render. |
| `POST` | `/api/churches` | public (rate limited) | Creates a church and its Owner account from a Tekton draft; 5 per IP and 200 in total per hour. |
| `GET` | `/api/platform/churches` | `PLATFORM_ADMIN_KEY` (wrong keys rate-limited) | Every church for the platform team: slug, name, city, `createdAt`, `demo`, and `giving` (mode, currency, fund, trip and gift counts, total raised, setup checklist). 404 when the secret is not set. |
| `GET` | `/api/directory/{slug}` | none | One church listing (slug, name, city) from the registry. The church API uses it to check a church exists. |
| `GET` | `/api/churches/{slug}/admin/session` | staff session | 200 when the session is valid for that church. The church API uses it for its staff-only routes. |
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
- **Testing without Stripe**: `api-giving/test/fake-stripe.mjs` is a small fake Stripe server and `api-giving/test/api.test.mjs` runs the API checks against the real handlers via the localhost-only `test/local-worker.mjs` SQLite adapter, with internal test fixtures (`FIXTURE_API`). For the platform list, set the same `PLATFORM_KEY` for the local adapter and tests (and optionally `API_NO_PLATFORM` pointing at a separate runtime without it, to check the 404). Point the Worker at the fake with the `STRIPE_API_BASE` var (default `https://api.stripe.com`); never set it in production.
- Checkout success and cancel links go back to the frontend origin that started the gift (it must be listed in `ALLOWED_ORIGIN`). A checkout started from a branch preview returns to the live site.

## Calendar

Church events and services, seeded from `backend/app/events.json`, with a form to add events.

- `GET /api/events`, `GET /api/events/{event_id}`, `POST /api/events`.
- `POST /api/events/{event_id}/summarize` and `POST /api/events/summarize-all`: optional AI summaries (`GET /api/ai/status` says whether a provider is configured).

## Prayer map

A world map of the countries a church prays for, with news headlines and dated updates from the field for each. Staff add the places and their updates under Church setup, then Prayer map places (saved with the rest of the church through `PUT /api/church/content`, under `regions`); the demo church starts from `backend/app/regions.json`. Sharp facts, soft people: news gets an exact pin on a city, while a missionary team only ever gets its whole country (a soft glow and a beacon in the middle of the country, never a real location). Clicking a country shows the team's updates from the field (newest first, each with its date, so earlier ones stay as a history) and that country's news side by side.

- `GET /api/regions` (each region carries its `updates`, newest first), `GET /api/news`. Updates live in the `field_updates` table; an older single `testimony` becomes the region's first update. Prayer points were removed. The demo church's news is the real headlines in `backend/app/news_live.json` when that snapshot exists, replaced on every backend start; the fictional `backend/app/news.json` is only the fallback.
- `POST /api/news/refresh` (staff or API key): pulls live English stories for the region countries from NewsData.io (`NEWSDATA_API_KEY`), keeps each story's source link, and replaces that church's news. Answers 503 when `NEWSDATA_API_KEY` is not set.
- To refresh the snapshot instead: `cd backend && python -m scripts.fetch_news` (needs `NEWSDATA_API_KEY`), then commit `backend/app/news_live.json`.

## News

Updates and articles share one feed (`frontend/src/News.jsx`, `/api/blog`, table `blog_posts`). Anyone can read it; staff write, summarize and delete posts.

- `GET /api/blog`, `GET /api/blog/categories`, `GET /api/blog/{post_id}`: the feed, its categories and one post.
- `POST /api/blog` (staff): publish. **Updates** are short and point to a page or another website; **articles** are longer and can get AI key takeaways (`auto_summarize`).
- `POST /api/blog/categorize` (staff): suggest categories. When a poster publishes with no categories, the page first shows Tekton's suggestions so the poster can remove any that don't fit, then publish.
- `POST /api/blog/{post_id}/summarize`, `DELETE /api/blog/{post_id}` (staff).
- The demo church's updates are seeded from `backend/app/news_posts.json`.
