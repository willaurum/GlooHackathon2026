# Tekton

**An agentic website builder for churches.** Give Tekton a church's existing website, its bulletins and flyers, a saved JSON export, or just answers to a few questions. It reads what it can, asks only about what it could not find or what disagrees, and builds a complete church site with guest, serving, giving, sermon and calendar tools plus an AI assistant, **Ask Tekton**.

Built by Liberty University's team for the Gloo Hackathon 2026.

- **Try it:** https://gloo-hackathon2026.jaronwilson2025.workers.dev (the builder is at [`#/new`](https://gloo-hackathon2026.jaronwilson2025.workers.dev/#/new))
- **Demo church:** Grace Community Church (`grace-community`), fictional, with synthetic content. It is what the site shows until someone picks another church.
- **Test websites to import:** https://gloo-hackathon-synthetic-church-sites.ebellis1.chatgpt.site (Cedar Hollow Millbrook is the demo), with the source in [`test/synthetic-sites/`](test/synthetic-sites/)

## Contents

- [Features](#features)
- [The agentic builder](#the-agentic-builder)
- [How it is built](#how-it-is-built)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Testing](#testing)
- [Deployment and previews](#deployment-and-previews)
- [Configuration and secrets](#configuration-and-secrets)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Features

Every church site has these areas:

| Area | What it does |
|---|---|
| **Home** | Service times, what's on this week, and links into every area |
| **Guests** | *Plan your visit* (service times, what to expect, a parking and entrances map, and a "let us know you're coming" form) and the *Welcome team* screen greeters use on Sunday |
| **Serve** | Browse ministry teams, see where volunteers are needed, match a person to a team, and apply to join one. Staff review every application |
| **Sermon Notes** | Sermons transcribed on Cloudflare and highlighted (Bible quotes, current events, stories). Bible references open the passage from YouVersion, and questions are answered only from the transcript, with timestamps |
| **Calendar** | Events and services, with month, category and search filters |
| **Give** | Private giving to funds and mission trips through Stripe Checkout, trip applications, and staff-managed Stripe setup |
| **Prayer map** | The countries a church prays for, with dated updates from the field and real news |
| **About** | News (updates and articles), beliefs, staff directory and contact |
| **Ask Tekton** | A chat assistant on every page that answers from the church's own content, links to the right page, and passes care requests to staff. It never sends anything to anyone by itself |
| **Edit your site** | Staff see their live site at `#/c/<slug>/edit` and change wording, colors, fonts, sections and pages through a draft (directly or by asking Tekton), then review, publish, or restore the previous version |
| **Church staff** | Sign-in, volunteer applications, care requests, Church setup, staff accounts and giving |

Visitors need no account. Staff sign in at `#/setup` with their own email and password. Details: [docs/features.md](docs/features.md).

## The agentic builder

Open [`#/new`](https://gloo-hackathon2026.jaronwilson2025.workers.dev/#/new) and follow **Import → Clarify → Review → Create your church**:

1. **Import.** Paste a website URL, upload up to 5 files (PDF, DOCX, text, HTML or images), load a saved `church.json`/`site.json`, or answer questions instead. Website imports follow robots.txt and read up to 40 pages, most useful first, and the progress shows live.
2. **Clarify.** Every fact must quote the page it came from, or it is dropped. When the sources disagree (two service times, two phone numbers) or a basic is missing, Tekton asks and shows each answer's source and quote. It never picks for you.
3. **Review and preview.** Check the confirmed content, then open **Preview your site** (`#/new/preview`) to see the real template filled in. Change it in plain words with Ask Tekton ("make the main color navy", "hide the calendar"); Undo restores it. Download the result as `church.json` and `site.json`.
4. **Create your church.** This creates the church and its Owner account and fills it with the confirmed content.

Tekton does not write theology or wording the church did not give, and a statement of faith is kept word for word for the pastor to confirm. Read more:

- [docs/agentic-builder.md](docs/agentic-builder.md): how the builder decides what to trust, its limits, and what went wrong along the way
- [docs/builder-api.md](docs/builder-api.md): the church content JSON and every builder route
- [build-docs/evaluation.md](build-docs/evaluation.md): test cases, pass criteria, results on production, and token costs
- [build-docs/session-logs/](build-docs/session-logs/): a full recorded run (each step, AI call, question, answer and edit)

## How it is built

```
Browser (React + Vite, hash routes)
   │
   ├── gloo-hackathon2026 ............ static frontend Worker (repo root wrangler.jsonc)
   │
   ├── /api → api/ ................... church API Worker
   │          ├── Cloudflare Container: FastAPI backend (backend/app/)
   │          ├── one SQLite Durable Object per church
   │          ├── R2 (sermon media), Workers AI (Whisper transcription)
   │          └── Gloo AI (chat, builder, highlights, embeddings)
   │
   └── /giving-api → api-giving/ ..... giving Worker: church registry, staff accounts,
                                        Stripe, one SQLite Durable Object per church
```

| Worker | URL | Purpose |
|---|---|---|
| `gloo-hackathon2026` | https://gloo-hackathon2026.jaronwilson2025.workers.dev | The live site, built from `main` |
| `preview-jaron-frontend-gloo-hackathon2026` | https://preview-jaron-frontend-gloo-hackathon2026.jaronwilson2025.workers.dev | Integration preview of `jaron-frontend`, against the live APIs |
| `gloo-hackathon2026-api-pastor-notes` | https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev | Church API (`api/`): every church feature except giving |
| `gloo-hackathon2026-api-donate-giving` | https://gloo-hackathon2026-api-donate-giving.jaronwilson2025.workers.dev | Giving API (`api-giving/`): registry, staff sign-in, giving |

**Churches never see each other.** Each church has its own database, there is no church list or search, and a visitor reaches a church only by its own link (`#/c/<slug>/`). See [docs/architecture.md](docs/architecture.md).

**Stack:** React 18, Vite, Leaflet · Python 3.12, FastAPI, Pydantic · Cloudflare Workers, Containers, Durable Objects (SQLite), R2, Workers AI · Gloo AI (Claude Haiku 4.5 for the builder, Qwen for the chat, BGE embeddings) · Stripe Checkout · YouVersion Platform API.

## Repository structure

```
.
├── frontend/              React app
│   └── src/
│       ├── App.jsx, Layout.jsx           routes, navigation, page shell
│       ├── Builder.jsx, TektonAgent.jsx  the #/new builder and Ask Tekton in the preview
│       ├── SitePages.jsx, Sourced.jsx    pages imported from a church's website (#/p/<slug>), source hovers
│       ├── SiteEditor.jsx, siteDraft.js  Edit your site (#/c/<slug>/edit)
│       ├── Home, VisitPage, WelcomeTeam, Serve, PastorNotes, Calendar, Give*, PrayerMap, News, About ...
│       ├── ChatWidget.jsx, chat*.js      Ask Tekton chat
│       ├── church.js, churchSite.js, ChurchContext.js   which church is shown, its content and layout
│       ├── api.js, builderApi.js, giving.js             API clients
│       └── *.test.js                     frontend tests (node --test)
├── backend/               FastAPI app that runs in the container
│   ├── app/
│   │   ├── main.py                       routes for most features
│   │   ├── builder*.py                   the agentic builder (crawl, extract, agents, theme, site, customize, export, scoring)
│   │   ├── chat.py                       Ask Tekton: tools, guardrails, page links
│   │   ├── church_content.py             the church content schema and import
│   │   ├── site_editor.py                Edit your site: draft, ask, publish, restore
│   │   ├── db.py, church_scope.py        SQL and the church each request is for
│   │   ├── pastor_notes.py               Sermon Notes
│   │   └── *.json                        demo church seed content
│   └── tests/             Python tests, with fixtures/builder/ (made-up church sites and answer keys)
├── api/                   church API Worker (container, per-church database, access rules, outbound bridges)
├── api-giving/            giving Worker (registry, staff accounts, Stripe)
├── schemas/               JSON Schemas for church.json and site.json
├── test/synthetic-sites/  the four made-up church websites used for testing and the demo
├── preview-proxy/, preview-api-stub/   branch preview Worker and an in-memory API stub
├── scripts/               YouTube helper, team AI bridge, Ollama bridge proxy
├── docs/                  technical documentation (see below)
├── build-docs/            the agent build doc: evaluation, references, session logs (CC BY 4.0)
├── DOCUMENTATION/         early planning notes and presentation notes
├── db/                    legacy Postgres init from the base branch (unused)
├── .github/workflows/     previews.yml (branch and PR previews), deploy-backend.yml (APIs)
├── docker-compose*.yml    local stack, plus Ollama and GPU overlays
└── wrangler.jsonc         the frontend Worker
```

## Getting started

**Prerequisites:** Node 22+, Python 3.12, and either Docker or a Python virtual environment. A Gloo API key is optional; without one the chat uses demo replies.

**With Docker:**

```bash
git clone https://github.com/willaurum/GlooHackathon2026.git && cd GlooHackathon2026
docker compose up -d
```

The site is at http://localhost:3000 and the API at http://localhost:8000. Put `GLOO_API_KEY=...` in `.env` for real AI, or add `-f docker-compose.ollama.yml` to run a local model with no key.

**Without Docker:**

```bash
python -m venv .venv && .venv/Scripts/pip install -r backend/requirements.txt   # bin/ on macOS/Linux
cd backend && CHURCH_DB_URL=sqlite SQLITE_DB_DIR=./data ../.venv/Scripts/python -m uvicorn app.main:app --port 8000
cd frontend && npm ci && npm run dev       # http://localhost:5173, proxies /api to the backend
```

To try the builder locally, serve the test sites with `python -m http.server 8091 --directory test/synthetic-sites` and import `http://localhost:8091/cedar-hollow-millbrook/`. Ollama, the HPC tunnel and the team AI bridge are in [docs/local-development.md](docs/local-development.md).

## Testing

From the repo root:

```bash
python -m unittest $(ls backend/tests/test_*.py | sed 's#/#.#g; s#\.py$##')   # backend, including 277 offline builder tests (no network, fake AI)
cd frontend && npm ci && npm test && npm run build                          # frontend
cd api && npm ci && npx tsc --noEmit && node --test test/*.test.mjs         # church API Worker
cd api-giving && npm ci && node --test test/anonymize.test.mjs test/signup.test.mjs test/staff-races.test.mjs   # giving Worker
```

The builder is also tested by hand against the synthetic sites. The cases and results are in [build-docs/evaluation.md](build-docs/evaluation.md) and [docs/qa/](docs/qa/). Feature-specific checks, such as the giving API against a fake Stripe and the two-church isolation end-to-end test, are in [docs/architecture.md](docs/architecture.md#testing-churches-locally) and [docs/features.md](docs/features.md).

## Deployment and previews

Deploys are automatic:

- **Frontend previews:** `.github/workflows/previews.yml` builds every team branch at `https://preview-<branch>-gloo-hackathon2026.jaronwilson2025.workers.dev` and every pull request at `https://preview-pr-<number>-gloo-hackathon2026.jaronwilson2025.workers.dev` (posted on the PR). Previews use the live APIs. See [PREVIEWS.md](PREVIEWS.md).
- **Live site and APIs:** a push to `main` deploys the frontend. `.github/workflows/deploy-backend.yml` deploys `api/` and `api-giving/` when they or `backend/` change (also runnable by hand: Actions → Deploy backend). It uses the `CLOUDFLARE_API_TOKEN` repository secret.

By hand:

```bash
cd frontend && npm ci
VITE_API_BASE=https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev npm run build
cd .. && npx wrangler deploy                      # frontend (repo root)
cd api && npm ci && npx wrangler deploy           # church API, rebuilds the container
cd ../api-giving && npm ci && npx wrangler deploy # giving API
```

Deploy `api-giving/` first or together with `api/`. Custom domains and per-church subdomains are described in [docs/architecture.md](docs/architecture.md#subdomains-once-there-is-a-domain).

## Configuration and secrets

Secrets are set with `npx wrangler secret put <NAME>` in the Worker's directory and are **never committed**. The main ones:

| Secret | Worker | Purpose |
|---|---|---|
| `GLOO_API_KEY` | `api/` | Gloo AI for the chat, builder, summaries, highlights and embeddings |
| `NOTES_API_KEY`, `NOTES_ADMIN_KEY` | `api/` | Sermon Notes routes and the church config |
| `YOUVERSION_APP_KEY` | `api/` | Bible passages |
| `STRIPE_KEY_ENCRYPTION_KEY` | `api-giving/` | Encrypts each church's Stripe key |
| `PLATFORM_ADMIN_KEY` | `api-giving/` | Optional: the team-only list of every church (`#/platform`) |

The full list, the optional model variables, and who keeps copies of each key are in [docs/architecture.md](docs/architecture.md#keys-and-access).

## Documentation

| Document | What it covers |
|---|---|
| [docs/agentic-builder.md](docs/agentic-builder.md) | How the builder works: the five steps, trust rules, specialists, limitations |
| [docs/builder-api.md](docs/builder-api.md) | The church content JSON, the Edit your site API, and every builder route |
| [docs/architecture.md](docs/architecture.md) | Churches and isolation, staff accounts and permissions, who may call what, data storage, keys, subdomains |
| [docs/features.md](docs/features.md) | Guests, Serve, Ask Tekton and which AI does what, Sermon Notes, Give, Calendar, Prayer map, News, with their routes |
| [docs/local-development.md](docs/local-development.md) | Running locally, Ollama, the HPC tunnel, the team AI bridge |
| [docs/Agent-Build-Doc.md](docs/Agent-Build-Doc.md) | Draft outline of the agent build doc |
| [docs/qa/](docs/qa/) | Builder QA cases and a website review |
| [build-docs/](build-docs/) | The published build doc: [evaluation](build-docs/evaluation.md), [references](build-docs/references.md), [session logs](build-docs/session-logs/) |
| [PREVIEWS.md](PREVIEWS.md) | How branch and PR previews work |
| [test/synthetic-sites/README.md](test/synthetic-sites/README.md) | The made-up church websites |
| [scripts/team-ai-bridge/README.md](scripts/team-ai-bridge/README.md) | The team AI bridge |
| [DOCUMENTATION/](DOCUMENTATION/) | Early planning and presentation notes |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party licenses |

## Contributing

- Branch from `jaron-frontend`, the integration branch, and open a pull request into it. Check the PR preview before it is merged.
- Fetch and merge the latest `jaron-frontend` into your branch before opening a PR, so conflicts are fixed on your side. `App.jsx`, `Layout.jsx` and `styles.css` change often.
- Never push to `main`. `jaron-frontend` is released to `main` once it is production ready.
- Use only made-up churches in fixtures and demos. Real church sites may be read in tests but are never created as churches.
- Never commit secrets, invite codes or real people's information.

**Team:** Isaac Smith, Ben Peterson, Will Cook, Jaron Wilson, Isaiah Mellace and Erik Ellis.

## License

Copyright (c) 2026 Isaac Smith, Ben Peterson, Will Cook, Jaron Wilson, Isaiah Mellace and Erik Ellis. **All rights reserved**; see [LICENSE](LICENSE). Licenses to use Tekton are available on request: ilsmith2@liberty.edu.

- The build documentation in [build-docs/](build-docs/) is licensed under [CC BY 4.0](build-docs/LICENSE).
- Third-party libraries, services and data keep their own licenses and terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
