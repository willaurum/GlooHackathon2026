# Local development and AI options

Running Tekton on a laptop, and the AI options besides Gloo (local Ollama, the HPC tunnel, the team bridge). [Back to the README](../README.md)

## Without Docker

From the repo root, with Python 3.12 and Node 22:

```bash
python -m venv .venv && .venv/Scripts/pip install -r backend/requirements.txt   # bin/ instead of Scripts/ on macOS/Linux
cd backend && CHURCH_DB_URL=sqlite SQLITE_DB_DIR=./data ../.venv/Scripts/python -m uvicorn app.main:app --port 8000
cd frontend && npm ci && npm run dev        # Vite proxies /api to localhost:8000
python -m http.server 8091 --directory test/synthetic-sites   # the made-up church sites, for the builder
```

Set `GLOO_API_KEY` in the backend's environment for real AI answers; without it the chat uses demo replies and the builder keeps only rule-based details.

## Two branches: laptops, or Cloudflare

Nothing in this project depends on a machine that is neither a laptop nor Cloudflare. Two branches keep that honest:

- **`jaron-frontend`** runs entirely on a laptop: docker compose brings up the frontend, the FastAPI backend and Postgres, and the AI is an Ollama reached from the container. Set `AI_PROVIDER=ollama` in `.env`; see the HPC tunnel section below, or point `OLLAMA_BASE_URL` at an Ollama on that same laptop.
- **`jaron-cloudflare-frontend`** runs entirely on Cloudflare: Workers, the container, a Durable Object per church database, and Gloo AI over HTTPS. The only setup is one secret, run in `api/`:

  ```
  npx wrangler secret put GLOO_API_KEY
  ```

  Nothing else is needed. `AI_PROVIDER` is not passed into the container, so it takes its default of `gloo` from `backend/app/config.py`, and `platform.ai.gloo.com` is already in the container's `allowedHosts`. No laptop is in the path: no VPN, no SSH tunnel, no teammate running a bridge.

Both branches build from the same source and differ in configuration, not behaviour. Keep the `jaron-` prefix on any new branch: `previews.yml` triggers on prefixes, so a name outside its patterns is a branch that silently never deploys.

## Running on one laptop

```bash
git clone <repo> && cd GlooHackathon2026
docker compose up -d
```

The frontend is on <http://localhost:3000> and the API on <http://localhost:8000>. Church data is local SQLite files in the `church_data` volume (`CHURCH_DB_URL=sqlite`); the `db` Postgres service is left over from the base branch and nothing reads it. The AI defaults to Gloo, so put `GLOO_API_KEY=...` in `.env`, or run the AI on the laptop with no key at all:

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d
```

With that overlay the AI is an `ollama` container beside the backend, so the backend reaches it at `http://ollama:11434/v1` over the compose network. Nothing crosses to the host, which is what makes the firewall irrelevant and makes it behave the same on Linux, macOS and Windows. A container that talks to the host instead has to get past the host's firewall: on Ubuntu `ufw` defaults to dropping every container-to-host connection, and Windows Defender does the same, which is the usual reason `host.docker.internal` times out.

The first `docker compose up` downloads the Ollama image and the model (`llama3.2:3b`, about 2 GB) into the `ollama_models` volume, so it takes a few minutes once and starts quickly afterwards. `ollama-pull` is a one-shot service that exits 0 when the model is in place; the backend waits for it.

On the CPU a chat reply takes roughly 40 seconds and a calendar summary about 6. With an NVIDIA GPU and the NVIDIA Container Toolkit installed, this is much faster:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

To use a larger model, set `OLLAMA_MODEL` in `.env` before the first start (`docker compose up -d ollama-pull` fetches it). To use an Ollama elsewhere instead of the container, set `OLLAMA_BASE_URL`; the HPC tunnel below is one way to do that, and is the one path that needs host networking.

## HPC Ollama for local development

Everyone runs this on their own machine: the Liberty student VPN, the SSH tunnel, and docker compose. Nothing is shared between teammates and no fixed addresses are involved.

With the VPN connected, keep an SSH tunnel open (replace `YOUR_USERNAME`):

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 0.0.0.0:11434:arrietty.hpc.lan:11434 YOUR_USERNAME@totoro.university.liberty.edu
```

Then put this in `.env` beside `docker-compose.yml`:

```
AI_PROVIDER=ollama
OLLAMA_MODEL=gpt-oss:20b
```

Leave `OLLAMA_BASE_URL` unset. Under docker compose it defaults to `http://host.docker.internal:11434/v1`, the tunnel on your own machine, and `AI_BASE_URL` and `AI_MODEL` follow it, so there is nothing else to set. Outside Docker the backend falls back to `http://127.0.0.1:11434`. No API key is needed, and the chat adds `/v1` if it is missing. Both Find a place and the chat use it.

The bind address matters. `-L 0.0.0.0:11434` is what lets the container reach the tunnel; with the older `-L 127.0.0.1:11434` the tunnel accepts only loopback connections, and a container arrives over the Docker bridge instead. On Docker Desktop (macOS and Windows) loopback happens to work, because `host.docker.internal` is proxied through its VM, so `0.0.0.0` is the one spelling that works everywhere.

On Linux, also let the Docker bridges reach the host. With `ufw` enabled this is not specific to Ollama: `DEFAULT_INPUT_POLICY="DROP"` drops every container-to-host connection, so `host.docker.internal` reaches nothing at all. Ubuntu ships `ufw` inactive, so most machines never meet this; `sudo ufw status` says whether yours is one of them. The symptom is a timeout on `/api/ai/status` while the same URL answers from a terminal on the host. To confirm it is the firewall rather than the tunnel, reach for a port you know is open:

```bash
docker compose exec backend python -c "import socket;socket.create_connection(('172.17.0.1',22),5)"
```

A timeout there means the firewall, since that port has nothing to do with this project. Then allow the bridges:

```bash
sudo ufw allow from 172.17.0.0/16 to any port 11434 proto tcp
sudo ufw allow from 172.22.0.0/16 to any port 11434 proto tcp
```

Use the subnets rather than interface names: the compose bridge is named `br-<id>` and is renamed whenever the network is recreated. `docker network inspect <project>_default` prints the subnet in use if it differs.

Check it with `GET /api/ai/status`: `connected: true` and the model list means the tunnel is reachable. `connected: false` with the tunnel running is the firewall or the bind address above. If the tunnel's own far end is down, `curl 127.0.0.1:11434/api/tags` on the host returns nothing at all rather than JSON. Once it is up, `gpt-oss:20b` answers a chat turn or a calendar summary in about three seconds.

This tunnel only works locally, not from Cloudflare; for the deployed site, see the team AI bridge below.

## Team AI bridge (deployed site, team only)

This was the stopgap before the Gloo AI key arrived on Oct 7; Gloo now comes first and the bridge is only a backup. A teammate on the Liberty VPN runs `scripts/team-ai-bridge/` (one command; see [its README](../scripts/team-ai-bridge/README.md)). It puts the HPC model behind a gatekeeper that requires the team key and connects that to a named Cloudflare Tunnel with a fixed hostname, `https://team-ai.jaronwilson.dev`. The container calls `http://team-ai/v1`; the Worker's `team-ai` outbound handler (`api/teamai.ts`) adds the key and forwards only the model list and chat completions. So the container never sees the key, nobody edits secrets when a different teammate runs the bridge, and several teammates can run it at once.

- **Wiring:** with `TEAM_AI_URL` and `TEAM_AI_KEY` set, the container gets `AI_FALLBACK=ollama` and `OLLAMA_MODEL=qwen3.8:27b` (or `TEAM_AI_MODEL`). The chat and Find a place try `AI_PROVIDER` first (Gloo, skipped while it has no key), then the bridge. Calendar summaries use the first configured provider.
- **Timeouts:** one model call waits up to 90 seconds (`OLLAMA_TIMEOUT`, capped at 95 because Cloudflare ends a proxied request after about 100).
- **When the bridge is down:** the chat answers with the demo replies (`"offline": true` in the response), Find a place returns its "try again, or browse Ministries" message, and the calendar shows "AI Endpoint: Offline" (its summarize routes return 503). Nothing errors.
- **Status:** `GET /api/ai/status` reports `provider`, `connected` (reachable right now, cached for 15 seconds), `default_model`, `team_bridge`, and the chat's provider chain.

Turning it on (once):

1. A Cloudflare Tunnel named `belong-team-ai` with the public hostname `team-ai.jaronwilson.dev` pointing at `http://127.0.0.1:8787`.
2. In `api/`: `npx wrangler secret put TEAM_AI_URL` (value `https://team-ai.jaronwilson.dev`) and `cat ~/.secrets/gloo-team-ai-key.txt | npx wrangler secret put TEAM_AI_KEY`, then deploy `api/`.
3. Send teammates the team key and the tunnel token privately (password manager or in person).

**Switching to Gloo on Oct 7:** `npx wrangler secret put GLOO_API_KEY` in `api/`. Gloo then comes first for the chat, Find a place and calendar summaries, and the bridge stays as a backup whenever someone runs it. To retire the bridge, `npx wrangler secret delete TEAM_AI_KEY` and `TEAM_AI_URL`, then delete the tunnel.

**Policy:** the bridge exposes the club's HPC model behind a key, for the hackathon only. Confirm with Ben before relying on it.
