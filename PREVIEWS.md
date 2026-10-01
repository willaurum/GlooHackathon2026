# Branch previews

Every team branch gets its own live preview on Cloudflare, built by
`.github/workflows/previews.yml`. Nobody has to deploy by hand.

## When a preview is made

- **Every push** to `main` or a branch named `jaron-*`, `ben-*`, `erik-*`,
  `will-*` or `feature/*`, merges included, builds the branch and deploys it
  over its preview. The preview always shows the branch's latest commit, a
  minute or two after the push. If you push again while a build is running,
  the newer push wins.
- **A pull request** only builds, as a check that it still compiles. It does
  not deploy, so unmerged code never replaces a preview. Once it is merged,
  the push to the target branch updates that branch's preview.
- **By hand**: Actions > Previews > Run workflow, pick the branch.

A branch only runs this if it has `.github/workflows/previews.yml`. Branches
made from `main` have it.

## Where it is

`https://preview-<branch>-gloo-hackathon2026.jaronwilson2025.workers.dev`,
with the branch name in lowercase and anything other than letters and digits
turned into `-`. For example `feature/prayer-map` becomes
`preview-feature-prayer-map-gloo-hackathon2026`.

`main` is the exception: its preview is the live site,
`preview-frontend-gloo-hackathon2026`, the name in its `wrangler.jsonc`,
because the live APIs only accept calls from the names in their
`ALLOWED_ORIGIN`. **Only `main` deploys there.** Any other branch that has
that `wrangler.jsonc` (every branch made from `main`) gets its own
`preview-<branch>` Worker, so pushing a branch never changes the live site.

## What is in it

- **`main`** (Cloudflare-native): the built frontend, calling the live church
  and giving APIs. This is the live site.
- **Other branches with a `wrangler.jsonc`** (anything made from `main`): the
  built frontend plus `preview-proxy/`, which forwards `/api/*` to the live
  church API and `/giving-api/*` to the live giving API. The data is real and
  shared with the live site, so a branch preview can change it. A Stripe
  checkout started there returns to the live site afterward.
- **Branches with the FastAPI + Postgres backend** (erik, ben, will, prayer
  map): the built frontend plus `preview-api-stub/`, a stand-in for the
  backend's API that runs inside the preview itself, seeded from the branch's
  `backend/app/*.json`. No database and no AI: chat, event summaries and
  prayer angles give demo answers. Its data is kept in memory, so what you add
  resets on every deploy and when the preview has been idle.

## The token

The workflow reads the Cloudflare token only from the `CLOUDFLARE_API_TOKEN`
repository secret (Settings > Secrets and variables > Actions). It needs
**Workers Scripts: Edit** on the `jaronwilson2025` account. If the token can
see more than one account, also set a repository **variable**
`CLOUDFLARE_ACCOUNT_ID`. The previews are public URLs.

A pull request from a fork gets no preview, because GitHub does not give
forks the secret.
