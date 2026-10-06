"""One-sentence summaries for live headlines, written by an LLM.

Providers follow the same settings as the chat agent (AI_PROVIDER, AI_FALLBACK,
OLLAMA_BASE_URL, GLOO_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY; see config.py); all
speak the OpenAI chat-completions format. If no provider answers, each summary stays
as the article's own description so the map still works.
"""

import json
import logging
import os
import re

from .config import settings

log = logging.getLogger(__name__)

PROVIDERS = {
    "ollama": {"base_url": "http://localhost:11434/v1", "key": "OLLAMA_API_KEY",
               "model": ("OLLAMA_MODEL", "qwen3.8:27b"), "extra_body": {}},
    "gloo": {"base_url": "https://platform.ai.gloo.com/ai/v2/guarded", "key": "GLOO_API_KEY",
             "model": ("GLOO_MODEL", "gloo-anthropic-claude-haiku-4.5"), "extra_body": {"auto_routing": False}},
    "openai": {"base_url": "https://api.openai.com/v1", "key": "OPENAI_API_KEY",
               "model": ("OPENAI_MODEL", "gpt-5-mini"), "extra_body": {}},
    "anthropic": {"base_url": "https://api.anthropic.com/v1/", "key": "ANTHROPIC_API_KEY",
                  "model": ("ANTHROPIC_MODEL", "claude-haiku-4-5"), "extra_body": {}},
}

PROMPT = """You write short context lines for a prayer map used by a church. You are given numbered news stories from {country}, each a headline and a snippet.
For each story write ONE neutral sentence (under 35 words) saying what happened. Mention who is affected only if the text says so.
Use ONLY what the headline and snippet say. Do not add names, numbers, causes or details they do not state. Do not editorialize.
Reply with only a JSON array of {n} strings, in the same order."""


def _chain():
    chain = []
    for name in (settings.ai_provider, settings.ai_fallback):
        spec = PROVIDERS.get(name)
        key = os.environ.get(spec["key"], "").strip() if spec else ""
        if name == "ollama":
            key = key or "ollama"  # the SDK requires a value; a local Ollama server ignores it
        if key and name not in [c[0] for c in chain]:
            chain.append((name, os.environ.get(*spec["model"]), spec["extra_body"], key))
    return chain


def _base_url(name):
    if name == "ollama":
        return settings.ollama_base_url
    return PROVIDERS[name]["base_url"]


def _strip_thinking(text):
    """Drop <think>...</think> reasoning blocks that some local models emit."""
    text = re.sub(r"<think>[\s\S]*?</think>", "", text)
    return re.sub(r"<think>[\s\S]*", "", text).strip()


def _fallback(item):
    """Without an LLM, keep the article's own description (already in item['summary'])."""
    return item["summary"] or f"{item['headline']} (via {item['source']})"


def _ask(clients, country, stories):
    headlines = stories
    numbered = "\n".join(f"{i + 1}. {h}" for i, h in enumerate(headlines))
    messages = [{"role": "system", "content": PROMPT.format(country=country, n=len(headlines))},
                {"role": "user", "content": numbered}]
    for name, model, extra_body, client in clients:
        try:
            text = client.chat.completions.create(
                model=model, messages=messages, extra_body=extra_body).choices[0].message.content or ""
            text = _strip_thinking(text)
            start, end = text.find("["), text.rfind("]")
            summaries = json.loads(text[start:end + 1])
            if len(summaries) == len(headlines) and all(isinstance(s, str) and s.strip() for s in summaries):
                return [s.strip() for s in summaries]
            log.warning("%s returned %d summaries for %d headlines", name, len(summaries), len(headlines))
        except Exception as err:
            log.warning("summary call via %s failed: %r", name, err)
    return None


def add_summaries(items):
    """Fill item['summary'] in place; returns the provider names that were available."""
    chain = _chain()
    clients = []
    if chain:
        try:
            from openai import OpenAI
            clients = [(name, model, extra, OpenAI(api_key=key, base_url=_base_url(name),
                                                   timeout=180, max_retries=0))
                       for name, model, extra, key in chain]
        except ImportError:
            log.warning("openai package not installed; using fallback summaries")
    by_country = {}
    for item in items:
        by_country.setdefault(item["country"], []).append(item)
    for country, group in by_country.items():
        summaries = _ask(clients, country, [f"{i['headline']} -- {i['summary']}" for i in group]) if clients else None
        for i, item in enumerate(group):
            item["summary"] = summaries[i] if summaries else _fallback(item)
    return [name for name, *_ in chain]
