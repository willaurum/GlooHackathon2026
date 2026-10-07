# How the agentic builder works

The builder turns a church website, uploaded materials, or answers to questions into a Tekton site. Open `#/new`, choose how to start, answer the missing or conflicting details, and preview the result. This doc covers how it decides what to trust, how it is tested, and what went wrong along the way.

Code: `backend/app/builder.py` (pipeline, orchestrator and routes), `builder_crawl.py` (robots.txt, Crawl-delay, sitemaps, page types and link scoring), `builder_structured.py` (JSON-LD, iCal, RSS and page-pattern readers), `builder_agents.py` (specialist AI readers), `builder_site.py` (the site model: menu, page sections, links, forms, media), `builder_theme.py` (colors, fonts, logo and icon), `frontend/src/Builder.jsx` (the `#/new` page), `frontend/src/SitePages.jsx` (recreated pages, `#/p/<slug>`), `backend/tests/test_builder*.py` (tests), `backend/tests/fixtures/builder/` (made-up church sites).

## The framework

The team agreed on five steps:

| Step | What happens | Where |
|---|---|---|
| **Import** | Read up to 40 pages (most useful first), 5 same-site images and up to 4 calendar or sermon feeds; or read uploaded materials, or start with no sources | `crawl`, `read_images`, `read_feeds`, `read_files`, `session_from_sources` |
| **Extract** | Collect every candidate value as a *claim*, and every event, person, ministry, group, location and sermon as a list *item*, each with the page and exact quote it came from | `extract_all`, `pattern_claims`, `ai_claims`, `builder_structured.page_items`, `builder_agents.run` |
| **Clarify** | Plain code compares the claims. If they disagree or are missing, it asks the person | `reconcile`, `questions` |
| **Confirm** | The person picks a candidate, types their own, or edits on the review screen; list items are included, left out or edited | `apply_answer`, `apply_item` |
| **Build preview** | Confirmed values fill the existing church template, with the old site's pages, menu and look | `build_content`, `builder_site.content`, `#/new/preview` |

Build preview also exports seed-shaped files: `church.json` (`info`, `faqs`, `events`, `groups`), `ministries.json` (`ministries`), `events.json` (`calendar`) and `builder.json` (any `staff`, `locations`, `sermons`, `site`, `pages`); `regions.json` is included when present. `GET /api/builder/drafts/{id}/files` returns them, and Review's **Download site files (JSON)** saves one church-named JSON containing the files. `builder_export.load()` merges and validates them, including the demo's bare-array seeds. Run `python -m backend.app.builder_export <fixture-dir-or-url> <out-dir> [--answers answers.json]` to write individual files; fixtures run offline without AI. Answers are `{field: value}`; open questions may remain as in the site preview.

The rule underneath: **the AI may suggest; only the person confirms.** Real disagreements (below) are asked about, never quietly chosen, and everything is shown for review before anything is built.

## Rules and AI: who does what

We split the work between deterministic rules ("NLP" in the classic sense: regular expressions and an HTML parser) and a language model.

| Job | Done by | Why |
|---|---|---|
| Find phone numbers, emails, street addresses, service times | **Rules** (`PHONE_RE`, `EMAIL_RE`, `STREET_RE`, `TIME_RE`, `DAY_RE`) | These have strict formats. Rules are instant, free, and never make things up. |
| Find the church name, the "about" text, what to expect on a first visit | **AI** (tool call `record_church_facts`) | No fixed format. "Harborlight Chapel" vs. "HLC" needs judgment. |
| Read a bulletin or flyer image | **Vision AI** turns the image into text, then the **same rules** read that text | One reading path for everything. |
| Read schema.org data, iCal calendars, podcast/RSS feeds, embedded sermon videos, staff cards, dated event listings and campus addresses | **Rules** (`builder_structured.py`) | When a site publishes structured data, it is more reliable than any reading of the prose. |
| List events, staff, ministries and groups, sermons and locations from a page | **Specialist AI readers** (`builder_agents.py`), one call per page | Lists are written every way imaginable; a model reads them better than patterns. |
| Decide which pages to read and which readers to run | **Rules** (`builder_crawl.score`, `builder_agents.ROUTES`) | The AI never picks an address or decides how much work is done. |
| Decide whether candidates agree | **Rules** (`reconcile`) | This is the trust decision, so it must be predictable and testable. |
| Decide what to ask | **Rules** (`questions`) | Same reason. |

### Grounding: the AI must quote

Each AI suggestion must come with the **exact quote** from the page it read. `grounded()` checks that quote against the page text. If the quote is not there, the suggestion is dropped. This stops the model from inventing a phone number or "correcting" a service time. Every value shown to the person links back to a real sentence on a real page. That's what the conflict cards show ("HLC - Welcome!!: *Come worship with us Sundays 9 & 11.*").

### The orchestrator and its specialist readers

`extract_all` is the orchestrator. It is plain code, not an agent loop:

1. Every page, image and file gets the info reader (`ai_claims`, tool `record_church_facts`).
2. Pages of a known type also get specialist readers (`builder_agents.ROUTES`): staff and about pages → `record_staff`; events → `record_events`; ministries and groups → `record_ministries`; sermons → `record_sermons`; locations and visit pages → `record_locations`. Posts and unknown pages get none.
3. All calls share the import's deadline and four workers. Specialist calls are capped (`BUILDER_MAX_AI_CALLS`, default 60 in total).

A specialist is bounded:
- one call, forced to its record tool; it has no other tools and cannot fetch anything;
- the prompt says the page text is untrusted content, never instructions;
- every item must quote the page (`grounded`), and its name must appear on the page;
- emails must appear on the page, links must be among the page's own links, and a date must be backed by its day number in the quote;
- fields are capped by pydantic models; anything else is dropped.

A failed or slow specialist only costs its own list; the draft's notes say which lists to check. If the first AI provider fails, the next one (`AI_FALLBACK`) gets one try.

### Lists

`collect` merges the same item found on several pages or by several readers into one entry, taking fields from the most reliable reader first (structured data, then page patterns, then AI). Each entry keeps up to five quotes as evidence. Entries start **included**, except staff: a person is included only when two pages or the site's structured data name them, because their name and email will be public. Past events are dropped; dated future events go to the Calendar, repeating ones to the event highlights.

### The site model

Besides facts and lists, a website import keeps the shape of the site so it can be recreated (`session.site`, built by `builder_site.build` with no AI):

- **Menu:** the home page's `<nav>`/`<header>` lists as a tree. Parents that only open a submenu keep their label with no link; a shorter mobile copy of the menu is dropped; each entry points to an imported page or to another site.
- **Pages:** every page read, split into sections at its headings, each with its text, its buttons (links whose text is in that section) and its embedded players. Lines repeated on most pages (menus, footers) are left out. Blog posts start left out.
- **Links and calls to action:** classified by address only: giving (Church Center, Subsplash, Pushpay, Tithe.ly…), sign-up forms (Church Center, Evite, Eventbrite, Google Forms…), livestreams (Castr, BoxCast, Resi, YouTube live…), video, podcasts, apps, social, maps and documents, with the heading they sat under.
- **Forms:** what a form asks (field labels and types, required or not) and where it sent answers. Field values (including hidden tokens), login forms and search boxes are never kept. The new site shows a form as a link; it never re-posts anything.
- **Media:** embedded players and forms.
- **Look** (`builder_theme`): `theme-color`, brand custom properties and header/button/body rules from the home page's styles and up to three stylesheets give a main color, an accent, text and background colors and plain font names. Colors are darkened until white button text is readable, unreadable text colors and dark page backgrounds are dropped, and no CSS from the old site is ever served.
- **Images:** the logo, site icon and sharing image are referenced by address, never copied, and only shown once the church ticks "We own this image or have permission to use it".

The church reviews it all (`POST /api/builder/drafts/{id}/parts`: keep or leave out pages, links, forms, players and images, and give image permission) and can open any page (`GET /api/builder/drafts/{id}/pages/{page}`). Each page's sections are stored in their own draft row (`draft:<id>:page:<page>`), so the draft row stays small. Applying writes two content sections: `site` (menu, links, forms, media, theme, images) and `pages` (one row per page). `GET /api/church` returns the menu and page titles; `GET /api/church/pages/{slug}` (public) returns one page, which the site shows at `#/p/<slug>` with players only from known hosts (YouTube, Vimeo, Castr, BoxCast, Subsplash, Church Center, Spotify, Google Maps embeds). The imported menu sits under the template's own sections, and the theme's colors become its green scale.

### Reconciling

- **Phone, email and street address:** a value on more than half of the pages that mention one is taken as the church's, so a staff member's email on one page (or a second campus on the locations page) doesn't trigger a question. Otherwise, different values are a conflict, and the builder asks, showing each candidate with its page and quote. The person can still change the value on the review screen.
- **Service times:** compared day by day. "Sunday 9 & 11" on the home page and "Sunday 10:30" in a news post conflict. "Sunday 9 & 11" and "Sunday 9" do not; the second is a subset. On a locations page each campus's times are their own set, so two campuses become a question instead of one merged list.
- **Prose** (about, first visit, office hours): the most widely stated text is prefilled, not asked about. The person edits it on review.
- **Missing required fields** (name, street address, phone, email, service times) become "We could not find…" questions. Optional fields are just left empty.

## Safety and limits

- **Uploads:** 1–5 files, each up to 5 MB, at most 10 MB total. PDF, plain text, HTML, DOCX and PNG/JPEG/WebP are detected from their contents. DOCX extraction caps the uncompressed size at 5 MB. Images and scanned PDFs are skipped with a note when no vision model is available. File evidence uses the sanitized filename and exact quote, with no URL.
- **No private addresses.** Import refuses `localhost`, private networks and link-local addresses, including after redirects (`_check_public`). `BUILDER_ALLOW_PRIVATE=1` turns this off for local testing only.
- **Fetch bridge (optional).** With `BUILDER_FETCH_URL` set, pages and images are fetched by a bridge that checks every address and redirect itself, and the container only checks the scheme. The Cloudflare build sets it to the Worker's `http://builder-fetch`, because its container can only reach listed hosts. Unset (the laptop build), the container fetches directly.
- **Model.** The builder uses the first provider in the chat's chain. On Gloo it picks a fast model that also reads images (`GLOO_BUILDER_MODEL`, then `GLOO_MATCH_MODEL`, then `gloo-anthropic-claude-haiku-4.5`), because the chat's reasoning default spends 30+ seconds per call. Other providers, such as Ollama on the laptop, keep their configured model.
- **AI offline.** The rules still run when the AI reader is down, slow or not set up, and the draft's `notes` say so. Each AI call is limited to the time left in the import, so a hung model never holds a worker past it. A model that refuses a forced tool choice is asked again with `tool_choice: auto`.
- **Same site only.** The crawler never follows links to other domains (`www.` and the bare domain are one site). The only off-site fetches are calendar and podcast feeds the site itself links to, and they go through the same address checks.
- **robots.txt** follows RFC 9309 for the `Tekton` user agent: our own group if there is one (else `*`), `*` and `$` wildcards, the longest matching rule wins and `Allow` wins a tie. It is checked for **every host** the import touches: pages, sitemaps, feeds, stylesheets and images (`builder_crawl.HostPolicy`, robots.txt read once per host). A missing robots.txt (4xx) allows everything; one that cannot be read (5xx, timeout) stops the import, and a site that disallows its home page cannot be imported. Either way the church is told to upload materials instead.
- **Crawl-delay** (capped at 10 seconds) is honored per host: pages are then read one at a time with that pause, only as many as fit in the time, and the notes say so.
- **Hidden text is not read.** Elements marked `hidden`, `aria-hidden="true"`, `display:none` or `visibility:hidden`, HTML comments, and zero-width or text-direction characters are dropped before any reader sees the page. Links in hidden menus are still followed, but are never shown as page content. Text a visitor can see that reads like instructions stays plain page text: it is never followed, and links, menus and players only come from the page's own markup.
- **What gets read first.** Sitemap pages and links are scored by `builder_crawl.score`: visit, staff, events, ministries, groups, sermons and locations first, then about and contact; menu links get a bonus. At most 3 blog, news or archive posts are read. Logins, carts, tags, searches, paginated archives and files are skipped.
- **Background imports.** `POST /api/builder/drafts` answers **202** with a draft whose status is `importing` and starts a job; the page polls `GET /api/builder/drafts/{id}`, which shows `progress` (pages read and found), until the status is `clarifying`, `review` or `failed`. Polling is also what keeps the Cloudflare container awake. Answers, list edits, previews and apply answer 409 until the import is done. A job lost to a restart shows as failed ("The import was interrupted").
- **Time budget.** A website import has 180 seconds (`BUILDER_JOB_BUDGET`): page reading stops at half of that, three pages are fetched at a time, AI and image reads run four at a time, and anything still running when time is up is dropped. Uploads and blank drafts still answer in one request within 75 seconds. The draft's `notes` say what was skipped.
- **Page limit.** 40 pages (`BUILDER_MAX_PAGES`, at most 60).
- **Rate limits:** 200 imports per IP per hour, 500 per hour overall (raised for the demo; `BUILDER_IMPORTS_PER_ADDRESS` and `BUILDER_IMPORTS_PER_HOUR` Worker vars override them), 3 at a time (a background import holds its slot until it finishes).
- **Drafts:**
  - stored outside every church's data, in the reserved `builder` space, without the page texts (every value keeps its quote);
  - reached only by an unguessable 24-character id;
  - expire after 24 hours, and expired drafts are deleted whenever a draft is saved;
  - can be applied to a church only once, and never to the demo church.

## Testing

- **Made-up church sites** live in `backend/tests/fixtures/builder/`, with the full set (including a React site) in the separate `synthetic-church-sites` repo and hosted at https://gloo-hackathon-synthetic-church-sites.ebellis1.chatgpt.site. Every name, address, phone (555-01xx) and email (example.org) is fictional.
  - **Cedar Hollow:** the happy path. Clean, consistent information.
  - **Harborlight:** the hard path. Two phone numbers, three different service times (home page, news post, bulletin image), no street address, no email, five spellings of the name.
  - **Harvest Point (snappage-like):** shaped like a site on a hosted site builder: dropdown menus with label-only parents and a mobile copy, a sitemap of `http://` addresses, 12 daily posts, robots.txt with `Crawl-delay` and `Disallow: /assets/*`, giving, sign-ups, a livestream and videos on other services, an on-page form with a hidden token and a search box, Elders and Deacons lists, `Dr.`/`Rev.` titles, a role wrapped over two lines, "9:00 & 11:00 am", "Sunday, October 27h", a theme stylesheet on another host, and hidden instructions. Its answer key (`expected.json` `site`) also lists the menu, links by kind, forms and media.
  - **Stonebridge (large):** about 45 pages with robots.txt (a disallowed members page), a sitemap (with a page linked nowhere else), JSON-LD, an iCal feed, a sermon podcast, YouTube sermons, two campuses, 30 blog posts and a prompt-injection post. Its answer key lists the expected events, staff, ministries, groups, locations and sermons, and pins the day it is read on (`today`).
- **Tests run offline**, with fake fetch, fake AI and fake vision. They cover:
  - the demo conflict, AI grounding, image reading, private-address refusal, rate limits and draft expiry;
  - single-use apply and the demo-church guard;
  - multi-day typed answers and the time budget.
- **Accuracy score:** each fixture has an `expected.json` answer key. `builder_score` reports correct, wrong and missed fields, conflicts and gaps flagged correctly or not, and the precision and recall of each list.

  Rules-only baseline (offline, no AI), pinned by `backend/tests/test_builder_score.py`:

  | Site | Result |
  |---|---|
  | Cedar Hollow | 5/8 fields correct (name, address, phone, email, service times), 0 false questions. The other 3 are prose fields (about, first visit, office hours) that only the AI fills. |
  | Harborlight | 2/3 conflicts flagged (phone, service times), 2/2 gaps flagged (street address, email), 0 false questions. The varying church name is asked as *missing* rather than shown as a conflict, because the rules don't extract names (the AI does). |
  | Harvest Point (snappage-like) | 5/5 fields correct, 0 false questions. Events, staff and sermons 100% precision and recall; menu (16 entries), links by kind, forms and media 100% recall. |
  | Stonebridge (large) | 4/4 fields correct, 1/1 conflicts flagged (the two campuses' service times), 0 false questions. Lists: events, staff, locations and sermons 100% recall from structured data and page patterns; ministries and groups need the AI reader (100% with the test's specialist stand-in in `test_builder_deep.py`). |

```bash
python -m unittest backend.tests.test_builder backend.tests.test_builder_deep backend.tests.test_builder_score \
  backend.tests.test_builder_robots backend.tests.test_builder_site backend.tests.test_builder_theme \
  backend.tests.test_builder_assets backend.tests.test_builder_injection
python -m backend.app.builder_score backend/tests/fixtures/builder/stonebridge-large
python -m backend.app.builder_score backend/tests/fixtures/builder/snappage-like
node --test api/test/*.test.mjs        # the fetch bridge and the Worker access rules
cd frontend && npm test
```

## What didn't work (and what we changed)

| Problem | Cause | Fix |
|---|---|---|
| A contact form's "Which service?" dropdown was read as service times | The parser read `<select>` options as page text | Skip `select` and `textarea` |
| The home page was counted twice, doubling every claim | `/` and `/index.html` are the same page | Drop pages whose text is identical |
| A one-time event with a date and time was read as a weekly service | A dated event looks like a service time | `DATED` pattern: a time next to a date is not a weekly service |
| "Wednesday" was never matched | The day pattern was built as `Wed` + `day` | One pattern per day: full name or 3-letter form |
| Typing "Sunday 9am, Wednesday 7pm" put both times on Sunday | Answer parsing used the first day for every time | `_parse_services` keeps each time on its own day |
| AI code crashed when picking a church | `db.current_church()` returns a string; the code indexed it | Use the string |
| AI calls failed silently | `provider_chain` returns keys, not clients | Use `chat.make_clients()` |
| A real import could take minutes | Pages and AI calls ran one after another | 75 s budget, parallel AI calls (above) |
| "Create your church" could never succeed | The team turned off public church sign-up | Preview mode shows the built site with no account. Real provisioning is a team decision. |
| 12 pages were mostly blog posts on a big site | Breadth-first crawl in link order | Sitemap and menu discovery, scored priority, at most 3 posts |
| Menu links ("Our Team" then "Ministries") were read as a staff card | Navigation text is page text | Menu link text never counts as a person or campus |
| A sermon was listed twice | The same YouTube video was linked as `watch?v=` and embedded as `/embed/` | One canonical address per video |
| Applying a draft blanked the church's city | `info` is replaced whole and the draft has no city | Apply keeps the city and care team the church signed up with |
| Disallowed `/assets/*` pages were read | Python's robots parser ignores `*` wildcards | Our own RFC 9309 matcher |
| A site's Crawl-delay was ignored, and feeds and images skipped robots.txt | Only pages were checked | `HostPolicy` for every fetch, with per-host pacing |
| "9:00 & 11:00 am" became only 11:00 | Only times with their own am/pm were read | A trailing am/pm covers the times listed before it |
| "October 25h" and "the 15th" events turned into service times | The date pattern missed ordinals and typos | `DATED` reads ordinals, typos and numeric dates |
| "Grace Chapel - Home" gave no name | Only "Page \| Name" titles were read | The title part that says church, or `og:site_name` |
| "Dr. Jane Whitfield", wrapped roles and Elders lists were missed | Lowercase-only title prefixes; one-line roles | Capitalized titles, two-line roles, leadership lists under a heading |

## Not done yet

- **JavaScript-only sites** (the Riverstone fixture) need a real browser to render them, e.g. Cloudflare Browser Rendering.
- **Editing recreated pages** after creating the church: Church setup can replace the `site` and `pages` sections through `PUT /api/church/content`, but has no page editor yet.
- **Copying images** to the church's own storage: images stay on the old site, so they disappear if that site goes away.
- **Repeating events from page text** are only found by the AI reader; without it, only dated listings, iCal and JSON-LD events are found.
- **Transcribing sermons on import.** Imported YouTube sermons can be transcribed from Sermon Notes in one step, but nothing is transcribed automatically.
- **Provisioning:** how a builder draft becomes a real church now that public sign-up is off. For example, a platform key or an invite code.

### Start from site JSON files

On `#/new`, choose **Start from JSON files**. Upload the versioned `church.json` and `site.json` from PR #102, or legacy `church.json` (with `info`) and the optional `ministries.json`, `events.json`, `builder.json` or `regions.json`, or the combined JSON from **Download site files (JSON)**. Uploads may total at most 10 MB; the compact site data sent to the API must fit within 2 MB. The public `POST /api/builder/drafts/json` uses the usual import limits and validates through `builder_export.load()`; it does not crawl or call AI. Version 1.0 headers and evidence are validated; newer unsupported versions and overlapping sections are rejected. Versioned source evidence remains available in the preview.

The loaded draft goes straight to Review, preserves all supplied content in the site preview, and creates a church through the existing invite-code and Owner-account flow. Change the files and import again to edit before launch; Church setup remains available after launch. Plain-word extraction edits are unavailable for JSON drafts. Draft expiry and retrying a failed apply work as usual.

Offline verification: `python -m unittest backend.tests.test_builder_json_import` runs the local giving adapter (Node 24 and `api-giving` dependencies required) on an ephemeral port with a generated, test-only invite code. The test checks the real Worker registry lookup and Owner-token gate before applying with its church headers. It skips the integration case if Node or adapter dependencies are missing.
