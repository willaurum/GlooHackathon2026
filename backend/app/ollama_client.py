"""Backward-compatible proxy module pointing to ai_client."""

from .ai_client import (
    get_base_url,
    get_api_key,
    get_default_model,
    set_default_model,
    get_status,
    find_matching_model,
    clean_summary,
    summarize_event,
)

# Backward compatibility alias
OLLAMA_BASE_URL = get_base_url
OLLAMA_MODEL = get_default_model
