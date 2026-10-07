"""Sliding-window rate limits for public forms, kept in memory.

The church API runs one container instance (api/index.ts), so in-memory counts cover every visitor.
A restart forgets them, which only ever lets a few more requests through.
"""

import threading
import time
from collections import defaultdict, deque


class RateLimit:
    """At most `limit` hits per key within `window` seconds."""

    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key, now=None):
        """Record a hit for key and say whether it is within the limit. Refused hits are not recorded."""
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def clear(self):
        with self._lock:
            self._hits.clear()


def client_ip(request):
    """The visitor's address. Behind Cloudflare it is CF-Connecting-IP, which Cloudflare sets and visitors cannot;
    locally (docker compose) it is the direct peer."""
    return request.headers.get('cf-connecting-ip') or (request.client.host if request.client else 'unknown')
