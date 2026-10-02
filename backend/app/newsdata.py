"""Live news from the NewsData.io API (free key in NEWSDATA_API_KEY).

NewsData's own `country` tag is a regional-coverage tag (wire stories carry 25+
countries), so we search headlines for the country name instead. Pins sit on the
capital with a small deterministic jitter so they don't stack. Each item's
`summary` starts as the article's description; summarize.py may rewrite it.
"""

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import zlib

log = logging.getLogger(__name__)

API = "https://newsdata.io/api/1/latest"
LIVE_ID_BASE = 1000  # synthetic seed rows use ids below this
PER_COUNTRY = 5
MIN_DESCRIPTION = 60
SKIP_TITLE = re.compile(r"epaper|lotto|horoscope|price today|shares (down|up)|stock|^\$\d|esim|\(CVE:", re.I)
# Some English-tagged items carry Albanian text; skip those descriptions.
NON_ENGLISH = re.compile(r"\b(në|të|dhe|është|për|nga)\b", re.I)

# country_code -> (name, capital city, lat, lng)
COUNTRIES = {
    "NPL": ("Nepal", "Kathmandu", 27.7172, 85.3240),
    "KEN": ("Kenya", "Nairobi", -1.2921, 36.8219),
    "PER": ("Peru", "Lima", -12.0464, -77.0428),
    "THA": ("Thailand", "Bangkok", 13.7563, 100.5018),
    "ALB": ("Albania", "Tirana", 41.3275, 19.8187),
    "MNG": ("Mongolia", "Ulaanbaatar", 47.8864, 106.9057),
}


def _clean(text):
    """Collapse whitespace and repair the replacement characters NewsData sometimes returns."""
    text = re.sub(r"(?<=\w)�(?=\w)", "'", text or "")
    text = text.replace("�", "-")
    return " ".join(text.split())


def _fetch(name, api_key):
    query = urllib.parse.urlencode({
        "apikey": api_key, "qInTitle": name, "language": "en", "size": 10,
        "excludecategory": "entertainment,sports,lifestyle,food",
    })
    try:
        with urllib.request.urlopen(f"{API}?{query}", timeout=30) as response:
            return json.loads(response.read().decode("utf-8")).get("results") or []
    except urllib.error.HTTPError as err:
        log.warning("NewsData %s returned HTTP %s", name, err.code)
    except (urllib.error.URLError, TimeoutError, ValueError) as err:
        log.warning("NewsData %s failed: %r", name, err)
    return []


def _item(code, article, title, description):
    name, city, lat, lng = COUNTRIES[code]
    h = zlib.crc32(article["link"].encode("utf-8"))
    return {
        "id": LIVE_ID_BASE + h % 1_000_000_000,
        "country": name,
        "country_code": code,
        "city": city,
        "lat": round(lat + ((h & 0xFFFF) / 0xFFFF - 0.5) * 0.3, 4),
        "lng": round(lng + (((h >> 16) & 0xFFFF) / 0xFFFF - 0.5) * 0.3, 4),
        "headline": title,
        "source": article.get("source_name") or article.get("source_id") or "unknown",
        "date": (article.get("pubDate") or "")[:10],
        "summary": description[:400],
    }


def fetch_news(api_key=None):
    """Up to PER_COUNTRY recent English stories per region country; none for a country that fails."""
    api_key = api_key or os.environ.get("NEWSDATA_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("NEWSDATA_API_KEY is not set")
    items = []
    for code, (name, *_rest) in COUNTRIES.items():
        picked, seen = [], set()
        for article in _fetch(name, api_key):
            title = _clean(article.get("title"))
            description = _clean(article.get("description"))
            key = re.sub(r"\W+", " ", title.lower()).strip()
            if (not title or not article.get("link") or key in seen or SKIP_TITLE.search(title)
                    or len(description) < MIN_DESCRIPTION or description.lower().startswith(title.lower()[:60])
                    or NON_ENGLISH.search(description) or name.lower() not in title.lower()):
                continue
            seen.add(key)
            picked.append(_item(code, article, title, description))
            if len(picked) == PER_COUNTRY:
                break
        log.info("%s: %d articles", name, len(picked))
        items.extend(picked)
    return items
