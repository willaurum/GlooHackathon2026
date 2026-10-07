# Synthetic website inputs

These are the complete published files for the team's four fictional church sites, including the JavaScript-rendered Riverstone site. They can run locally without the hosted copy or an npm build.

```bash
python3 -m http.server 8091 --directory test/synthetic-sites
```

Open http://localhost:8091/ and select a site. The builder refuses private addresses in production; local fixture import testing must use its existing offline fixture loader or explicitly configured local development mode.

| Directory | Purpose |
| --- | --- |
| `cedar-hollow-static` | Seven consistent HTML pages, stylesheet and logo |
| `harborlight-messy` | Conflicting facts, broken links and a bulletin image |
| `riverstone-react` | A real client-rendered React bundle, stylesheet and church JSON data; raw HTML has no church facts |
| `cedar-hollow-millbrook` | One-page demo with conflicting worship times, outdated events and unfinished beliefs |

Imported unchanged from the existing Synthetic Church Websites Site source at commit `ee1ad62417ef573e68e2b9b3472846e0ed8eb9e1` (published version 2), on 2026-10-07. This snapshot includes the published React JavaScript bundle; the original JSX/build project was not present in that source repository. No deployment credentials or hosting configuration were copied.

Hosted counterpart: https://gloo-hackathon-synthetic-church-sites.ebellis1.chatgpt.site/

The smaller extraction fixtures and their answer keys remain under `backend/tests/fixtures/builder/`. This directory preserves the entire runnable website set rather than replacing those fixtures. Inconsistencies, broken links and outdated copy in these inputs are intentional. All churches and people are fictional.
