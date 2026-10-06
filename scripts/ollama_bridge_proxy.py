#!/usr/bin/env python3
"""
Transparent bridge proxy for Ollama.
Listens on the Docker bridge gateway IPs only (docker0 and br-* interfaces) on port 11434
and forwards all traffic to localhost (127.0.0.1:11434), allowing Docker containers
using host.docker.internal to reach an SSH-forwarded Ollama instance bound to 127.0.0.1.
"""

import socket
import threading
import time
import subprocess
import re
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ollama-bridge-proxy")

TARGET_HOST = "127.0.0.1"
TARGET_PORT = 11434
LISTEN_PORT = 11434


def forward_stream(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            src.close()
        except Exception:
            pass
        try:
            dst.close()
        except Exception:
            pass


def handle_client(client_sock, client_addr):
    try:
        target = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        target.connect((TARGET_HOST, TARGET_PORT))
    except Exception as e:
        logger.warning(f"Could not connect to {TARGET_HOST}:{TARGET_PORT} for client {client_addr}: {e}")
        client_sock.close()
        return

    t1 = threading.Thread(target=forward_stream, args=(client_sock, target), daemon=True)
    t2 = threading.Thread(target=forward_stream, args=(target, client_sock), daemon=True)
    t1.start()
    t2.start()


active_listeners = {}


def start_listener_on(ip):
    if ip in active_listeners:
        return
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((ip, LISTEN_PORT))
        s.listen(16)
        active_listeners[ip] = s
        logger.info(f"Now forwarding from {ip}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}")

        def accept_loop():
            while True:
                try:
                    client_sock, client_addr = s.accept()
                    handle_client(client_sock, client_addr)
                except Exception:
                    break

        threading.Thread(target=accept_loop, daemon=True).start()
    except Exception as e:
        logger.debug(f"Could not bind to {ip}:{LISTEN_PORT}: {e}")


def get_bridge_ips():
    """IPv4 addresses of Docker bridge interfaces only (docker0, br-<id>).

    Never 0.0.0.0 or a LAN/Tailscale address: Ollama has no auth, so it must only be
    reachable from containers on this machine.
    """
    ips = set()
    try:
        out = subprocess.check_output(["ip", "-4", "-o", "addr", "show"]).decode()
        for line in out.splitlines():
            m = re.match(r"\d+:\s+(\S+)\s+inet (\d+\.\d+\.\d+\.\d+)", line)
            if m and (m.group(1) == "docker0" or m.group(1).startswith("br-")):
                ips.add(m.group(2))
    except Exception as e:
        logger.error(f"Error getting bridge IPs: {e}")
    return ips


def main():
    logger.info("Ollama Bridge Proxy started.")
    while True:
        current_ips = get_bridge_ips()
        for ip in current_ips:
            if ip not in active_listeners:
                start_listener_on(ip)
        time.sleep(3)


if __name__ == "__main__":
    main()
