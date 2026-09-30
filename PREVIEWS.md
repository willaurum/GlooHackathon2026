# Branch previews

Every team branch gets its own live preview on Cloudflare, built by
`.github/workflows/previews.yml`. Nobody has to deploy by hand.

## When a preview is made

- **A push** to a branch named `jaron-*`, `ben-*`, `erik-*`, `will-*` or `feature/*`.
- **A pull request** opened in this repo: it previews the branch the pull
  request goes into, with the pull request merged in. A comment on the pull
  request links it.
- **By hand**: Actions > Previews > Run workflow, pick the branch.

Each branch gets **one** preview. If it already exists, the run stops and
says so, so later pushes do not change it. To rebuild it, run the workflow by
hand with **force** ticked: that deletes that one preview Worker and deploys
it again.

## Where it is

`https://preview-<branch>-gloo-hackathon2026.jaronwilson2025.workers.dev`,
with the branch name in lowercase and anything other than letters and digits
turned into `-`. For example `feature/prayer-map` becomes
`preview-feature-prayer-map-gloo-hackathon2026`.

Branches that already have a `wrangler.jsonc` (the `jaron-*` ones) keep the
name in that file, for example `preview-frontend-gloo-hackathon2026`, because
the live APIs only accept calls from the names in their `ALLOWED_ORIGIN`.

## What is in it

- **Branches with a `wrangler.jsonc`** (Cloudflare-native): the built frontend,
  calling the live church and giving APIs. The data is real and shared.
- **Branches with the FastAPI + Postgres backend** (erik, ben, will, prayer
  map, main): the built frontend plus `preview-api-stub/`, a stand-in for the
  backend's API that runs inside the preview itself, seeded from the branch's
  `backend/app/*.json`. No database and no AI: chat, event summaries and
  prayer angles give demo answers. Its data is kept in memory, so what you add
  can reset when the preview has been idle.

## The token

The workflow reads the Cloudflare token only from the `CLOUDFLARE_API_TOKEN`
repository secret (Settings > Secrets and variables > Actions). It needs
**Workers Scripts: Edit** on the `jaronwilson2025` account. If the token can
see more than one account, also set a repository **variable**
`CLOUDFLARE_ACCOUNT_ID`. The previews are public URLs.

A pull request from a fork gets no preview, because GitHub does not give
forks the secret.
