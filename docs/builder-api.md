# Church content, the site editor and the builder API

The JSON document a church is made of, the staff site editor that changes it after launch, and the routes behind the agentic builder (`#/new`). For how the builder decides what to trust, see [agentic-builder.md](agentic-builder.md); for how it was tested, [../build-docs/evaluation.md](../build-docs/evaluation.md). [Back to the README](../README.md)

## Church content import (the target for a site importer)

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

## Edit your site

Staff change their live site through a draft (`backend/app/site_editor.py`). Every change is one checked operation; nothing is live until they publish, and the version before the last publish can be restored.

- `GET /api/church/editor`: the state, `{version, ops, changes, published, published_at, previous}`. `published` is the live content (the `GET /api/church/content` shape); `changes` has one entry per operation with a plain label and the value before and after.
- `PUT /api/church/editor/draft` with `{version, ops}` (up to 80 operations, 256 KB): replaces the draft. 409 when `version` is not the stored one; 422 `{detail, op}` names the first operation that is not allowed.
- `DELETE /api/church/editor/draft`: discards the draft.
- `POST /api/church/editor/ask` with `{request, viewing, version}`: Tekton suggests operations, added to the draft as `pending` (plain rules first, else one AI call whose operations are checked the same way; wording it places must come from the request). 10 per person in 10 minutes and 60 per church in an hour (429).
- `POST /api/church/editor/publish` with `{version}`: applies the accepted operations to the live content and writes only the sections they change (`info`, `site`, `pages`, `staff`, `faqs`). 409 while a suggestion is pending; the labels of what changed are in `published_changes`.
- `POST /api/church/editor/restore`: puts the previous version back; restoring again undoes that.

The operations: `set_text` (the Home headline, about and what to expect texts, the template wording in `backend/app/site_copy.json` stored as `site.copy`, imported page titles and sections, staff names, roles and bios, and FAQs; plain text only), `set_style` (colors and fonts in `site.theme`, kept readable by the builder's rules, and heading sizes in `site.style`: `heading_scale` 0.8 to 1.3, `hero_scale` 0.7 to 1.3), `move_section`, `hide_section` and `show_section` (Home and Plan your visit, `site.layout`), and `hide_page` and `show_page`. Facts with structure or side effects (name, address, service times, contacts, ministries, events and the like) stay in Church setup. The draft, the previous version and the publish time are in the church's `config` table (`site_editor:draft`, `site_editor:previous`, `site_editor:published_at`).

## Agentic builder

Anyone can open `#/new`, a standalone **Create your church site** page, to follow **Import → Clarify → Review → Create your church**. Import an existing website, resolve conflicts using the page and exact quote behind each candidate, fill missing details, and review or edit the confirmed content. **Preview your site** opens the normal site template at `#/new/preview`, filled with the draft's content, without an account. Navigation stays in preview, a banner links back to the builder, and live actions are disabled. **Create your church** creates the church and its Owner account, applies the draft and opens the new site. If registration is ever switched off, the step says so and offers the preview instead. The browser tab remembers the draft and any previously created church across reloads. If loading fails after an earlier signup, **Try again** applies to the same church. Import notes show when pages or sources were skipped. The in-church `#/build` page and its Church setup entry have been removed.

Import can also start with **Upload church materials** (1–5 PDF, text, HTML, DOCX or PNG/JPEG/WebP files, each up to 5 MB and at most 10 MB total), or **Answer questions instead**. File evidence shows the filename and exact quote. Scanned PDFs and images use the vision reader when configured; otherwise import notes explain why they were skipped. All three choices share the same claims, questions, answers, review and preview flow.

The backend is `backend/app/builder.py`. Public routes are `POST /api/builder/drafts` (a website import: answers 202 and runs in the background; poll the draft until its status is no longer `importing`), `/blank`, `/upload` (multipart field `files`) or `/json` (a saved `church.json`/`site.json` pair), `GET /api/builder/drafts/<id>` or `/site`, and `POST /api/builder/drafts/<id>/answers`, `/items` (include, leave out or edit an imported event, person, ministry, group, location or sermon), `/parts` (keep or leave out imported pages, links, forms, players and images, and confirm permission for images) or `/preview`, and `GET /api/builder/drafts/<id>/pages/<page>` (one imported page). Also public: `GET /api/builder/drafts/<id>/church.json`, `/site.json` and `/files` (download the draft as the two JSON files, schemas in `schemas/`), `POST /api/builder/drafts/<id>/customize` and `/customize/undo` (Ask Tekton edits from the preview), `POST /api/builder/drafts/<id>/chat` (the preview's chat, answered from the draft), `POST /api/builder/drafts/<id>/calendars/<calendar>/import` or `/decline`, and `POST /api/builder/drafts/<id>/removed/<removed>/add` (put back something the fact check removed). Website imports follow robots.txt (including `Crawl-delay`) for every host, read the sitemap and up to 40 pages, most useful first, plus calendar and sermon feeds and the site's stylesheets, and keep the site's menu, pages, calls to action, forms, players, colors and fonts so it can be recreated (applied pages are public at `GET /api/church/pages/<slug>` and shown at `#/p/<slug>`); see `docs/agentic-builder.md`. The content preview requires all questions to be answered. The read-only site snapshot also accepts unfinished drafts and returns the same info, church, ministries and calendar shapes as the live public endpoints, without writing a church database. `POST /api/builder/drafts/<id>/apply` requires the target church's staff session, refuses the demo church, and consumes the draft after a successful write. All other builder paths stay staff only; the old sessions routes are gone.

Drafts are church-independent: they live in the reserved platform database space `builder`, in its `config` table as `draft:<id>`. The registry reserves the `builder` slug. Only the unguessable draft id grants public access; drafts expire 24 hours after creation, and page texts stay on the server. Public imports refuse private-network addresses and are limited to 5 starts per client IP per rolling hour, 60 overall per hour, and 3 concurrent imports in the single backend container. Limit failures return 429; the Worker forwards Cloudflare's client IP header.

On Cloudflare the container can only reach the hosts in `allowedHosts`, and a church's website can be anywhere, so the builder fetches pages and images through the Worker: the container gets `BUILDER_FETCH_URL=http://builder-fetch`, and the `builder-fetch` outbound handler (`api/builderfetch.ts`) does the request. It allows http(s) on the default ports only, refuses credentials, local names (`localhost`, `.local`, `.internal`, single-label names), and any private, loopback, link-local, metadata or reserved IP, whether it is in the URL or what the name resolves to (checked over DNS-over-HTTPS), and checks every redirect the same way. Pages, sitemaps and feeds are cut at 1 MB, stylesheets at 500 KB, images over 4 MB are refused, and each fetch has 10 seconds. The builder's AI runs on Gloo like everything else, with a fast model that also reads images: `GLOO_BUILDER_MODEL`, then `GLOO_MATCH_MODEL`, then `gloo-anthropic-claude-haiku-4.5`. When the AI is offline or slow, the import still finishes with the rule-based details and says so in its notes.

### What Tekton shows while it works, and what it will not do

- **Live progress.** While a website import runs, the draft's `progress.steps` fills in about once a second ("Read “Visit” (visit page)", "Staff reader on “Our Team”: 4 found", "Checking facts… 2 unsupported claims removed"), and `#/new` shows them as they come. A finished draft keeps the full list and a summary in `run`: pages read, seconds, AI calls, tokens and an estimated cost from Gloo's published per-model prices (`backend/app/builder_run.py`).
- **Fact check.** Every AI answer must quote its page. Answers whose quote is not on the page, or that are not a detail Tekton asked for, are dropped and counted, and the count is shown.
- **Sources.** `GET /api/builder/drafts/<id>/site` also returns `provenance`. On `#/new/preview`, imported facts (service times, address, About, ministries, staff, campuses) show where they came from on hover, focus or tap; **Sources shown** in the banner turns this off. Source links use [text fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Text_fragments) (`#:~:text=`) so the church's page opens scrolled to the quote, with a few words before and after it to pick the right spot (`frontend/src/sourceLink.js`). Chrome, Edge, Safari and Firefox 131+ support them; older browsers just open the page.
- **Changes in plain words.** `POST /api/builder/drafts/<id>/edits` with `{"request": "Put service times above ministries"}` turns a request into checked operations: move or hide a section of Home or Plan your visit, change a detail, or leave out a list entry. Common requests are matched by rules; anything else goes to the AI as a strict tool call, and every operation is validated before it is applied. `/edits/undo` undoes the last 5. The order is saved as `site.layout`, which Home and Plan your visit follow (`backend/app/builder_edit.py`).
- **Ask Tekton in the preview.** The banner on `#/new/preview` sends requests to `POST /api/builder/drafts/<id>/customize`. Besides the edits above it changes theme colors and fonts, FAQs, staff members, page names and section text, and hides or shows whole pages (`site.layout.hidden_pages`). Rules handle common requests; the rest is one strict AI tool call, and wording the AI plans must come from the person's own request (`backend/app/builder_customize.py`, `frontend/src/TektonAgent.jsx`).
- **Sites that build themselves in the browser.** When the pages are an app shell (little text, many scripts, or a Wix/Squarespace generator), Tekton says so and switches to questions instead of importing empty pages.
- **Beliefs are never summarized.** A statement of faith is kept word for word and left off the new site until the pastor confirms it (`POST /api/builder/drafts/<id>/beliefs` with `{"confirmed": true}`). A placeholder ("under construction") is not imported; it becomes something for the pastor to add.
