"""Which church a request is for.

The Worker (api/index.ts) resolves the church from the URL, checks who may call the
route, and passes the church on in X-Church, X-Church-Name and X-Church-City. This
middleware puts it in db.use_church for the whole request, so every database call
the endpoint makes goes to that church. A request without X-Church (an older Worker,
or a local run) is the demo church.

New endpoints need nothing extra: anything that goes through db.py is already scoped.
"""

import re
from urllib.parse import unquote

from . import db

SLUG = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\Z')


def church_from_headers(headers):
    """(slug, name, city) from ASGI headers, or None when X-Church is malformed."""
    values = {k.decode('latin-1').lower(): v.decode('latin-1') for k, v in headers}
    slug = values.get('x-church') or db.DEMO_CHURCH
    if not SLUG.match(slug):
        return None
    return slug, unquote(values.get('x-church-name', ''))[:120], unquote(values.get('x-church-city', ''))[:120]


class ChurchScope:
    """Pure ASGI middleware, so the church reaches sync endpoints in the thread pool too."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        church = church_from_headers(scope.get('headers', []))
        if church is None:
            await send({'type': 'http.response.start', 'status': 400, 'headers': [(b'content-type', b'text/plain')]})
            return await send({'type': 'http.response.body', 'body': b'Unknown church'})
        slug, name, city = church
        with db.use_church(slug, name, city):
            await self.app(scope, receive, send)
