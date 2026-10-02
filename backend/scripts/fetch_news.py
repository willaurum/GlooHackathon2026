"""Pre-fetch real news for the Prayer Map and save a snapshot the app loads on startup.

Run from the backend directory (about 10 seconds; needs NEWSDATA_API_KEY in the
environment or the repo's .env):

    python -m scripts.fetch_news

Set GLOO_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) to get LLM-written summaries;
without a key, each summary is the article's own description.
Then restart the backend so the new snapshot is loaded.
"""

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


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    load_dotenv()
    items = newsdata.fetch_news()
    if not items:
        raise SystemExit("NewsData returned nothing; leaving the existing snapshot untouched.")
    print("summaries by:", summarize.add_summaries(items) or "article descriptions (no AI key)")
    OUT.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(items)} articles to {OUT}")


if __name__ == "__main__":
    main()
