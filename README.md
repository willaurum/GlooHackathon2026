# GlooHackathon2026: Tekton

Liberty University's Gloo Hackathon team repository.

Tekton builds church sites from a website, uploaded materials, saved JSON files or answers to questions. Open `#/new` to import, review, customize and preview a site, then create the church with an individual Owner account. **Grace Community Church** (fictional, `grace-community`) is the demo church with synthetic content, and it is what the site shows until someone picks another church. See [Churches](#churches) for how that works. Every church has these areas:

- **Home**: service times, what's on this week, and links into every area.
- **Guests**: *Plan your visit* (service times, what to expect, a parking and entrances map, and a "let us know you're coming" form) and the *Welcome team* screen greeters use on Sunday.
- **Serve**: browse ministry teams, see where volunteers are needed, match a person to a team, and apply to join one (church staff review every application).
- **Sermon Notes**: sermons are transcribed on Cloudflare and highlighted (Bible quotes, current events, stories), Bible references open the passage from YouVersion, and questions are answered only from the transcript, with timestamps.
- **Calendar**: church events and services, with month, category and search filters.
- **Give**: private giving to a church's funds and mission trips through Stripe Checkout, mission trip applications, and staff-managed Stripe setup.
- **Prayer map**: the countries a church prays for, with dated updates from the field and real news.

An **Ask Tekton** chat assistant is available on every page.

## What is deployed

| Worker | URL | Purpose |
|---|---|---|
| `gloo-hackathon2026` | https://gloo-hackathon2026.jaronwilson2025.workers.dev | The live site: the React frontend built from `main` (static assets, repo root `wrangler.jsonc`). |
| `preview-jaron-frontend-gloo-hackathon2026` | https://preview-jaron-frontend-gloo-hackathon2026.jaronwilson2025.workers.dev | The integration preview: the latest `jaron-frontend`, which every PR goes into. Check new work here before it goes to `main`. It uses the two APIs below through its `/api` and `/giving-api` proxy. |
| `gloo-hackathon2026-api-pastor-notes` | https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev | Church API (`api/`): a Cloudflare **Container** running the FastAPI backend, a **SQLite Durable Object** database, **R2** for sermon media, **Workers AI** for transcription (Whisper) and **Gloo AI** for the language work, including sermon-note embeddings. Serves Serve, Guests, Calendar, Prayer map, the chat, Sermon Notes and Bible verses. |
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

## Visitors and church admin permissions

Visitors browse without an account. Staff sign in at **Staff sign in / Church setup**
(`#/setup`, or `#/c/<slug>/setup`) with their staff email and password.
Owners have every staff permission and can add or remove staff accounts. Site admins have
every staff permission except adding or removing accounts. Manage accounts in Church staff → Team.
There are no individual member accounts or member commenting permissions yet.

Staff sessions apply only to their own church. Admin controls appear only after the
session is validated. Calendar creation and summary generation, request review, saved
connections, the welcome queue, and church setup (including the Prayer map places) require staff
on every church, including Grace Community. Public event and summary reads remain open.
The shared AI model setting requires the operator API key, even on the demo church.
Sign out revokes the session on the server; expired or revoked sessions lose admin access.
Temporary sign-in service failures return 503 and keep the browser token for retry. Failed
sign-out keeps the dashboard and a retryable sign-out button visible. Password changes
keep the current admin page and confirmation message while replacing the session token.

Blog reads and staff-only write/categorize/summarize/delete/approve route permissions are
prepared for Ben's PR #52. That feature has not been merged into this branch: its UI must
hide editing controls for visitors when integrated. A separate draft/approval workflow
is not implemented by these permission rules.

## Repo layout

| Path | What's in it |
|---|---|
| `frontend/src/App.jsx` | Hash routing and the page shell. Routes: `#/`, `#/guests/plan`, `#/guests/welcome`, `#/serve`, `#/serve/find`, `#/notes`, `#/notes/<id>`, `#/calendar`, `#/give`, `#/give/trips`, `#/staff` (Church staff; shown in the nav only to signed-in staff), `#/prayer` (Prayer map), `#/about/news` (News), `#/setup` (Church setup) and `#/platform` (every church, for the platform team only; not in the navigation). Any route can be prefixed with a church, `#/c/<slug>/serve`; the older `#/give/c/<slug>` still works. Older `#/give/staff`, `#/start` and `#/give/start` links open Church staff, `#/blog` and `#/about/blog` open News, `#/prayer/map` opens the Prayer map, and `#/serve/saved` opens Serve. A section with sub-pages opens its first sub-page. |
| `frontend/src/News.jsx` | News, which replaced the separate blog. Two kinds of post share one feed (`/api/blog`, table `blog_posts`): **updates**, short posts that point to a page on the site or another website and never get key takeaways, and **articles**, longer reads with AI key takeaways and an optional link. Staff write, delete and summarize posts; the demo church's updates are seeded from `backend/app/news_posts.json`. |
| `frontend/src/church.js`, `ChurchContext.js` | Which church the site is showing (see [Churches](#churches)), shared links, and the staff session for this tab. Pages read the church with `useChurch()`. |
| `frontend/src/ChurchName.jsx`, `ChurchLink.jsx`, `ChurchSetup.jsx`, `ChurchStates.jsx` | The church name in the desktop top bar and the phone top bar (with Staff sign in on phones), the church's own link with a Copy button, Church setup for staff, and the shared empty, staff-only, not-found and not-yet-deployed states. |
| `frontend/src/Layout.jsx` | `SECTIONS` (the navigation), the pinned top bar on desktop (church, navigation with dropdowns for sub-pages, and Staff sign in), top bar and one-row bottom tab bar on phones, page header, `SubNav` sub-tabs. |
| `frontend/src/Home.jsx`, `Serve.jsx`, `Calendar.jsx`, `PrayerMap.jsx` | Those pages. |
| `frontend/src/VisitPage.jsx`, `WelcomeTeam.jsx`, `ChurchMap.jsx`, `visitMap.js` | Guests: Plan your visit, the greeter screen, and the parking and entrances map (each spot's color lives in `visitMap.js`). |
| `frontend/src/PastorNotes.jsx`, `verses.js` | Sermon Notes, and the Bible reference parser and passage loader. |
| `frontend/src/Platform.jsx`, `platformChurches.js` | `#/platform`, the platform team's list of every church (see [The platform list](#the-platform-list-for-the-team-building-tekton)). |
| `frontend/src/Give.jsx`, `GiveChurchBar.jsx`, `GiveStaff.jsx`, `giving.js` | Giving, the giving church bar, the giving staff area, and the giving API client. |
| `frontend/src/ChatWidget.jsx`, `chatFormat.js`, `chatHistory.js`, `chatNavigation.js` | Ask Tekton. |
| `frontend/src/styles.css` | Design tokens (`:root`) and all styles. |
| `frontend/src/api.js` | API helpers. `VITE_API_BASE` is the church API; `VITE_GIVING_API_BASE` is the giving API. `api()` calls go to the current church. |
| `frontend/src/data/` | Static data bundled into the site (`countryBorders.json` for the Prayer map). |
| `api/` | Church API Worker: container, one church database Durable Object per church, who may call what (`churches.ts`), Sermon Notes routes, `/api/verse`. Tests in `api/test/`. |
| `api-giving/` | Giving Worker, with tests in `api-giving/test/`. |
| `backend/app/` | FastAPI app that runs in the container: ministries, matching, chat (`chat.py`), visits, events, prayer map, Sermon Notes (`pastor_notes.py`), SQL (`db.py`), the church for each request (`church_scope.py`) and the church content import (`church_content.py`). Seed content is in the `*.json` files next to it. |
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

## Churches

Grace Community is the fictional demo of the base template. Existing church sites keep their own data and staff accounts. There is no public signup flow; future Agentic Website Builder provisioning is outside this change.

### Which church the site shows

`frontend/src/church.js` picks the church, in this order:

1. **Subdomain**: `<slug>.<VITE_BASE_DOMAIN>` (for example `hope-chapel.belong.example.org`), when the build sets `VITE_BASE_DOMAIN`. Off until there is a domain.
2. **Link**: a hash that names the church, `#/c/<slug>/serve`. The older giving link `#/give/c/<slug>` is rewritten to `#/c/<slug>/give`.
3. **Saved**: the church this browser picked last (localStorage `belong-church`). Opening a church link also saves it.
4. **Demo**: `grace-community`.

Routes without a church, like `#/serve`, keep working and use whichever church that picks, and the address bar is then rewritten to name it. Every link and in-app navigation names the church (`#/c/<slug>/serve`), the demo church too, so a copied address or a shared link (Church setup, the giving staff page) keeps the church. On a church subdomain the hash stays plain. The church name sits at the left of the desktop top bar, with **Staff sign in / Church setup** (`#/setup`) at its right end; on phones both sit in the top bar.

**Churches do not see each other.** There is no church list, search or switcher anywhere on the site (the hidden, key-protected [platform list](#the-platform-list-for-the-team-building-tekton) is for the team only): a visitor reaches a church only by its own link (`#/c/<slug>/` today, `<slug>.<BASE_DOMAIN>` once subdomains are on), and the saved church brings them back. The giving Worker's `GET /api/churches` no longer lists the registry; whatever the query, it answers with only the public demo church, so older builds still render. Exact lookups by slug (`/api/directory/<slug>`, `/api/churches/<slug>`) stay, since links need them. Church setup shows the church's link with a Copy button ("Share this link with your church"), plus its future subdomain when the build sets `VITE_BASE_DOMAIN`. An unknown slug shows "We could not find that church." with **See the demo church**, and is not kept as the saved church. Grace Community stays a public demo.

### The platform list (for the team building Tekton)

Churches never see each other, but the people building the site need to. `#/platform` is a hidden page (not in the navigation, not linked anywhere) that lists every church in the registry: name, city, the date it joined, its giving mode (demo, Stripe test or Stripe live), its number of funds and mission trips, its gift count and total, and whether giving setup is done (Stripe connected and a trip posted, the same checklist as the staff area). Each church has **Open site** (`#/c/<slug>/`), **Give page** and **Staff sign in** buttons, and a search box filters by name, city or link. Opening a church this way makes it this browser's church, like any church link.

The page asks once for the platform key and keeps it in `sessionStorage` (this browser tab only). It reads `GET /api/platform/churches` on the giving Worker, which is off (404) until the `PLATFORM_ADMIN_KEY` secret is set, and then needs `Authorization: Bearer <PLATFORM_ADMIN_KEY>`. Wrong keys are rate limited per IP like staff sign-in. The list never includes passwords or hashes, Stripe keys or hints, webhook or portal details, or any donor name or email. Before the giving Worker is deployed with this route and the secret is set, the page says "Not available yet. Deploy the giving Worker and set PLATFORM_ADMIN_KEY."

To turn it on: deploy `api-giving/` (merge to `main`, or Actions > Deploy backend), then `npx wrangler secret put PLATFORM_ADMIN_KEY --name gloo-hackathon2026-api-donate-giving` with a long random value (`openssl rand -base64 32`), and share it with the team only. To turn it off again, `npx wrangler secret delete PLATFORM_ADMIN_KEY --name gloo-hackathon2026-api-donate-giving`.

### One registry, individual staff accounts

The giving Worker (`api-giving/`) is the church registry and the staff sign-in for the whole site: existing church slugs, staff passwords (hashed) and 12-hour sessions. Nothing is duplicated in the church API. A staff session from Church setup or from Church staff is the same session and works on every page of that church, for that church only. It lasts for the browser tab.

Owner ("admin admin") and Site admin accounts are independent of church creation.
Sign in to the existing church as Owner, then open Church staff → Team.
If there are no accounts, use the configured shared Owner password with email blank and
create the first Owner account there. Then sign in with that account to add Site admins.
Owners add staff with a name, email, Owner or Site admin role, and a
temporary password of at least 10 characters. Staff change their own password in Overview;
only that account's other sessions are signed out. Removing an account revokes its sessions
immediately. You cannot remove yourself or the last Owner, and the first account must be an Owner.

For existing churches with no accounts, leave email blank to use the shared church password
as Owner. Once an account exists, new sign-ins require email and password. Existing shared
sessions remain valid until sign-out or expiry. Grace Community always retains the demo
Owner login with email blank; its password lives in `ADMIN_KEY` in `api-giving/wrangler.jsonc`.
`POST /api/churches` (creating a church from a finished Tekton draft) is open to anyone, with no invite code. New
churches are limited to 5 per IP and 200 in total per hour, and every new church starts with its own Owner account.
Internal church initialization remains for existing infrastructure and local test fixtures.

For the full local giving checks (Node 22.13+), run `node test/fake-stripe.mjs` and
`node test/local-worker.mjs` in separate terminals from `api-giving/`, then set
`API=http://127.0.0.1:8803` and `FIXTURE_API=http://127.0.0.1:8803/__fixtures/churches`
and run `node test/api.test.mjs`. The localhost-only adapter initializes test churches
through internal RPC, never through a production registration endpoint. It exercises
the real handlers and SQLite but does not substitute for Cloudflare runtime verification.

Run `node --test api-giving/test/staff-races.test.mjs` with Node 22.13+ for deterministic
account-removal and password-rotation concurrency checks using the real handlers and SQLite.

### How the church API knows the church

- Every call goes to `/api/churches/<slug>/...`, the same scheme as the giving API. The bare `/api/...` is the demo church, so the live site on `main`, open previews and older builds keep working unchanged against the new API.
- The Worker (`api/index.ts`, `api/churches.ts`) checks the slug with the registry (`GET /api/directory/<slug>` on the giving Worker over the `GIVING` service binding, cached for a minute), checks who may call the route, and forwards to the container with `X-Church`, `X-Church-Name` and `X-Church-City`. Headers with those names from a browser are dropped.
- In the container, `church_scope.py` puts that church around the whole request, and `db.run()` sends it with every SQL batch. The Worker routes each batch to that church database.

### Where the data lives

One SQLite Durable Object per church, named after the slug (`church:<slug>`). The demo church keeps the original database (`church`), so all existing data stays with Grace Community and there is nothing to migrate. Church info, service times, FAQs, events and groups, ministries and shifts, the calendar, visits and guests, connections and requests, the chat log, the prayer map and Sermon Notes are all in that one database, so one church can never read another church data. Uploaded sermon files go to the shared R2 bucket under a random id; only the church that owns the note can reach it.

The first request for an existing church creates its tables. Only the demo church is seeded from the JSON files (in `db.initialize`, every `INSERT` in the setup batch is skipped for other churches). Other configured churches use their stored name and city and empty sections, and each page shows a plain "not set up yet" state, with a button to Church setup for signed-in staff.

### Who may call what

| Routes | Demo church | Any other church |
|---|---|---|
| Info, church, ministries, events, matches, chat, guest sign-up and "I am here", viewing the prayer map, verse | public | public |
| Welcome team queue, claim and met; volunteer applications (read, review); care requests (read, review, delete); adding events and AI summaries | that church staff | that church staff |
| Church setup: `GET` and `PUT /api/church/content` | that church staff | that church staff |
| Edit your site: everything under `/api/church/editor` (draft, ask, publish, restore) | that church staff | that church staff |
| Staff accounts: `GET /api/churches/<slug>/admin/users` | that church staff | that church staff |
| Add or remove staff: `POST /api/churches/<slug>/admin/users`, `DELETE /api/churches/<slug>/admin/users/<id>` | Owner only | Owner only |
| Sermon Notes and the chat log | `NOTES_API_KEY` or that church staff | `NOTES_API_KEY` or that church staff |
| The shared AI model setting (`POST /api/ai/model`) | `NOTES_API_KEY` | `NOTES_API_KEY` |

The demo church staff password is the `ADMIN_KEY` var in `api-giving/wrangler.jsonc`.

### Church content import (the target for a site importer)

A church is one JSON document, read with `GET /api/church/content` and written with `PUT /api/church/content` (staff only, up to 512 KB). Church setup saves through it, and it is what a future importer (a church gives us its old website, we build its Tekton site) should produce. Every section is optional; a section that is sent replaces that whole section, and the rest is left alone. Items without an `id` get one. It is exactly the demo seed files combined, so `church.json` + `{"ministries": ministries.json}` + `{"calendar": events.json}` is a valid import (a test checks this). The schema is in `backend/app/church_content.py`:

```jsonc
{
  "info": {                       // church.json "info"
    "name": "Hope Chapel",         // required
    "city": "Austin, TX", "address": "120 Example Street", "phone": "", "email": "", "office_hours": "",
    "services": [{ "day": "Sunday", "time": "10:00am", "note": "Kids programs during the service" }],
    "about": "", "first_visit": "", "care_team": "", "map_query": ""
  },
  "faqs":   [{ "id": 0, "question": "Where do I park?", "answer": "Behind the building." }],
  "events": [{ "id": 0, "name": "Newcomer lunch", "when": "First Sunday, 12:30pm", "where": "Hall", "audience": "Newcomers", "description": "" }],
  "groups": [{ "id": 0, "name": "Young adults", "when": "Tuesdays, 7pm", "where": "", "audience": "Ages 20 to 35", "description": "" }],
  "ministries": [{                 // ministries.json; leaders are "head" and "email"
    "id": 0, "name": "Greeters", "category": "", "icon": "", "description": "", "day": "Sunday mornings",
    "head": "Pat Example", "email": "pat@example.com", "note": "", "skills": [], "style": "",
    "total": 6, "filled": 0, "requirements": [],
    "shifts": [{ "id": "0-1", "date": "2026-10-11", "start_time": "08:30", "end_time": "10:30", "filled": 0, "total": 6,
                 "services": ["sunday-9"], "frequencies": ["one-time", "weekly", "monthly"] }]
  }],
  "calendar": [{ "id": 1, "title": "Serve Day", "category": "Outreach", "date": "2026-10-17", "time": "9:00 AM", "location": "", "description": "" }],
  "regions": [{                    // regions.json; one entry per country, country_code is ISO 3166-1 alpha-3
    "id": 0, "country": "Nepal", "country_code": "NPL", "codename": "Team Highland",
    "field_of_ministry": "Community health training", "since": 2019, "team_size": 4,
    "updates": [{ "date": "2026-05-01", "title": "", "body": "What the team is seeing.", "author": "Pat" }]   // From the field
  }]
}
```

Extra fields are kept. A ministry that saved connections or requests still point at is not deleted by an import, so those stay readable. Giving funds and mission trips are not part of this document: they live in the giving Worker (`/api/churches/<slug>/admin/funds`), with the same staff session. Prayer map places and their field updates are in it under `regions`.

### Edit your site

Staff change their live site through a draft (`backend/app/site_editor.py`). Every change is one checked operation; nothing is live until they publish, and the version before the last publish can be restored.

- `GET /api/church/editor`: the state, `{version, ops, changes, published, published_at, previous}`. `published` is the live content (the `GET /api/church/content` shape); `changes` has one entry per operation with a plain label and the value before and after.
- `PUT /api/church/editor/draft` with `{version, ops}` (up to 80 operations, 1 MB, counted on the body as it arrives in the Worker and the container): replaces the draft. 409 when `version` is not the stored one; 422 `{detail, op}` names the first operation that is not allowed.
- `DELETE /api/church/editor/draft`: discards the draft.
- `POST /api/church/editor/ask` with `{request, viewing, version}`: Tekton suggests operations, added to the draft as `pending` (plain rules first, else one AI call whose operations are checked the same way; wording it places must appear in the request, word for word apart from case, spacing and punctuation). Requests Tekton never makes (adding people, beliefs, facts Church setup owns) are turned down with the reason. 10 per address and 10 per staff session in 10 minutes, and 60 per church in an hour, counting only requests that pass the version and safety checks (429).
- `POST /api/church/editor/publish` with `{version}`: applies the accepted operations to the live content and writes only the sections they change (`info`, `site`, `pages`, `staff`, `faqs`), recording each field it changed with the value before and the value written. 409 while a suggestion is pending, or when the content changed while publishing; the labels of what changed are in `published_changes`.
- `POST /api/church/editor/restore`: puts back only the fields the last publish changed, and only where they still hold what it wrote; a field changed since (in Church setup or elsewhere) is kept and named in `kept`, the rest in `restored`. Restoring again is the exact inverse.

Publish, restore and `PUT /api/church/content` share one lock in the container, and each content write bumps a version in `config` (`content_version`) that publish and restore check inside their write, so neither can overwrite a Church setup save made in between.

The operations: `set_text` (the Home headline, about and what to expect texts, the template wording in `backend/app/site_copy.json` stored as `site.copy`, imported page titles and sections, staff names, roles and bios, and FAQs; plain text only), `set_style` (colors and fonts in `site.theme`, kept readable by the builder's rules, and heading sizes in `site.style`: `heading_scale` 0.8 to 1.3, `hero_scale` 0.7 to 1.3), `move_section`, `hide_section` and `show_section` (Home and Plan your visit, `site.layout`), and `hide_page` and `show_page`. Facts with structure or side effects (name, address, service times, contacts, ministries, events and the like) stay in Church setup. The draft, the previous version and the publish time are in the church's `config` table (`site_editor:draft`, `site_editor:previous`, `site_editor:published_at`).

### Agentic builder

Anyone can open `#/new`, a standalone **Create your church site** page, to follow **Import → Clarify → Review → Create your church**. Import an existing website, resolve conflicts using the page and exact quote behind each candidate, fill missing details, and review or edit the confirmed content. **Preview your site** opens the normal site template at `#/new/preview`, filled with the draft's content, without an account. Navigation stays in preview, a banner links back to the builder, and live actions are disabled. Public church registration remains closed; the create step explains this and offers the preview. The browser tab remembers the draft and any previously created church across reloads. If loading fails after an earlier signup, **Try again** applies to the same church. Import notes show when pages or sources were skipped. The in-church `#/build` page and its Church setup entry have been removed.

Import can also start with **Upload church materials** (1–5 PDF, text, HTML, DOCX or PNG/JPEG/WebP files, each up to 5 MB and at most 10 MB total), or **Answer questions instead**. File evidence shows the filename and exact quote. Scanned PDFs and images use the vision reader when configured; otherwise import notes explain why they were skipped. All three choices share the same claims, questions, answers, review and preview flow.

The backend is `backend/app/builder.py`. Public routes are `POST /api/builder/drafts` (a website import: answers 202 and runs in the background; poll the draft until its status is no longer `importing`), `/blank` or `/upload` (multipart field `files`), `GET /api/builder/drafts/<id>` or `/site`, and `POST /api/builder/drafts/<id>/answers`, `/items` (include, leave out or edit an imported event, person, ministry, group, location or sermon), `/parts` (keep or leave out imported pages, links, forms, players and images, and confirm permission for images) or `/preview`, and `GET /api/builder/drafts/<id>/pages/<page>` (one imported page). Website imports follow robots.txt (including `Crawl-delay`) for every host, read the sitemap and up to 40 pages, most useful first, plus calendar and sermon feeds and the site's stylesheets, and keep the site's menu, pages, calls to action, forms, players, colors and fonts so it can be recreated (applied pages are public at `GET /api/church/pages/<slug>` and shown at `#/p/<slug>`); see `docs/agentic-builder.md`. The content preview requires all questions to be answered. The read-only site snapshot also accepts unfinished drafts and returns the same info, church, ministries and calendar shapes as the live public endpoints, without writing a church database. `POST /api/builder/drafts/<id>/apply` requires the target church's staff session, refuses the demo church, and consumes the draft after a successful write. All other builder paths stay staff only; the old sessions routes are gone.

Drafts are church-independent: they live in the reserved platform database space `builder`, in its `config` table as `draft:<id>`. The registry reserves the `builder` slug. Only the unguessable draft id grants public access; drafts expire 24 hours after creation, and page texts stay on the server. Public imports refuse private-network addresses and are limited to 5 starts per client IP per rolling hour, 60 overall per hour, and 3 concurrent imports in the single backend container. Limit failures return 429; the Worker forwards Cloudflare's client IP header.

On Cloudflare the container can only reach the hosts in `allowedHosts`, and a church's website can be anywhere, so the builder fetches pages and images through the Worker: the container gets `BUILDER_FETCH_URL=http://builder-fetch`, and the `builder-fetch` outbound handler (`api/builderfetch.ts`) does the request. It allows http(s) on the default ports only, refuses credentials, local names (`localhost`, `.local`, `.internal`, single-label names), and any private, loopback, link-local, metadata or reserved IP, whether it is in the URL or what the name resolves to (checked over DNS-over-HTTPS), and checks every redirect the same way. Pages, sitemaps and feeds are cut at 1 MB, stylesheets at 500 KB, images over 4 MB are refused, and each fetch has 10 seconds. The builder's AI runs on Gloo like everything else, with a fast model that also reads images: `GLOO_BUILDER_MODEL`, then `GLOO_MATCH_MODEL`, then `gloo-anthropic-claude-haiku-4.5`. When the AI is offline or slow, the import still finishes with the rule-based details and says so in its notes.

#### What Tekton shows while it works, and what it will not do

- **Live progress.** While a website import runs, the draft's `progress.steps` fills in about once a second ("Read “Visit” (visit page)", "Staff reader on “Our Team”: 4 found", "Checking facts… 2 unsupported claims removed"), and `#/new` shows them as they come. A finished draft keeps the full list and a summary in `run`: pages read, seconds, AI calls, tokens and an estimated cost from Gloo's published per-model prices (`backend/app/builder_run.py`).
- **Fact check.** Every AI answer must quote its page. Answers whose quote is not on the page, or that are not a detail Tekton asked for, are dropped and counted, and the count is shown.
- **Sources.** `GET /api/builder/drafts/<id>/site` also returns `provenance`. On `#/new/preview`, imported facts (service times, address, About, ministries, staff, campuses) show where they came from on hover, focus or tap; **Sources shown** in the banner turns this off. Source links use [text fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments) (`#:~:text=`) so the church's page opens scrolled to the quote, with a few words before and after it to pick the right spot (`frontend/src/sourceLink.js`). Chrome, Edge, Safari and Firefox 131+ support them; older browsers just open the page.
- **Changes in plain words.** `POST /api/builder/drafts/<id>/edits` with `{"request": "Put service times above ministries"}` turns a request into checked operations: move or hide a section of Home or Plan your visit, change a detail, or leave out a list entry. Common requests are matched by rules; anything else goes to the AI as a strict tool call, and every operation is validated before it is applied. `/edits/undo` undoes the last 5. The order is saved as `site.layout`, which Home and Plan your visit follow (`backend/app/builder_edit.py`).
- **Sites that build themselves in the browser.** When the pages are an app shell (little text, many scripts, or a Wix/Squarespace generator), Tekton says so and switches to questions instead of importing empty pages.
- **Beliefs are never summarized.** A statement of faith is kept word for word and left off the new site until the pastor confirms it (`POST /api/builder/drafts/<id>/beliefs` with `{"confirmed": true}`). A placeholder ("under construction") is not imported; it becomes something for the pastor to add.

### Adding an endpoint

Nothing extra: any endpoint that goes through `db.py` already runs against the church of the request. In the Worker, add the route to the right list in `api/churches.ts` (public, staff work that the demo church leaves open, or staff only); a route on no list needs the API key or a staff session. A new table goes in `db.initialize` as usual. Its seed `INSERT`s only run for the demo church.

### Making it live

1. Merge to `main` (or run Actions > Deploy backend). Deploy `api-giving/` first or together with `api/`: the church API needs the giving `/api/directory/<slug>` and `/admin/session` routes and the `GIVING` service binding in `api/wrangler.jsonc`.
2. No new secrets, no new Durable Object classes, no migrations. Existing data stays with Grace Community.
3. Until the church API is deployed, the site shows Grace Community as before, and a new church shows giving plus a short "this part opens once the updated church service is deployed" page. The site checks `GET /api/health` for `churches: true` (both APIs).

### Subdomains, once there is a domain

Nothing here buys or sets up a domain. When there is one (say `belong.example.org`):

1. DNS: add the domain to Cloudflare and a proxied wildcard record `*.belong.example.org` (and the apex), pointing at the frontend Worker.
2. Frontend Worker (repo root `wrangler.jsonc`): add routes `belong.example.org/*` and `*.belong.example.org/*` with `zone_name`, and build with `VITE_BASE_DOMAIN=belong.example.org`. Then `hope-chapel.belong.example.org` shows Hope Chapel, the demo church is `grace-community.belong.example.org`, the picker moves between subdomains, and shared links use them.
3. APIs: set the `BASE_DOMAIN` var to `belong.example.org` in both `api/wrangler.jsonc` and `api-giving/wrangler.jsonc`. Their CORS check then accepts `https://belong.example.org` and `https://<slug>.belong.example.org` on top of `ALLOWED_ORIGIN`. Optionally give the APIs their own hostnames (`api.belong.example.org`, `giving.belong.example.org`) and update `VITE_API_BASE` and `VITE_GIVING_API_BASE`.
4. Stripe: checkout returns to the origin that started the gift, so a gift from `hope-chapel.belong.example.org` comes back there once that origin is allowed (step 3). Set `PUBLIC_ORIGIN` in `api-giving/` to the giving API hostname and press "Re-run Stripe setup" for each connected church so its webhook points at the new address.
5. Slugs: a subdomain is the church slug, so slugs are already DNS-safe (lowercase letters, digits and dashes, up to 40 characters), and the registry never hands out names like `www`, `api`, `app`, `admin` or `mail`.

### Testing churches locally

```bash
python -m unittest backend.tests.test_churches        # isolation, the demo default, new churches, the import
node --test api/test/churches.test.mjs frontend/src/church.test.js
node api/test/sitewide.e2e.mjs                        # both APIs running locally; see the comment at the top
```

`api/test/sitewide.e2e.mjs` checks public signup and required Owner details, then initializes two made-up churches through localhost-only internal fixtures and checks that staff-only routes need that church session, one church cannot read or change another, and requests with no church still go to Grace Community. Run `api-giving/test/local-worker.mjs` from `api-giving/`, set `GIVING=http://127.0.0.1:8803` and `FIXTURE_API=http://127.0.0.1:8803/__fixtures/churches`, and provide the church API at `API` with its `GIVING` binding connected to the adapter.

## Keys and access

Secrets are set with `npx wrangler secret put <NAME>` in the worker's directory (or with `--name <worker>` from anywhere). They are never in the repo.

| Secret | Worker | What it does |
|---|---|---|
| `NOTES_API_KEY` | `api/` | Required for Sermon Notes routes. The page asks for it once and keeps it in the browser tab only. |
| `NOTES_ADMIN_KEY` | `api/` | Changing the church config. |
| `YOUVERSION_APP_KEY` | `api/` | YouVersion Platform app key for Bible passages in Sermon Notes. Optional `YOUVERSION_BIBLE_ID` picks the default version (default `3034`, Berean Standard Bible); readers can switch to any other version the key is licensed for. |
| `YTDLP_COOKIES` | `api/` | Optional; helps YouTube downloads (see below). |
| `YT_HELPER_URL` / `YT_HELPER_KEY` | `api/` | Optional. The [YouTube helper](#youtube-links-the-youtube-helper) that downloads YouTube audio from Jaron's dev server. Set `YT_HELPER_URL` as a GitHub Actions **variable** and `YT_HELPER_KEY` as a GitHub **secret**; Deploy backend copies both to the Worker. The key stays in the Worker. |
| `GLOO_BUILDER_MODEL` | `api/` | Optional GitHub Actions **variable**; Deploy backend copies it to the Worker. The agentic builder's Gloo model (default: `GLOO_MATCH_MODEL`, then `gloo-anthropic-claude-haiku-4.5`). |
| `GLOO_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `api/` | Optional; switches the chat from demo replies to a real model. `GLOO_API_KEY` also turns on sermon-note embeddings. |
| `GLOO_EMBED_MODEL` | `api/` | Optional, not secret. The Gloo embedding model for sermon-note search (default `gloo-baai-bge-base-en-v1.5`). Set it as a GitHub Actions **variable**, next to `GLOO_MODEL`; Deploy backend copies both to the Worker. |
| `GLOO_NOTES_MODEL` | `api/` | Optional, not secret. The Gloo model that tags sermon highlights (default: `GLOO_MODEL`, then `gloo-qwen-3.7-flash`). Also a GitHub Actions **variable**; Deploy backend copies it to the Worker, which passes it to the container. |
| `STRIPE_KEY_ENCRYPTION_KEY` | `api-giving/` | Encrypts each church's stored Stripe key. Without it, churches cannot connect Stripe. If it is lost or changed, churches must paste their Stripe keys again. |
| `PLATFORM_ADMIN_KEY` | `api-giving/` | Optional. Turns on the platform team's list of every church (`GET /api/platform/churches` and the `#/platform` page). Set with `npx wrangler secret put PLATFORM_ADMIN_KEY --name gloo-hackathon2026-api-donate-giving`. Without it the route is a 404. Never give it to a church. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `api-giving/` | Legacy single-church settings from before church sign-up. Churches now connect their own Stripe key from the staff area. |

### Which keys are set, and where our copies are

Workers secrets cannot be read back once set, so Jaron keeps a copy of each key he made on the dev server (`jaron-dev-server`) in `~/.secrets/`, readable only by his account. The values are never written in this repo.

| Secret | Set on | Copy |
|---|---|---|
| `PLATFORM_ADMIN_KEY` | `gloo-hackathon2026-api-donate-giving` | `~/.secrets/gloo-platform-admin-key.txt` |
| `STRIPE_KEY_ENCRYPTION_KEY` | `gloo-hackathon2026-api-donate-giving` | `~/.secrets/gloo-stripe-key-encryption-key.txt` |
| `YOUVERSION_APP_KEY` | `gloo-hackathon2026-api-pastor-notes` | `~/.secrets/youversion-app-key.txt` (app `belong-Gloo-Hackathon2026` on platform.youversion.com) |
| `YT_HELPER_KEY` | GitHub secret, copied to `gloo-hackathon2026-api-pastor-notes` | `~/.secrets/youtube-helper-key.txt` (the helper reads the same file) |

- **Opening the platform list:** run `cat ~/.secrets/gloo-platform-admin-key.txt` on the dev server, open `<site>/#/platform` and paste the key. Share it with the team in person or through a password manager, never in chat or in a commit.
- **Seeing what is set:** `npx wrangler secret list --name <worker>` shows the names (never the values).
- **Replacing a key:** `openssl rand -base64 32 | tee ~/.secrets/<file> | npx wrangler secret put <NAME> --name <worker>`. Replacing `STRIPE_KEY_ENCRYPTION_KEY` means every church must paste its Stripe key again, so only do it if it leaked.

Browsing Serve, Guests, Calendar, the Prayer map, the verse and chat is public, like the rest of a church website. Sermon Notes, uploads, the chat log and admin routes need a key or that church staff session; screens with people and their contact details, and generating AI summaries or prayer-map prompts, are staff only on every church, the demo church included (see [Who may call what](#who-may-call-what)). Churches add no new secrets: the church API reaches the giving Worker through the `GIVING` service binding.

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
- `POST /api/ministries/{id}/apply` (public): apply to serve on a team with only what it needs: name, email, optional phone, and a `message` of 250 to 1000 characters in their own words: who they are, what they'd like to do and why (422 otherwise). The applicant only gets back that it was received; a second open application from the same email to the same team is not filed twice. Rate limited (429): 5 per visitor in 10 minutes and 100 per church in an hour, counted in the container by `CF-Connecting-IP` (`backend/app/ratelimit.py`).
- `GET /api/volunteers`, `PUT /api/volunteers/{id}` (staff): the applications, newest first, and a status (`new`, `accepted`, `waitlisted`, `declined`) and private note. Changing the status requires a note explaining it (400 otherwise), on trip applications too; that note becomes the staff note. Church staff → **Volunteers** shows them under **Serving teams**, next to **Mission trips** (the giving API's trip applications).
- `GET /api/connections`, `POST /api/connections`, `DELETE /api/connections/{connection_id}`: legacy saved connections (the old Serve > Saved tab); the site no longer shows them.
- `GET /api/requests`, `PATCH /api/requests/{request_id}`: care requests the chat passed to staff (pastoral care, prayer, crisis), shown in Church staff → **Care requests**. Team requests the chat filed before applications existed are moved to volunteer applications once.
- `GET /api/info`: public church details (address, service times) for the home page.

Find a place filters shifts deterministically (`backend/app/eligibility.py`: availability, service, frequency, requirements, open capacity) before the AI sees the catalog, then uses the chat's configured provider (`backend/app/recommendations.py`). With no provider it returns 503; a provider failure or invalid AI response returns 502. It never substitutes rule-based recommendations. Coverage numbers are the totals of each ministry's shifts. On startup, shifts and requirements missing from existing database rows are backfilled from the seed without overwriting saved values. Sample contacts use example.com and no introductions are sent. Applications, like care requests, are for signed-in staff on every church, the demo church included.

### Website chat (Ask Tekton)

The "Ask Tekton" chat (the Ask tab on phones, bottom-right button on desktop) talks to `POST /api/chat`, which runs a tool-calling loop against Gloo AI (`backend/app/chat.py`). The model can look up church info and FAQs, events, small groups, and ministries, file an application to a team (marked as from the chat; staff confirm its requirements when they reach out), or hand a conversation off to staff (pastoral care, prayer, crisis). Tool errors go back to the model so it can correct itself; the loop stops after 6 steps.

- Set `GLOO_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) with `npx wrangler secret put` in `api/`; the Worker passes it into the container. Without a configured provider, the widget uses limited local demo replies for service times, events, groups, ministries, and requests, with a banner saying so. `GLOO_MODEL` defaults to `gloo-anthropic-claude-haiku-4.5`.
- Synthetic church content lives in `backend/app/church.json` and is seeded into `church_content` on startup.
- Nothing is sent to anyone automatically. Team applications appear in Church staff → Volunteers and care requests in Church staff → Care requests.
- Every user message, tool call, and reply is written to `chat_log`. `GET /api/chat/log/{session_id}` returns one session for auditing (API key required).
- The chat can suggest a page with a **Take me there** button: home, plan-visit, ministries, find-place, calendar, give, and prayer-map. A suggestion can also name a section to scroll to (home: service-times; plan-visit: service-times, what-to-expect, good-to-know, map, next-steps, sign-up), so "Where do I park?" lands on the parking card. The backend allowlists pages and sections (`SITE_PAGES` and `SITE_SECTIONS` in `chat.py`), and `frontend/src/chatNavigation.js` maps them to hash routes and element ids; the model cannot supply URLs or ids. To add a section, give the element an id and add it to both lists. For personalized serving suggestions, the chat points people to Find a place instead of ranking ministries itself.
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

#### Two branches: laptops, or Cloudflare

Nothing in this project depends on a machine that is neither a laptop nor Cloudflare. Two branches keep that honest:

- **`jaron-frontend`** runs entirely on a laptop: docker compose brings up the frontend, the FastAPI backend and Postgres, and the AI is an Ollama reached from the container. Set `AI_PROVIDER=ollama` in `.env`; see the HPC tunnel section below, or point `OLLAMA_BASE_URL` at an Ollama on that same laptop.
- **`jaron-cloudflare-frontend`** runs entirely on Cloudflare: Workers, the container, a Durable Object per church database, and Gloo AI over HTTPS. The only setup is one secret, run in `api/`:

  ```
  npx wrangler secret put GLOO_API_KEY
  ```

  Nothing else is needed. `AI_PROVIDER` is not passed into the container, so it takes its default of `gloo` from `backend/app/config.py`, and `platform.ai.gloo.com` is already in the container's `allowedHosts`. No laptop is in the path: no VPN, no SSH tunnel, no teammate running a bridge.

Both branches build from the same source and differ in configuration, not behaviour. Keep the `jaron-` prefix on any new branch: `previews.yml` triggers on prefixes, so a name outside its patterns is a branch that silently never deploys.

#### Running on one laptop

```bash
git clone <repo> && cd GlooHackathon2026
docker compose up -d
```

That is the whole setup. No `.env`, no API key, no VPN, no SSH tunnel and no firewall change. The frontend is on <http://localhost:3000> and the API on <http://localhost:8000>.

The AI is an `ollama` container beside the backend, so the backend reaches it at `http://ollama:11434/v1` over the compose network. Nothing crosses to the host, which is what makes the firewall irrelevant and makes it behave the same on Linux, macOS and Windows. A container that talks to the host instead has to get past the host's firewall: on Ubuntu `ufw` defaults to dropping every container-to-host connection, and Windows Defender does the same, which is the usual reason `host.docker.internal` times out.

The first `docker compose up` downloads the Ollama image and the model (`llama3.2:3b`, about 2 GB) into the `ollama_models` volume, so it takes a few minutes once and starts quickly afterwards. `ollama-pull` is a one-shot service that exits 0 when the model is in place; the backend waits for it.

On the CPU a chat reply takes roughly 40 seconds and a calendar summary about 6. With an NVIDIA GPU and the NVIDIA Container Toolkit installed, this is much faster:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

To use a larger model, set `OLLAMA_MODEL` in `.env` before the first start (`docker compose up -d ollama-pull` fetches it). To use an Ollama elsewhere instead of the container, set `OLLAMA_BASE_URL`; the HPC tunnel below is one way to do that, and is the one path that needs host networking.

#### HPC Ollama for local development

Everyone runs this on their own machine: the Liberty student VPN, the SSH tunnel, and docker compose. Nothing is shared between teammates and no fixed addresses are involved.

With the VPN connected, keep an SSH tunnel open (replace `YOUR_USERNAME`):

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 0.0.0.0:11434:arrietty.hpc.lan:11434 YOUR_USERNAME@totoro.university.liberty.edu
```

Then put this in `.env` beside `docker-compose.yml`:

```
AI_PROVIDER=ollama
OLLAMA_MODEL=gpt-oss:20b
```

Leave `OLLAMA_BASE_URL` unset. Under docker compose it defaults to `http://host.docker.internal:11434/v1`, the tunnel on your own machine, and `AI_BASE_URL` and `AI_MODEL` follow it, so there is nothing else to set. Outside Docker the backend falls back to `http://127.0.0.1:11434`. No API key is needed, and the chat adds `/v1` if it is missing. Both Find a place and the chat use it.

The bind address matters. `-L 0.0.0.0:11434` is what lets the container reach the tunnel; with the older `-L 127.0.0.1:11434` the tunnel accepts only loopback connections, and a container arrives over the Docker bridge instead. On Docker Desktop (macOS and Windows) loopback happens to work, because `host.docker.internal` is proxied through its VM, so `0.0.0.0` is the one spelling that works everywhere.

On Linux, also let the Docker bridges reach the host. With `ufw` enabled this is not specific to Ollama: `DEFAULT_INPUT_POLICY="DROP"` drops every container-to-host connection, so `host.docker.internal` reaches nothing at all. Ubuntu ships `ufw` inactive, so most machines never meet this; `sudo ufw status` says whether yours is one of them. The symptom is a timeout on `/api/ai/status` while the same URL answers from a terminal on the host. To confirm it is the firewall rather than the tunnel, reach for a port you know is open:

```bash
docker compose exec backend python -c "import socket;socket.create_connection(('172.17.0.1',22),5)"
```

A timeout there means the firewall, since that port has nothing to do with this project. Then allow the bridges:

```bash
sudo ufw allow from 172.17.0.0/16 to any port 11434 proto tcp
sudo ufw allow from 172.22.0.0/16 to any port 11434 proto tcp
```

Use the subnets rather than interface names: the compose bridge is named `br-<id>` and is renamed whenever the network is recreated. `docker network inspect <project>_default` prints the subnet in use if it differs.

Check it with `GET /api/ai/status`: `connected: true` and the model list means the tunnel is reachable. `connected: false` with the tunnel running is the firewall or the bind address above. If the tunnel's own far end is down, `curl 127.0.0.1:11434/api/tags` on the host returns nothing at all rather than JSON. Once it is up, `gpt-oss:20b` answers a chat turn or a calendar summary in about three seconds.

This tunnel only works locally, not from Cloudflare; for the deployed site, see the team AI bridge below.

#### Team AI bridge (deployed site, team only)

A stopgap until the Gloo AI key arrives on Oct 7. A teammate on the Liberty VPN runs `scripts/team-ai-bridge/` (one command; see [its README](scripts/team-ai-bridge/README.md)). It puts the HPC model behind a gatekeeper that requires the team key and connects that to a named Cloudflare Tunnel with a fixed hostname, `https://team-ai.jaronwilson.dev`. The container calls `http://team-ai/v1`; the Worker's `team-ai` outbound handler (`api/teamai.ts`) adds the key and forwards only the model list and chat completions. So the container never sees the key, nobody edits secrets when a different teammate runs the bridge, and several teammates can run it at once.

- **Wiring:** with `TEAM_AI_URL` and `TEAM_AI_KEY` set, the container gets `AI_FALLBACK=ollama` and `OLLAMA_MODEL=qwen3.8:27b` (or `TEAM_AI_MODEL`). The chat and Find a place try `AI_PROVIDER` first (Gloo, skipped while it has no key), then the bridge. Calendar summaries use the first configured provider.
- **Timeouts:** one model call waits up to 90 seconds (`OLLAMA_TIMEOUT`, capped at 95 because Cloudflare ends a proxied request after about 100).
- **When the bridge is down:** the chat answers with the demo replies (`"offline": true` in the response), Find a place returns its "try again, or browse Ministries" message, and the calendar shows "AI Endpoint: Offline" (its summarize routes return 503). Nothing errors.
- **Status:** `GET /api/ai/status` reports `provider`, `connected` (reachable right now, cached for 15 seconds), `default_model`, `team_bridge`, and the chat's provider chain.

Turning it on (once):

1. A Cloudflare Tunnel named `belong-team-ai` with the public hostname `team-ai.jaronwilson.dev` pointing at `http://127.0.0.1:8787`.
2. In `api/`: `npx wrangler secret put TEAM_AI_URL` (value `https://team-ai.jaronwilson.dev`) and `cat ~/.secrets/gloo-team-ai-key.txt | npx wrangler secret put TEAM_AI_KEY`, then deploy `api/`.
3. Send teammates the team key and the tunnel token privately (password manager or in person).

**Switching to Gloo on Oct 7:** `npx wrangler secret put GLOO_API_KEY` in `api/`. Gloo then comes first for the chat, Find a place and calendar summaries, and the bridge stays as a backup whenever someone runs it. To retire the bridge, `npx wrangler secret delete TEAM_AI_KEY` and `TEAM_AI_URL`, then delete the tunnel.

**Policy:** the bridge exposes the club's HPC model behind a key, for the hackathon only. Confirm with Ben before relying on it.

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

1. **Sign in to the existing church** (`#/staff`): use your staff email and password. For the initial Owner account, use the configured shared Owner login with email blank, then create your Owner account under Team. Owners can add Site admins; no church signup is offered.
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

## License

Copyright (c) 2026 Isaac Smith, Ben Peterson, Will Cook, Jaron Wilson, Isaiah Mellace and Erik Ellis. **All rights reserved**; see [LICENSE](LICENSE). Licenses to use Tekton are available on request: ilsmith2@liberty.edu.

- The build documentation in [build-docs/](build-docs/) is licensed under [CC BY 4.0](build-docs/LICENSE).
- Third-party libraries, services and data keep their own licenses and terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
