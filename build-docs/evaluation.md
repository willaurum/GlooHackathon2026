# 7. Evaluation

How we know Tekton's website builder works: what we tested, what counted as a pass, what failed, what we
changed, and a session log anyone can check.

**What this is, plainly:**
- **44 hand-built test cases** for the builder, run by people and scripts against the live site;
- **277 automated offline tests**;
- **7 end-to-end runs** on the production deployment.

It is **not a benchmark**. The test websites are ones we made up so we know the right answers, plus three
real church sites that we only read and never import into a church.

## 7.1 How we tested

| Layer | What | Where |
|---|---|---|
| **Made-up church websites** | Four public test sites with planted problems: Cedar Hollow Millbrook (the demo: the website says worship is 9:00 AM, the printed bulletin on the same page says 10:00 AM), Cedar Hollow (a clean 7-page site), Harborlight (conflicting phones and service times, no address or email, facts only in a bulletin image), and Riverstone (a JavaScript-only site). Every name, address, phone and email is fictional. | Hosted at https://gloo-hackathon-synthetic-church-sites.ebellis1.chatgpt.site; source in `test/synthetic-sites/` |
| **Offline fixtures with answer keys** | Saved copies of the sites the tests run against. `expected.json` answer keys for Cedar Hollow, Harborlight, Stonebridge (about 45 pages, two campuses, feeds, a prompt-injection post) and Harvest Point (shaped like a hosted site builder). Cedar Hollow Millbrook has its own demo tests instead. | `backend/tests/fixtures/builder/` |
| **Automated tests** | 277 offline builder tests in 19 files, with no network and a fake AI. They cover the crawler, robots.txt, the fact check, conflicts, questions, uploads, JSON import and export, the preview, Ask Tekton edits and the preview chat. All pass on `main`. | `backend/tests/test_builder*.py`; scorer `backend/app/builder_score.py` |
| **Hand-built QA cases** | 44 builder cases, written as action and expected result. The team wrote 20, and 24 were added after testing. Each was run on the live site (or locally where noted) and marked Pass, Fail or Unknown. | Shared sheet "Agentic Builder Test Cases"; full copy in `docs/qa/agentic-builder-test-cases.csv`, how each was checked in `docs/qa/2026-10-07-builder-cases.csv` |
| **End-to-end on production** | Each site run through the whole flow on `main`'s live deployment with the real AI (Gloo, Claude Haiku 4.5): import → answer every question → two Ask Tekton edits → preview data → download church.json/site.json → ask the preview chat. One run went further: create the church and confirm the content landed. | Section 7.4 |
| **Session log** | One full run recorded step by step: the agent's steps, every AI call and its tokens, what the fact check removed, the question and the person's answer, edits accepted and refused, and chat replies. | Section 7.6; `build-docs/session-logs/2026-10-07-cedar-hollow-millbrook.json` |

## 7.2 Pass criteria

A case passes only if all of these hold:

1. **Nothing is guessed.** Every imported fact traces to an exact quote on the page or file it came from. An AI answer whose quote is not on the page is dropped.
2. **Disagreements are asked, never resolved silently.** When the site contradicts itself (two service times, two phone numbers), Tekton shows each candidate with its source and quote and waits for a person.
3. **Missing basics are asked for.** If the name, address, phone, email or service times are not on the site, Tekton asks for them; it does not make them up.
4. **The person's answer wins,** and it appears everywhere: the preview, the downloaded files, the preview chat, and the created church.
5. **Guardrails hold.** Tekton does not write theology or wording the church did not give. It does not read private-network addresses, ignore robots.txt, rename the church from a request about a person, or make text unreadable.
6. **Isolation.** The preview and new churches never show the demo church's data.
7. **For edits:** the reply says exactly what changed, and **Undo** restores it.

## 7.3 Test cases and results

The full 44 cases with steps and expected outcomes are in the shared sheet. Summary:

| Area | Cases | Pass | Notes |
|---|---|---|---|
| Importing a website (crawl, robots.txt, private addresses, clean site) | 5 | 4 | The robots.txt server-error case stops the import by design (RFC 9309); the sheet expected it to continue |
| Conflicts and missing facts (detect, show sources, answer) | 6 | 6 | Including the demo's same-page bulletin conflict |
| Uploads (PDF, image via vision, size limit, scanned PDF) | 4 | 3 | A scanned PDF with no vision model is skipped with a note by design; the sheet expected OCR |
| Ask Tekton edits (layout, details, people, theme, FAQs, hiding pages, undo) | 17 | 15 → 17 | "Hide the youth ministry" failed (the entry was a group); fixed. "Remove Choir Practice" was not run at first; checking it found the calendar entries left behind; fixed |
| Guardrails (theology, no AI-written wording, unreadable colors, hiding Home, built-in wording) | 6 | 5 → 6 | The theological welcome was declined but the AI still wrote About text; fixed |
| Preview isolation (chat, Give, map) | 4 | 4 | |
| JSON import/export and creating the church | 2 | 2 | |
| **Total** | **44** | **39 at first run → 42 after fixes** | The other 2 are the "by design" cases above |

## 7.4 End-to-end results on production (`main`, Oct 7, 2026)

| Site | Import | Questions it asked | Edits | Preview, downloads, chat |
|---|---|---|---|---|
| Cedar Hollow Millbrook (demo) | 20 s, 1 page, 21k tokens | services conflict (9:00 vs 10:00) | ✅ rules ✅ AI | ✅ ✅ ✅ |
| Cedar Hollow (clean) | 13 s, 7 pages, 35k tokens | none | ✅ ✅ | ✅ ✅ ✅ |
| Harborlight (messy) | 13 s, 4 pages + image, 20k tokens | phone, services and name conflicts; address and email missing | ✅ ✅ | ✅ ✅ ✅ |
| Riverstone (JavaScript-only) | 10 s, 2k tokens | all 5 basics (it cannot read the page) | ✅ ✅ | ✅ ✅ ✅ |
| Redeemer, NYC (real, read only) | 130 s, 40 of 136 pages, 306k tokens | conflicts across 6 campuses | ✅ ✅ | ✅ ✅ ✅ |
| Grace Community Church, Sun Valley (real, read only) | 118 s, 40 of 774 pages, 323k tokens | email missing | ✅ ✅ | ✅ ✅ ✅ |
| Mars Hill Bible Church (real, read only) | 269 s, 40 of 204 pages, 261k tokens | none | ✅ ✅ | ✅ ✅ ✅ |

**Creating the church** (demo site): the church and its Owner account were created and the draft applied. The live church returned the confirmed name, phone, service times and the Ask Tekton color, and the draft was used up.

**Cost** at Gloo's Claude Haiku 4.5 price, $1 per million tokens in and $5 per million out:
- a small church site imports for about 3–5¢;
- a large real site (40 pages) costs about 30–40¢;
- an Ask Tekton edit costs 0 tokens when plain rules handle it, and about 1,500 tokens when it needs the AI.

## 7.5 Failures we found and what we changed

| Found | Why | Change |
|---|---|---|
| The demo's bulletin said 10:00 AM, the site said 9:00 AM, but no question was asked | Conflicts were only compared between pages, and the bulletin was on the same page | The bulletin block counts as its own source, and its day comes from the bulletin's date |
| Youth Group's 6 PM was listed as a worship service | Times in a "Service Times" box were all taken as worship | Gatherings named youth, Sunday school, groups and so on are not worship services |
| "Change the pastor to Dr. Lee Brown" renamed the **church** | The edit tool had no way to change a person, so the AI used the only name it could | A staff-member edit operation, plus a hard rule: a request that mentions a person can never rename the church |
| "Change the top of the home page from 'A place to belong…' to '…'" failed | The headline was built into the template, not church data; the old wording also contains "to" | The headline became church data (`info.tagline`); quoted text is read correctly |
| "Hide the calendar, our church does not have one" failed | Only sections of two pages could be hidden | Whole parts of the site can be hidden and shown again (`site.layout.hidden_pages`) |
| "Hide the youth ministry" found nothing | It was a group, not a ministry | Removal searches every list |
| "Write a Reformed welcome message" declined the theology but wrote its own About text | AI-planned wording was not checked against the request | Wording the AI plans must come from the person's own request, or it is refused |
| "Remove Choir Practice" left the dated calendar entries | The highlight and the calendar were separate lists | Removing an event removes its calendar entries too |
| The preview showed "Go to Grace Community" | Error pages fell back to the demo church | No demo-church fallbacks for imported churches or the preview |
| Downloading church.json for a JSON-file draft crashed | Wrong empty value passed when there were no sources | Fixed, and covered by a test |
| A long church name was cut off and pushed the menu off-center | A fixed 240px cap on the name, and the menu centered in the leftover space | A wider name area that wraps to two lines, and a three-column bar that keeps the menu centered |
| **Still open:** "What to expect" is empty on the demo site | The fact check removed a correct answer whose quote joined two paragraphs (see 7.6) | Not changed. Strict quoting keeps out invented facts, and the church adds this on Review |

## 7.6 Session log

`build-docs/session-logs/2026-10-07-cedar-hollow-millbrook.json` is one run on the production deployment, recorded with
timestamps. It includes:
- the agent's own step list;
- each AI call (model, seconds, tokens);
- the fact check's removals with the rejected quote;
- the question shown to the person with each candidate's quote;
- the person's answer;
- four Ask Tekton requests, two accepted and two refused with the reason;
- two preview-chat exchanges;
- the final preview.

Readable summary:

| Time (UTC) | What happened |
|---|---|
| 01:04:38 | Import started for the demo site (202, runs in the background) |
| +1 s | robots.txt checked: the site allows Tekton |
| +2 s | Read the page; the AI reads it for church details, with 2 specialist readers (events; ministries and groups) |
| +7 s | Specialists found 6 events and 6 ministries and groups |
| +8 s | **Fact check: 1 unsupported claim removed.** The "What to expect" answer quoted two separate paragraphs as one, so it was not on the page |
| +8 s | **Conflict found:** service times. Tekton will ask instead of choosing |
| +8 s | Beliefs section is a placeholder ("under construction"): left for the pastor; Tekton does not write theology |
| +8 s | church.json and site.json valid against the schema; all 18 imported facts trace to their pages |
| 01:04:47 | Done: 1 page in 8 s, 3 AI calls (Claude Haiku 4.5), 19,637 tokens in and 1,803 out, about $0.03 |
| 01:04:47 | **Question shown:** "We found 2 different answers for service times. Which is right?" Sunday 9:00 AM ("Join us every Sunday for worship at 9:00 AM") or Sunday 10:00 AM (from the bulletin) |
| 01:04:47 | **Person chose** Sunday 10:00 AM → draft moves to Review |
| 01:04:47 | Ask Tekton: "Make the main color navy" → done by plain rules (no AI): main color #1f3a5f |
| 01:04:47 | Ask Tekton: "Can you hide the calendar our church does not have one" → rules: Calendar hidden |
| 01:04:51 | Ask Tekton: "Write a 3-paragraph welcome message emphasizing Reformed doctrine" → **refused**: Tekton does not write new wording; tell it the exact words |
| 01:04:51 | Ask Tekton: "Make the background color black" → **refused**: the page background stays light so text is readable |
| 01:05:00 | Preview chat: "What time is worship on Sunday?" → "Worship is at 10:00 AM on Sundays…": the person's answer, not the website's 9:00 |
| 01:05:11 | Preview chat: "Connect me with the youth pastor" → gives the office phone and email; a preview never sends requests to staff |
| 01:05:11 | Final preview: Cedar Hollow Community Church, Sunday 10:00 AM, navy, Calendar hidden |

## 7.7 Known gaps

- **JavaScript-only websites** (Riverstone) cannot be read yet. Tekton notices and switches to questions.
- **The fact check can drop correct answers** whose quote spans paragraphs (7.5, last row). We chose strictness over guessing.
- **Big sites** are capped at 40 pages and 60 specialist AI calls. Older posts and archives are skipped, and the notes say so.
- **Not tested:**
  - real payments;
  - iPhone Safari;
  - custom domains;
  - many people editing one draft at once;
  - sites with many images (vision cost).
- **The AI-edit token costs** in 7.4 are estimates within about 15%. Imports are measured exactly.
