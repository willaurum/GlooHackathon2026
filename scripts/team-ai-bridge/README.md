# Team AI bridge

**Team only, for the hackathon.** Until the Gloo AI key arrives (Oct 7), this lets the deployed
Tekton site use our club's HPC model (`qwen3.8:27b`) for the chat, Find a place and calendar
summaries. When nobody runs it, the site still works: the chat gives demo replies, Find a place
says to try again or browse Ministries, and the calendar shows "AI Endpoint: Offline".

> Policy: this exposes the club's HPC model behind a key, for the hackathon only. Ben has the
> final say on HPC use; check with him before relying on it for anything beyond the demo.

## What you need

- The **Liberty student VPN**, connected.
- **Python 3** (Windows: `winget install -e --id Python.Python.3.12`; Mac: `brew install python`).
- Your Liberty HPC username and password.
- Two secrets from Jaron, sent privately: the **team AI key** and the **team tunnel token**.

`cloudflared` (the Cloudflare Tunnel program) is downloaded automatically the first time if you
do not have it.

## One-time setup

1. Run the start command below once. It creates `scripts/team-ai-bridge/bridge.config` and stops.
2. Open `bridge.config` and fill in `HPC_USERNAME`, `TEAM_AI_KEY` and `TUNNEL_TOKEN`.
   This file stays on your computer (the repo ignores it). Never commit it or paste it anywhere.

## Every time

Connect the VPN, then from the repo folder:

**Windows (PowerShell)**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\team-ai-bridge\start-bridge.ps1
```

**Mac or Linux**

```bash
scripts/team-ai-bridge/start-bridge.sh
```

Type your HPC password if `ssh` asks for it. When you see

```
AI bridge is ON for the team.
```

the site is using the HPC model. Leave the window open. Press **Ctrl+C** to turn it off.

If you already keep the SSH tunnel open yourself (main README, "HPC Ollama for local
development"), leave `HPC_USERNAME` empty and the bridge uses your tunnel.

## Is it working?

Open `https://gloo-hackathon2026-api-pastor-notes.jaronwilson2025.workers.dev/api/ai/status`.
`"connected": true` with `"provider": "ollama"` means the site reaches the HPC model through a
bridge. The calendar page also shows "AI Endpoint: Connected".

## Good to know

- **More than one teammate can run it at once.** Everyone connects to the same team tunnel and
  Cloudflare spreads requests between them. If your VPN drops, your bridge pauses itself so the
  others carry the traffic, and it comes back when the model answers again.
- **Nothing you type is logged.** The window shows only the time, path, status and duration of
  each request, never prompts or replies.
- The bridge only allows the model list and chat completions for the shared model(s), needs the
  team key on every request, rejects requests over 256 KB and handles two at a time.
- A 27B model is slow. A chat answer can take 10 to 60 seconds; the site waits up to 90.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `The SSH tunnel closed` | Connect the VPN; check your HPC username and password. |
| `Port 8787 is busy` | The bridge is already running in another window. Do not change `GATEKEEPER_PORT` unless Jaron changes the tunnel too. |
| `cloudflared rejected the tunnel token` | Copy `TUNNEL_TOKEN` again from Jaron, all on one line. |
| `none of qwen3.8:27b is on the server` | The HPC model name changed; tell Jaron. |
| `Bridge PAUSED` | The HPC model stopped answering (VPN or SSH dropped). It resumes by itself. |

`bin/cloudflared.log` has the tunnel details if something else goes wrong.
