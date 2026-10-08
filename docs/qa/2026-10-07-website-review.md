# Website QA — 2026-10-07

Erik's testing branch: `erik-testing`, based on `jaron-cloudflare-frontend` at `4f45edd`. Includes the existing Erik fixes from PR #115; that PR was not merged into the team base as part of this review.

Inputs: [Agentic Builder Test Cases](https://docs.google.com/spreadsheets/d/15paMv_C0MvtyGbUPwS8cdA2adQCRf1nenMtIQWb9_eA/edit) (44 cases), [Test Results](https://drive.google.com/file/d/1nMD4c9K-BLCGX2QK2sxBYr6tbz_nWelJ/view) (180 distinct cases), and `docs/Agent-Build-Doc.md`. The supplied workbook repeats some tables; repeated rows were not counted as new cases. The sheets were read, not edited.

## Changes resulting from the review

- “Remove Choir Practice” previously removed its Home/Visit highlight but left dated calendar entries. Removing an event now clears its matching highlights and calendar occurrences; unrelated events remain. A regression test verifies preview, download and undo.
- Reused #115's fixes for finding a group when the request calls it a ministry and refusing AI-written wording the church did not supply.
- Both end-to-end scripts still expected public registration to be disabled. They now verify required Owner details and separate Owner sessions. The giving test now expects a portal return link to its own church, rather than the default church.
- Corrected the README's obsolete builder/signup and calendar-summary descriptions.
- Added the entire published synthetic website set to [`test/synthetic-sites`](../../test/synthetic-sites/README.md), including Riverstone's React bundle/data and Harborlight's bulletin image. The source version and local serving command are documented there.

## Checks completed

| Check | Result |
| --- | --- |
| All backend tests (`unittest discover -s backend/tests`) | 454 passed |
| Frontend tests and production build | 108 passed; build passed |
| Church Worker TypeScript and all `test/*.test.mjs` | 75 passed |
| Giving TypeScript; signup, anonymization and staff-race tests | 8 passed |
| Sitewide end-to-end script with local access gate | 41 checks passed |
| Giving end-to-end script with local adapter and fake Stripe | 179 checks passed; public-response leak scan passed |
| Desktop and 390px Chromium click-through | Passed; 18 preview routes had content, no alert messages and no horizontal overflow |
| Synthetic Riverstone website | Rendered church details/services from its local JavaScript/data |

The local church access gate uses the production `churchPath`, `findChurch`, `access`, `requireStaff` and `churchHeaders` helpers, forwarding to the real Python backend and the local giving adapter. It does not emulate the Cloudflare container/runtime or the operator API-key path. Unit checks cover Worker access rules separately. Fake Stripe never charges a real account.

## Browser session log

1. Upload fictional Lantern Meadow JSON; open Review and the site preview.
2. Ask Tekton to change the Home headline; check the rendered heading and downloaded church.json; Undo restores it.
3. Check approved hero/logo imagery, theme, registration link and imported-page navigation. Unapproved imagery is absent.
4. At 390px, visit Home, Serve, Find a place, Saved, Notes, Calendar, Give, Mission trips, Prayer, Plan your visit, Welcome team, Story, Beliefs, News, Directory, Connect, Staff and Setup. Verify visible content and no horizontal overflow. Staff areas show access guidance in a public preview.
5. Click Home's serving and first-visit CTAs; verify the destination routes.
6. Create the fictional church and its Owner without an invite code; launch retains its content/imagery.
7. Edit an imported page title/text in Setup; save; reopen the public page; follow its preserved internal link.
8. Create a calendar event; show Upcoming; search; delete the event and verify it disappears.
9. Publish a news update; verify it appears; delete it.
10. Sign out; Setup requests login and calendar creation controls disappear.
11. As a visitor, register a visit, mark arrival and reload; the visit is retained. Welcome team remains staff-only.
12. Open the repo's synthetic website index and Riverstone; verify client-rendered church/service content.

No uncaught browser exceptions occurred. This is a local review, not a new production deployment or live-model evaluation. No live church or payment was created.

## Builder case coverage

The [case-by-case coverage table](2026-10-07-builder-cases.csv) distinguishes local runtime evidence, simulated AI/vision and expectation mismatches. A covered test means the behavior is exercised; it does not mean every exact sentence in the sheet was sent to a live model.

Important sheet corrections:

- AI should not invent theological/marketing prose. The church supplies the wording. #115's checked-operation guard is included here and tested with a simulated AI plan.
- A scanned PDF without a vision model is skipped with a note; there is no automatic OCR in that configuration.
- Unreadable robots.txt (5xx) stops the import; it does not bypass robots rules.
- Creating a church yields its own site link and Owner account; it does not automatically register a public custom domain.
- The calendar's automatic AI bulletin summaries were removed by #105. Event detail modals and .ics export are not current calendar features.
- The guest form's contact field is optional. Arrival is “I'm here”; there is no guest “I'm on my way” control. The welcome team owns the on-the-way handoff.
- Saved connections and welcome-team queues require staff; they are not public visitor lists.
- Original React JSX/build sources were not in the synthetic Site source repository. The checked-in published bundle is the runnable code that was available, not reconstructed JSX.

The larger 180-case workbook was used to choose the page/flow checks. It is not accurate to label all 180 cases as individually passed: live AI/vision, real Stripe/YouVersion, native mobile Safari, custom-domain provisioning and multi-device concurrent editing were not exercised here. Cases that describe absent controls remain feature requests or outdated expectations, not demonstrated passes.

## Reproduction

```bash
python -m unittest discover -s backend/tests
cd frontend && npm test && npm run build
cd ../api && npx tsc --noEmit && node --test test/*.test.mjs
cd ../api-giving && npx tsc --noEmit && node --test test/signup.test.mjs test/anonymize.test.mjs test/staff-races.test.mjs
```

Run `api-giving/test/fake-stripe.mjs` and `api-giving/test/local-worker.mjs` for giving checks, with `API=http://127.0.0.1:8803`, `STRIPE=http://localhost:12111` and `FIXTURE_API=http://127.0.0.1:8803/__fixtures/churches`, then `node test/api.test.mjs`. For sitewide checks, supply a local church Worker connected to the same giving adapter and backend and run `node api/test/sitewide.e2e.mjs` with `API`, `GIVING` and `FIXTURE_API` set as documented in README. Never point these write tests at production.
