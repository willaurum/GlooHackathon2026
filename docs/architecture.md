# Architecture, churches and access

How one deployment serves many churches: which church a request is for, where each church's data lives, who may call what, staff accounts, and the secrets each Worker needs. [Back to the README](../README.md)

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

News (`#/about/news`, `/api/blog`) is public to read. Writing, summarizing and deleting posts
is staff only, and visitors never see the editing controls. There is no separate draft or
approval workflow.

## Churches

Grace Community is the fictional demo of the base template. Existing church sites keep their own data and staff accounts. Anyone can create a new church from the agentic builder (`#/new`), and it starts with its own Owner account (see [the builder API](builder-api.md)).

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
| Welcome team queue, check-in, claim and met; volunteer applications (read, review); care requests (read, review, delete); adding events and AI summaries | that church staff | that church staff |
| Church setup: `GET` and `PUT /api/church/content` | that church staff | that church staff |
| Staff accounts: `GET /api/churches/<slug>/admin/users` | that church staff | that church staff |
| Add or remove staff: `POST /api/churches/<slug>/admin/users`, `DELETE /api/churches/<slug>/admin/users/<id>` | Owner only | Owner only |
| Sermon Notes and the chat log | `NOTES_API_KEY` or that church staff | `NOTES_API_KEY` or that church staff |
| The shared AI model setting (`POST /api/ai/model`) | `NOTES_API_KEY` | `NOTES_API_KEY` |

The demo church staff password is the `ADMIN_KEY` var in `api-giving/wrangler.jsonc`.

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
| `YT_HELPER_URL` / `YT_HELPER_KEY` | `api/` | Optional. The [YouTube helper](features.md#youtube-links-the-youtube-helper) that downloads YouTube audio from Jaron's dev server. Set `YT_HELPER_URL` as a GitHub Actions **variable** and `YT_HELPER_KEY` as a GitHub **secret**; Deploy backend copies both to the Worker. The key stays in the Worker. |
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
