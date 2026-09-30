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

Branches that have a `wrangler.jsonc` (`main` and the `jaron-*` ones) keep the
name in that file, for example `preview-frontend-gloo-hackathon2026` for
`main`, because
the live APIs only accept calls from the names in their `ALLOWED_ORIGIN`.

## What is in it

- **Branches with a `wrangler.jsonc`** (Cloudflare-native): the built frontend,
  calling the live church and giving APIs. The data is real and shared.
- **Branches with the FastAPI + Postgres backend** (erik, ben, will, prayer
  map, main): the built frontend plus `preview-api-stub/`, a stand-in for the
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
