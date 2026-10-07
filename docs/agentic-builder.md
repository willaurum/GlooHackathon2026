# How the agentic builder works

The builder turns an existing church website into a Tekton site. Open `#/new`, paste a web address, answer a few questions, and preview the result. This doc covers how it decides what to trust, how it is tested, and what went wrong along the way.

Code: `backend/app/builder.py` (pipeline and routes), `frontend/src/Builder.jsx` (the `#/new` page), `backend/tests/test_builder.py` (tests), `backend/tests/fixtures/builder/` (made-up church sites).

## The framework

The team agreed on five steps:

| Step | What happens | Where |
|---|---|---|
| **Import** | Read up to 12 pages on the same site, plus up to 5 same-site images | `crawl`, `read_images` |
| **Extract** | Collect every candidate value as a *claim*, each with the page and exact quote it came from | `pattern_claims`, `ai_claims` |
| **Clarify** | Plain code compares the claims. If they disagree or are missing, it asks the person | `reconcile`, `questions` |
| **Confirm** | The person picks a candidate, types their own, or edits on the review screen | `apply_answer` |
| **Build preview** | Confirmed values fill the existing church template | `build_content`, `#/new/preview` |

The rule underneath: **the AI may suggest; only the person confirms.** A value the site disagrees with about is never quietly chosen.

## Rules and AI: who does what

We split the work between deterministic rules ("NLP" in the classic sense: regular expressions and an HTML parser) and a language model.

| Job | Done by | Why |
|---|---|---|
| Find phone numbers, emails, street addresses, service times | **Rules** (`PHONE_RE`, `EMAIL_RE`, `STREET_RE`, `TIME_RE`, `DAY_RE`) | These have strict formats. Rules are instant, free, and never make things up. |
| Find the church name, the "about" text, what to expect on a first visit | **AI** (tool call `record_church_facts`) | No fixed format. "Harborlight Chapel" vs. "HLC" needs judgment. |
| Read a bulletin or flyer image | **Vision AI** turns the image into text, then the **same rules** read that text | One reading path for everything. |
| Decide whether candidates agree | **Rules** (`reconcile`) | This is the trust decision, so it must be predictable and testable. |
| Decide what to ask | **Rules** (`questions`) | Same reason. |

### Grounding: the AI must quote

Each AI suggestion must come with the **exact quote** from the page it read. `grounded()` checks that quote against the page text. If the quote is not there, the suggestion is dropped. This stops the model from inventing a phone number or "correcting" a service time. Every value shown to the person links back to a real sentence on a real page. That's what the conflict cards show ("HLC - Welcome!!: *Come worship with us Sundays 9 & 11.*").

### Reconciling

- **Phone and email:** if every page agrees, the value is accepted. If they differ, the builder asks, showing each candidate with its page and quote.
- **Service times:** compared day by day. "Sunday 9 & 11" on the home page and "Sunday 10:30" in a news post conflict. "Sunday 9 & 11" and "Sunday 9" do not; the second is a subset.
- **Missing required fields** (name, street address, phone, email, service times) become "We could not find…" questions. Optional fields are just left empty.

## Safety and limits

- **No private addresses.** Import refuses `localhost`, private networks and link-local addresses, including after redirects (`_check_public`). `BUILDER_ALLOW_PRIVATE=1` turns this off for local testing only.
- **Same site only.** The crawler never follows links to other domains.
- **Time budget.** An import finishes within 75 seconds, safely under Cloudflare's ~100 second request limit:
  - page reading stops after 30 seconds;
  - AI and image reads run four at a time;
  - anything still running when time is up is dropped.

  The draft's `notes` say what was skipped.
- **Rate limits:** 5 imports per IP per hour, 60 per hour overall, 3 at a time.
- **Drafts:**
  - stored outside every church's data, in the reserved `builder` space;
  - reached only by an unguessable 24-character id;
  - expire after 24 hours;
  - can be applied to a church only once, and never to the demo church.

## Testing

- **Made-up church sites** live in `backend/tests/fixtures/builder/`, with the full set (including a React site) in the separate `synthetic-church-sites` repo and hosted at https://gloo-hackathon-synthetic-church-sites.ebellis1.chatgpt.site. Every name, address, phone (555-01xx) and email (example.org) is fictional.
  - **Cedar Hollow:** the happy path. Clean, consistent information.
  - **Harborlight:** the hard path. Two phone numbers, three different service times (home page, news post, bulletin image), no street address, no email, five spellings of the name.
- **Tests run offline**, with fake fetch, fake AI and fake vision. They cover:
  - the demo conflict, AI grounding, image reading, private-address refusal, rate limits and draft expiry;
  - single-use apply and the demo-church guard;
  - multi-day typed answers and the time budget.
- **Accuracy score:** each fixture has an `expected.json` answer key. `builder_score` reports correct, wrong and missed fields, and conflicts and gaps flagged correctly or not.

  Rules-only baseline (offline, no AI), pinned by `backend/tests/test_builder_score.py`:

  | Site | Result |
  |---|---|
  | Cedar Hollow | 5/8 fields correct (name, address, phone, email, service times), 0 false questions. The other 3 are prose fields (about, first visit, office hours) that only the AI fills. |
  | Harborlight | 2/3 conflicts flagged (phone, service times), 2/2 gaps flagged (street address, email), 0 false questions. The varying church name is asked as *missing* rather than shown as a conflict, because the rules don't extract names (the AI does). |

```bash
.venv-builder/Scripts/python -m unittest backend.tests.test_builder backend.tests.test_builder_score
.venv-builder/Scripts/python -m backend.app.builder_score backend/tests/fixtures/builder/harborlight-messy
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

## Not done yet

- **Uploading files** (PDF bulletins, Word docs, images) and **starting from questions** instead of a website.
- **JavaScript-only sites** (the Riverstone fixture) need a real browser to render them, e.g. Cloudflare Browser Rendering.
- **More content:** events, groups and ministries aren't imported yet.
- **Provisioning:** how a builder draft becomes a real church now that public sign-up is off. For example, a platform key or an invite code.
