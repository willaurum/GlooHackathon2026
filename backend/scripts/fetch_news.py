"""Pre-fetch real news for the Prayer Map and save a snapshot the app loads on startup.

Run from the backend directory (about 10 seconds; needs NEWSDATA_API_KEY in the
environment or the repo's .env):

    python -m scripts.fetch_news

Summaries are written by the team's Ollama server (SSH tunnel on localhost:11434; set
OLLAMA_BASE_URL / OLLAMA_MODEL to change it). With the tunnel down, or with AI_PROVIDER
pointed at another provider that has no key, each summary is the article's own description.
Then restart the backend so the new snapshot is loaded.
"""

import datetime
import json
import logging
import os
from pathlib import Path

from app import newsdata, summarize

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parents[1] / "app" / "news_live.json"


def load_dotenv():
    """Read KEY=VALUE lines from the repo's .env without overriding real environment variables."""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.lstrip().startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


MAX_AGE_DAYS = 14


def keep_recent(items):
    """NewsData's feed is thin some days. Top each country back up from the previous snapshot
    (stories under MAX_AGE_DAYS old) so a quiet fetch doesn't leave a country nearly empty."""
    if not OUT.exists():
        return items
    cutoff = (datetime.date.today() - datetime.timedelta(days=MAX_AGE_DAYS)).isoformat()
    have = {i["id"] for i in items}
    titles = {i["headline"].lower() for i in items}
    for old in json.loads(OUT.read_text(encoding="utf-8")):
        count = sum(1 for i in items if i["country_code"] == old["country_code"])
        if (count < newsdata.PER_COUNTRY and old["id"] not in have and old["headline"].lower() not in titles
                and old["date"] >= cutoff
                and not newsdata.SKIP_TITLE.search(old["headline"])):
            items.append(old)
            have.add(old["id"])
            titles.add(old["headline"].lower())
    return items


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    load_dotenv()
    items = newsdata.fetch_news()
    print("summaries by:", summarize.add_summaries(items) or "article descriptions (no AI provider)")
    items = keep_recent(items)
    if not items:
        raise SystemExit("NewsData returned nothing; leaving the existing snapshot untouched.")
    OUT.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(items)} articles to {OUT}")


if __name__ == "__main__":
    main()
