# QA test cases and results

Copies of everything in the team's Google Drive folder **Tests Cases and Results**, taken on Oct 7, 2026. The Drive files remain where they are edited. These copies are what reviewers can open without Drive access. All names, emails and phone numbers in them are made up (`example.org`, `555` numbers).

| File | What it is |
|---|---|
| [agentic-builder-test-cases.csv](agentic-builder-test-cases.csv) | **The 44 agentic builder cases** (Drive sheet "Agentic Builder Test Cases"). Columns: name, category, page, action, expected outcome, outcome/result and Pass/Fail. **40 Pass, 4 Fail.** Two of the fails were fixed and retested in code ("Hide the youth ministry", the theology request); the other two are "by design" expectation mismatches (robots.txt server error, scanned PDF without vision). See [build-docs/evaluation.md](../../build-docs/evaluation.md) §7.3 and §7.5. |
| [2026-10-07-builder-cases.csv](2026-10-07-builder-cases.csv) | The same 44 cases with how each was checked (automated test, offline fixture, browser, simulated AI) and the test that covers it. |
| [platform-test-suite/Test_Results.xlsx](platform-test-suite/Test_Results.xlsx) | **The full platform QA suite** (Drive "Test_Results"): 180 cases across every page, with a summary dashboard. Only the 20 original builder cases have results so far (16 Pass, 4 Fail); the other 160 are marked Unknown, i.e. not yet run. The dashboard's 80% pass rate is for those 20 builder cases only. |
| [platform-test-suite/sheets/](platform-test-suite/sheets/) | Each sheet of `Test_Results.xlsx` as CSV, readable on GitHub: `00-summary-dashboard.csv`, `01-all-test-cases.csv`, `02-agentic-builder.csv` and one file per page (Home, Plan your visit, Welcome team, Serve, Sermon Notes, Calendar, Give, Prayer map, About pages, Admin pages, sitewide chat). |
| [platform-test-suite/Tekton_Human_Readable_Test_Cases.xlsx](platform-test-suite/Tekton_Human_Readable_Test_Cases.xlsx) | The blank template of the same 180 cases, before any were run (all Unknown). |
| [2026-10-07-website-review.md](2026-10-07-website-review.md) | A written review of the site. |

The automated tests these cases point to are in `backend/tests/` (Python), `frontend/src/*.test.js`, `api/test/` and `api-giving/test/`. One full recorded builder run is in [build-docs/session-logs/](../../build-docs/session-logs/).
