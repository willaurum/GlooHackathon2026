"""NLP categorization and LLM bullet-point summarization for church blog posts."""

import json
import logging
import re
from typing import List, Optional

from . import ai_client

logger = logging.getLogger(__name__)

# Heuristic NLP keyword dictionary for fallback classification
NLP_KEYWORD_RULES = [
    ("Local Outreach", ["outreach", "serve", "neighborhood", "city", "food", "hampers", "drive", "needs", "volunteer", "helping", "service"]),
    ("Faith & Discipleship", ["faith", "discipleship", "jesus", "christ", "gospel", "god", "scripture", "bible", "grace", "salvation"]),
    ("Community", ["community", "small group", "fellowship", "gather", "family", "relationships", "together", "connection", "members"]),
    ("Spiritual Growth", ["spiritual", "growth", "prayer", "meditation", "devotion", "season", "trust", "gratitude", "peace", "joy"]),
    ("Prayer & Worship", ["prayer", "worship", "praise", "sing", "acoustic", "choir", "music", "intercession"]),
    ("Family & Youth", ["family", "parent", "kids", "children", "youth", "students", "teens", "camp", "babies", "infants"]),
    ("Pastoral Reflections", ["pastor", "reflection", "leadership", "vision", "shepherd", "counsel", "encouragement", "message"]),
    ("Compassion Ministry", ["compassion", "grief", "care", "comfort", "healing", "hospital", "loss", "lonely", "struggling"]),
]


MAX_CATEGORY_CHARS = 40


def _heuristic_nlp_categories(text: str, max_categories: int = 3) -> List[str]:
    """Fallback NLP rule-based classifier based on keyword frequency."""
    text_lower = text.lower()
    scores = []
    for category, keywords in NLP_KEYWORD_RULES:
        score = sum(1 for kw in keywords if re.search(r'\b' + re.escape(kw) + r'\b', text_lower))
        if score > 0:
            scores.append((score, category))
    scores.sort(key=lambda x: x[0], reverse=True)
    categories = [cat for _, cat in scores[:max_categories]]
    if not categories:
        categories = ["Community", "Faith & Discipleship"]
    return categories


def _category_list(raw: str) -> List[str]:
    """Up to 4 categories from the first JSON array of short strings in a model reply. The reply may carry
    reasoning, a code fence or a sentence around the array (which can contain brackets of its own)."""
    text = re.sub(r"<think>[\s\S]*?(?:</think>|$)", "", raw or "", flags=re.IGNORECASE)
    decoder = json.JSONDecoder()
    start = text.find("[")
    while start >= 0:
        try:
            value, _ = decoder.raw_decode(text, start)
        except ValueError:
            value = None
        if isinstance(value, list) and value and all(isinstance(c, str) for c in value):
            cats = [c.strip().strip("'\"") for c in value if c.strip()]
            cats = list(dict.fromkeys(c for c in cats if 0 < len(c) <= MAX_CATEGORY_CHARS))
            if cats:
                return cats[:4]
        start = text.find("[", start + 1)
    return []


async def categorize_blog_post(title: str, content: str, model: Optional[str] = None) -> List[str]:
    """Categorize a blog post with the configured model (Gloo on Cloudflare). The keyword rules are the
    fallback when no model answers or the reply has no usable list, so a post always gets categories."""
    system_prompt = (
        "You are an NLP text classification system for a church community blog. "
        "Analyze the given blog title and content, and determine 2 to 4 concise, relevant topic categories "
        "(such as: 'Faith & Discipleship', 'Community', 'Local Outreach', 'Spiritual Growth', 'Prayer & Worship', "
        "'Family & Youth', 'Pastoral Reflections', 'Compassion Ministry', 'Volunteering'). "
        "Output ONLY a valid JSON array of category strings, without markdown fences or additional commentary. "
        "Example: [\"Faith & Discipleship\", \"Community\"]"
    )
    user_prompt = f"Blog Title: {title}\n\nContent:\n{content[:2500]}\n\nJSON Categories:"

    try:
        raw = await ai_client.generate_text(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            model=model,
            temperature=0.3,
            # Gloo's default model reasons before it answers, and the thinking counts toward this limit.
            max_tokens=1024,
        )
        categories = _category_list(raw)
        if categories:
            return categories
        logger.info("LLM categorization returned no category list; using heuristic NLP rules.")
    except Exception as exc:
        logger.info(f"LLM categorization failed ({exc}); using heuristic NLP rules.")

    # Fallback to heuristic NLP rule engine
    return _heuristic_nlp_categories(f"{title} {content}")


async def summarize_blog_bullets(title: str, content: str, model: Optional[str] = None) -> List[str]:
    """Summarize a blog post into 3 to 4 clear bullet points using the configured LLM endpoint."""
    system_prompt = (
        "You are an editor for a church blog. Summarize the following blog post into 3 to 4 clear, compelling bullet points "
        "highlighting the central message, key spiritual insights, and practical takeaways. "
        "Each bullet must start with '• '. Output ONLY the bullet points, with no conversational preamble or outro."
    )
    user_prompt = f"Title: {title}\n\nContent:\n{content}\n\nBullet Points:"

    raw = await ai_client.generate_text(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model=model,
        temperature=0.5,
        max_tokens=600,
        preserve_newlines=True,
    )

    # Parse and extract bullets (handles both newline-separated and inline bullet symbols)
    raw_text = raw.strip()
    parts = re.split(r'(?:\r?\n\s*|\s*[•]\s*)', raw_text)
    bullets = []
    for part in parts:
        cleaned = part.strip()
        if not cleaned:
            continue
        # Strip common bullet markers
        cleaned = re.sub(r"^(?:[•\-*]|\d+[\.\)])\s*", "", cleaned).strip()
        lower = cleaned.lower()
        if lower.startswith("here are") or lower.startswith("key takeaways:") or lower.startswith("summary:"):
            continue
        if len(cleaned) > 5:
            bullets.append(cleaned)

    if not bullets:
        # Fallback split on sentences if no explicit bullet markers were found
        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', raw.strip()) if s.strip()]
        bullets = sentences[:3]

    return bullets[:5]

