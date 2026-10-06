#!/usr/bin/env python3
"""Team AI bridge: lets the deployed belong. backend use the club's HPC model (qwen3.8:27b).

TEAM ONLY, hackathon stopgap until the Gloo AI key arrives. Run it with start-bridge.sh (macOS,
Linux) or start-bridge.ps1 (Windows); see README.md in this folder.

What it does:
  1. Makes sure the HPC Ollama answers on 127.0.0.1:11434 (starts the SSH tunnel if needed;
     the Liberty VPN must be connected).
  2. Runs a gatekeeper on 127.0.0.1 that requires the team key, allows only the model list and
     OpenAI-compatible chat paths and the allowed models, limits request size, and never logs prompts.
  3. Connects the gatekeeper to the team's Cloudflare Tunnel, so the backend reaches it at a fixed
     hostname no matter which teammate runs this. Several teammates may run it at once.

Python 3.9+ standard library only.
"""

import argparse
import hmac
import http.client
import json
import os
import platform
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_FILE = HERE / "bridge.config"
BIN_DIR = HERE / "bin"

SSH_HOST = "totoro.university.liberty.edu"
OLLAMA_REMOTE = "arrietty.hpc.lan:11434"
MAX_BODY_BYTES = 256 * 1024
MAX_TOKENS_CAP = 8192
MAX_IN_FLIGHT = 2
UPSTREAM_TIMEOUT = 300
CHECK_EVERY = 10

DEFAULTS = {
    "HPC_USERNAME": "",
    "TEAM_AI_KEY": "",
    "TUNNEL_TOKEN": "",
    "MODELS": "qwen3.8:27b",
    "OLLAMA_PORT": "11434",
    "GATEKEEPER_PORT": "8787",
}


def say(message=""):
    print(message, flush=True)


def load_config(path=CONFIG_FILE):
    """KEY=VALUE lines; environment variables of the same name win (handy for testing)."""
    config = dict(DEFAULTS)
    if path.exists():
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            config[key.strip().upper()] = value.strip().strip('"').strip("'")
    for key in DEFAULTS:
        if os.environ.get(key):
            config[key] = os.environ[key]
    config["MODELS"] = [m.strip() for m in config["MODELS"].split(",") if m.strip()]
    config["OLLAMA_PORT"] = int(config["OLLAMA_PORT"])
    config["GATEKEEPER_PORT"] = int(config["GATEKEEPER_PORT"])
    return config


# ---------------------------------------------------------------- gatekeeper

def make_handler(team_key, models, ollama_port):
    """Request handler bound to the team key, the allowed models and the local Ollama port."""
    slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)
    routes = {("GET", "/v1/models"), ("GET", "/api/tags"), ("POST", "/v1/chat/completions")}

    class Gatekeeper(BaseHTTPRequestHandler):
        server_version = "team-ai-bridge"
        sys_version = ""

        def log_message(self, fmt, *args):
            # The default log line is replaced by log_line, which never includes bodies.
            pass

        def log_line(self, status, started):
            say(f"  {time.strftime('%H:%M:%S')} {self.command} {self.path.split('?')[0]} -> {status} "
                f"({time.time() - started:.1f}s)")

        def reply(self, status, payload, started):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.log_line(status, started)

        def error(self, status, message, started):
            self.reply(status, {"error": {"message": message}}, started)

        def authorized(self):
            given = self.headers.get("Authorization", "")
            expected = "Bearer " + team_key
            return hmac.compare_digest(given.encode(), expected.encode())

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def do_PUT(self):
            self.handle_request()

        def do_DELETE(self):
            self.handle_request()

        def handle_request(self):
            started = time.time()
            path = self.path.split("?")[0]
            if not self.authorized():
                return self.error(401, "Missing or wrong team AI key.", started)
            if (self.command, path) not in routes:
                return self.error(404, "Not found", started)
            body = None
            if self.command == "POST":
                try:
                    length = int(self.headers.get("Content-Length", ""))
                except ValueError:
                    return self.error(411, "Content-Length required", started)
                if length > MAX_BODY_BYTES:
                    return self.error(413, "Request too large", started)
                try:
                    data = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    return self.error(400, "Body must be JSON", started)
                if not isinstance(data, dict) or data.get("model") not in models:
                    return self.error(403, "That model is not shared through the team bridge.", started)
                for field in ("max_tokens", "max_completion_tokens"):
                    if isinstance(data.get(field), int) and data[field] > MAX_TOKENS_CAP:
                        data[field] = MAX_TOKENS_CAP
                body = json.dumps(data).encode()
            if not slots.acquire(timeout=60):
                return self.error(429, "The team model is busy. Try again in a moment.", started)
            try:
                self.forward(path, body, started)
            finally:
                slots.release()

        def forward(self, path, body, started):
            upstream = http.client.HTTPConnection("127.0.0.1", ollama_port, timeout=UPSTREAM_TIMEOUT)
            try:
                headers = {"Content-Type": "application/json"} if body is not None else {}
                upstream.request(self.command, path, body=body, headers=headers)
                response = upstream.getresponse()
                if path in ("/v1/models", "/api/tags") and response.status == 200:
                    listing = json.loads(response.read() or b"{}")
                    if path == "/v1/models":
                        listing["data"] = [m for m in listing.get("data", []) if m.get("id") in models]
                    else:
                        listing["models"] = [m for m in listing.get("models", []) if m.get("name") in models]
                    return self.reply(200, listing, started)
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
                length = response.getheader("Content-Length")
                if length:
                    self.send_header("Content-Length", length)
                else:
                    self.send_header("Connection", "close")
                    self.close_connection = True
                self.end_headers()
                while True:
                    chunk = response.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                self.log_line(response.status, started)
            except (OSError, http.client.HTTPException, ValueError):
                try:
                    self.error(503, "The HPC model is not reachable from the bridge right now.", started)
                except OSError:
                    pass
            finally:
                upstream.close()

    return Gatekeeper


def start_gatekeeper(config):
    handler = make_handler(config["TEAM_AI_KEY"], config["MODELS"], config["OLLAMA_PORT"])
    server = ThreadingHTTPServer(("127.0.0.1", config["GATEKEEPER_PORT"]), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ---------------------------------------------------------------- HPC model and SSH tunnel

def ollama_models(port, timeout=4):
    """Model names the local Ollama lists, or None if it does not answer."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", "/api/tags")
        response = conn.getresponse()
        if response.status != 200:
            return None
        return [m.get("name") for m in json.loads(response.read()).get("models", [])]
    except (OSError, http.client.HTTPException, ValueError):
        return None
    finally:
        conn.close()


def port_in_use(port):
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def open_hpc_tunnel(config):
    """Start the SSH port forward to the HPC Ollama; returns the process, or None on failure."""
    port = config["OLLAMA_PORT"]
    if not config["HPC_USERNAME"]:
        say(f"The HPC model is not answering on 127.0.0.1:{port} and HPC_USERNAME is empty in bridge.config.")
        say("Either fill in HPC_USERNAME, or open the SSH tunnel yourself (see the main README).")
        return None
    client = shutil.which("ssh")
    if not client:
        say("The ssh program was not found. On Windows: Settings > System > Optional features > OpenSSH Client.")
        return None
    user = config["HPC_USERNAME"]
    say(f"Opening the SSH tunnel to the HPC as {user} (type your HPC password if asked)...")
    forward = f"127.0.0.1:{port}:{OLLAMA_REMOTE}"
    argv = [client, "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
            "-o", "ConnectTimeout=20", "-L", forward, user + "@" + SSH_HOST]
    process = subprocess.Popen(argv)
    for _ in range(180):
        if process.poll() is not None:
            say("The SSH tunnel closed. Is the Liberty student VPN connected, and are the username and password right?")
            return None
        if ollama_models(port, timeout=2) is not None:
            return process
        time.sleep(1)
    say("The SSH tunnel did not come up in 3 minutes.")
    stop(process)
    return None


# ---------------------------------------------------------------- cloudflared

def cloudflared_download():
    system, machine = platform.system(), platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
    base = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
    if system == "Windows":
        return base + f"cloudflared-windows-{arch}.exe", BIN_DIR / "cloudflared.exe"
    if system == "Darwin":
        return base + f"cloudflared-darwin-{arch}.tgz", BIN_DIR / "cloudflared"
    return base + f"cloudflared-linux-{arch}", BIN_DIR / "cloudflared"


def find_cloudflared():
    found = shutil.which("cloudflared")
    if found:
        return found
    url, target = cloudflared_download()
    if target.exists():
        return str(target)
    say(f"Downloading cloudflared (one time) from {url} ...")
    BIN_DIR.mkdir(exist_ok=True)
    try:
        if url.endswith(".tgz"):
            archive = BIN_DIR / "cloudflared.tgz"
            urllib.request.urlretrieve(url, archive)
            with tarfile.open(archive) as tgz:
                member = next(m for m in tgz.getmembers() if m.name.endswith("cloudflared"))
                member.name = "cloudflared"
                tgz.extract(member, BIN_DIR)
            archive.unlink()
        else:
            urllib.request.urlretrieve(url, target)
        target.chmod(target.stat().st_mode | stat.S_IEXEC)
    except Exception as err:
        say(f"Could not download cloudflared ({err}). Install it from "
            "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")
        return None
    return str(target)


class Connector:
    """One cloudflared connector for the team's named tunnel, pointed at the gatekeeper."""

    def __init__(self, binary, token, port):
        self.binary, self.token, self.port = binary, token, port
        self.process = None
        self.connected = threading.Event()

    def start(self):
        self.connected.clear()
        # The token goes in the environment, not on the command line where other users could see it.
        env = dict(os.environ, TUNNEL_TOKEN=self.token)
        # An empty config file, so ingress rules in a personal ~/.cloudflared/config.yml cannot take over.
        BIN_DIR.mkdir(exist_ok=True)
        empty_config = BIN_DIR / "cloudflared-empty.yml"
        empty_config.write_text("# Written by bridge.py\nno-autoupdate: true\n", encoding="utf-8")
        argv = [self.binary, "tunnel", "--no-autoupdate", "--config", str(empty_config),
                "--url", f"http://127.0.0.1:{self.port}", "run"]
        self.process = subprocess.Popen(argv, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                        text=True, errors="replace")
        threading.Thread(target=self.watch, args=(self.process,), daemon=True).start()

    def watch(self, process):
        BIN_DIR.mkdir(exist_ok=True)
        warned = False
        with open(BIN_DIR / "cloudflared.log", "w", encoding="utf-8") as out:
            for line in process.stderr:
                out.write(line)
                out.flush()
                if "Registered tunnel connection" in line:
                    self.connected.set()
                elif "Unauthorized" in line and not warned:
                    warned = True
                    say("  cloudflared rejected the tunnel token. Check TUNNEL_TOKEN in bridge.config.")

    def running(self):
        return self.process is not None and self.process.poll() is None

    def stop(self):
        stop(self.process)
        self.process = None
        self.connected.clear()


def stop(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


# ---------------------------------------------------------------- main

BANNER = """
==============================================================
  AI bridge is ON for the team.
  belong. chat, Find a place and calendar summaries can now use
  the HPC model ({models}).
  Keep this window open. Press Ctrl+C to turn it off.
==============================================================
"""
LOCAL_BANNER = "\nLocal-only mode: the gatekeeper is up but nothing is exposed to the internet. Ctrl+C to stop.\n"


def check_setup(config, local_only):
    """A message explaining what to fix, or None when the config is usable."""
    if len(config["TEAM_AI_KEY"]) < 32:
        return "TEAM_AI_KEY in bridge.config is missing or too short. Ask Jaron for the team key."
    if not local_only and not config["TUNNEL_TOKEN"]:
        return "TUNNEL_TOKEN in bridge.config is empty. Ask Jaron for the team tunnel token."
    if port_in_use(config["GATEKEEPER_PORT"]):
        return (f"Port {config['GATEKEEPER_PORT']} is busy. Is the bridge already running? "
                "Otherwise set GATEKEEPER_PORT in bridge.config.")
    return None


def main():
    parser = argparse.ArgumentParser(description="Team AI bridge (see README.md)")
    parser.add_argument("--local-only", action="store_true",
                        help="run the gatekeeper without the Cloudflare tunnel (for testing)")
    args = parser.parse_args()

    if not CONFIG_FILE.exists() and not os.environ.get("TEAM_AI_KEY"):
        say(f"First time: copy bridge.config.example to bridge.config in {HERE} and fill it in.")
        return 2
    config = load_config()
    problem = check_setup(config, args.local_only)
    if problem:
        say(problem)
        return 2

    hpc_tunnel = None
    available = ollama_models(config["OLLAMA_PORT"])
    if available is None:
        hpc_tunnel = open_hpc_tunnel(config)
        if hpc_tunnel is None:
            return 1
        available = ollama_models(config["OLLAMA_PORT"]) or []
    say(f"HPC model server is answering on 127.0.0.1:{config['OLLAMA_PORT']}.")
    if not any(m in available for m in config["MODELS"]):
        say(f"Warning: none of {', '.join(config['MODELS'])} is on the server. "
            f"It has: {', '.join(available) or 'nothing'}.")

    server = start_gatekeeper(config)
    say(f"Gatekeeper is listening on 127.0.0.1:{config['GATEKEEPER_PORT']} (team key required).")

    connector = None
    if not args.local_only:
        binary = find_cloudflared()
        connector = Connector(binary, config["TUNNEL_TOKEN"], config["GATEKEEPER_PORT"]) if binary else None
        if connector:
            connector.start()
        if not connector or not connector.connected.wait(45):
            if connector:
                say("cloudflared did not connect within 45 seconds. Details: " + str(BIN_DIR / "cloudflared.log"))
                connector.stop()
            server.shutdown()
            stop(hpc_tunnel)
            return 1
    say(BANNER.format(models=", ".join(config["MODELS"])) if connector else LOCAL_BANNER)
    return supervise(config, server, connector, hpc_tunnel)


def supervise(config, server, connector, hpc_tunnel):
    """Watch the HPC model until Ctrl+C. While it is down, step off the team tunnel so another
    teammate's bridge (if any) takes the traffic; come back when it answers again."""
    stopping = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    misses = 0
    try:
        while not stopping.wait(CHECK_EVERY):
            if hpc_tunnel is not None and hpc_tunnel.poll() is not None:
                say("The SSH tunnel dropped; reopening it...")
                hpc_tunnel = open_hpc_tunnel(config)
            healthy = ollama_models(config["OLLAMA_PORT"]) is not None
            misses = 0 if healthy else misses + 1
            if connector is None:
                continue
            if misses >= 2 and connector.running():
                say("The HPC model stopped answering (VPN or tunnel down?). Bridge PAUSED; it resumes when the model is back.")
                connector.stop()
            elif healthy and not connector.running():
                say("Reconnecting to the team tunnel...")
                connector.start()
                if connector.connected.wait(45):
                    say("AI bridge is ON for the team again.")
    finally:
        say("\nTurning the AI bridge off...")
        if connector:
            connector.stop()
        server.shutdown()
        stop(hpc_tunnel)
        say("AI bridge is OFF. The site falls back to demo replies (or to another teammate's bridge).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
