# GlooHackathon2026 — Pastor Notes

Transcription + grounded Q&A for sermons, built entirely on Cloudflare.
Upload a video (or paste a YouTube link), and it is transcribed on
Cloudflare (Whisper large-v3-turbo via Workers AI), chunked, embedded,
and stored — then you can ask questions about it and only get answers
the transcript actually supports.

Part of the Gloo Hackathon 2026. This branch: `pastor-notes`.

## What is deployed

| Worker | Purpose |
|---|---|
| `gloo-hackathon2026-api-pastor-notes` | The backend: a Cloudflare **Container** (Python FastAPI + ffmpeg + yt-dlp) backed by a **SQLite Durable Object**, with **R2** for media and **Workers AI** for models. |
| `preview-pastor-notes-gloo-hackathon2026` | The frontend preview (React/Vite) for this branch. |

The branch is **church-agnostic by design**: the church name, contact info
and any per-church config lives in a Durable Object (settable at runtime
with the admin key), and all secrets are per-deployment. Any church gets
their own subdomain + their own keys.

## How it works

```
YouTube URL / file upload
        |
        v
Container (ffmpeg + yt-dlp) ----> R2 (raw media)
        |
        v  Workers AI: whisper-large-v3-turbo
   transcript + timestamped segments
        |
        v  Workers AI: bge-base-en-v1.5 (embeddings)
   chunks in the SQLite Durable Object
        |
        v  ask a question
   ranked chunks -> grounded answer with citations
```

**Grounded Q&A (the important part).** Every question is answered in two
independent modes:

- **Extractive (default, no AI key needed):** the best-matching verbatim
  transcript passages, each with a timestamp citation. A passage must pass
  a similarity floor **and** a keyword-overlap ground check to be returned;
  otherwise the answer is "Not found in this note."
- **`workers-ai` LLM engine (optional):** set `NOTES_ANSWER_ENGINE=workers-ai`
  in `api/wrangler.jsonc` and redeploy. A Llama-3.1-8B (Workers AI) then
  writes prose answers — but every passage it cites is string-verified
  against the actual transcript, and any quote that fails falls back to the
  verbatim answer. The LLM can only make answers *prettier*, never less
  grounded.

## Keys / secrets

All are set on the API worker with `npx wrangler secret put <NAME>` (run from
`api/`). They are never in code, never in the repo.

| Secret | Required | What it does |
|---|---|---|
| `NOTES_API_KEY` | yes | Gates every `/api/*` route. The frontend holds it in the browser session only (paste it on the page). No key configured => all API calls return 503. |
| `NOTES_ADMIN_KEY` | for config changes | Required to change the church config (name, contact, etc.). |
| `YTDLP_COOKIES` | no | Your YouTube cookies, to get past YouTube blocking Cloudflare server IPs. See note below. |

A copy of the generated keys is kept on the laptop at
`~/.config/pastor-notes/` (owner-only) because Workers secrets cannot be
read back.

## Known limitation: YouTube egress

YouTube intermittently refuses downloads from Cloudflares server IPs, so a
YouTube link can fail with a clear `youtube_blocked` error. Two workarounds:

1. **Upload the video file instead** — the "Upload a file" tab. 100%
   reliable, never touches YouTubes servers.
2. **Set the `YTDLP_COOKIES` secret** — a permanent fix for YouTube links.

Retrying a YouTube link sometimes succeeds (the block is flaky, not total).

## Run it locally

The old `docker compose` setup (nginx + FastAPI + Postgres) is the base
branchs dev loop and still works for the *original* app. For the Pastor
Notes stack (Workers + Durable Object + R2 + Workers AI) use the wrangler
dev flow:

```bash
cd api
npm install
npx wrangler dev      # local Durable Object + R2 emulation
```

The container build itself:

```bash
docker build -t gloo-pastor-notes:latest backend/
```

## Repo layout (this branch)

| Path | Whats in it |
|---|---|
| `api/` | The Workers backend: `wrangler.jsonc`, the Container worker, the SQLite Durable Object, R2, Workers AI calls, and the grounded-Q&A engine. |
| `backend/` | The Python container image (FastAPI, ffmpeg, yt-dlp). |
| `frontend/src/PastorNotes.jsx` | The preview page: key entry, YouTube/upload tabs, notes list, transcript + ask view. |
| `db/` | Legacy Postgres schema from the base branch (unused by this stack). |

## Deploy checklist (per church)

1. `wrangler deploy` the API worker to the churchs subdomain.
2. `wrangler secret put` the churchs `NOTES_API_KEY` + `NOTES_ADMIN_KEY`.
3. (Optional) `YTDLP_COOKIES` if they want YouTube links to be reliable.
4. Set the churchs name/contact via the admin config endpoint.
5. Point their frontend at the API workers URL.
