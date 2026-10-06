"""Client for communicating with any OpenAPI / OpenAI compatible or Ollama AI service."""

import os
import re
import time
import logging
import httpx

logger = logging.getLogger(__name__)

# Active model override in memory, if changed via API
_active_model: str | None = None
_status_cache: dict | None = None
_status_cache_time: float = 0.0


# Hosted providers are taken as reachable when their key is set; there is nothing local to probe.
HOSTED_PROVIDERS = ("gloo", "openai", "anthropic")


def endpoint() -> dict:
    """Where summaries go: {provider, base_url, api_key, model, extra_body}.

    AI_BASE_URL (or OPENAI_BASE_URL) wins, for local setups. Otherwise the chat's first configured
    provider: the team AI bridge today, Gloo as soon as GLOO_API_KEY is set. Otherwise a local Ollama.
    """
    explicit = os.environ.get("AI_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
    if not explicit:
        from . import chat

        chain = chat.provider_chain()
        if chain:
            name, model, extra_body, key = chain[0]
            base = chat.ollama_base_url() if name == "ollama" else chat.PROVIDERS[name]["base_url"]
            return {"provider": name, "base_url": base.rstrip("/"), "api_key": "" if key == "ollama" else key,
                    "model": model, "extra_body": extra_body}
    return {
        "provider": "custom" if explicit else "local",
        "base_url": (explicit or os.environ.get("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip("/"),
        "api_key": os.environ.get("AI_API_KEY") or os.environ.get("OPENAI_API_KEY") or "",
        "model": os.environ.get("AI_MODEL") or os.environ.get("OLLAMA_MODEL") or "qwen3.8:27b",
        "extra_body": {},
    }


def native_root(url_base: str) -> str:
    """Ollama native endpoints (/api/...) live beside /v1, not under it."""
    return url_base[:-3] if url_base.endswith("/v1") else url_base


def get_base_url() -> str:
    """Return the AI base URL summaries use (see endpoint())."""
    return endpoint()["base_url"]


def get_api_key() -> str:
    """Return the AI API key summaries use, if any."""
    return endpoint()["api_key"]


def get_timeout() -> float:
    """Seconds to wait for one summary; the team bridge's 27B model is slow (see chat.provider_timeout)."""
    from . import chat

    return float(chat.provider_timeout("ollama"))


def get_default_model() -> str:
    """Return the active model (runtime override, else the provider's model; default qwen3.8:27b)."""
    if _active_model:
        return _active_model
    return endpoint()["model"]


def set_default_model(model: str) -> None:
    """Set the active AI model at runtime."""
    global _active_model, _status_cache
    _active_model = model.strip()
    _status_cache = None
    logger.info(f"AI default model set to: {_active_model}")


def _get_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    api_key = get_api_key()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def find_matching_model(target_model: str, available_models: list[str]) -> str | None:
    """Find an exact or compatible installed model name from available models."""
    if not available_models:
        return None

    # 1. Exact match
    if target_model in available_models:
        return target_model

    # 2. Match with :latest suffix or target without tag
    if f"{target_model}:latest" in available_models:
        return f"{target_model}:latest"

    # 3. Match prefix / variant (e.g. qwen3.8:27b-q4_0 or qwen3.8:27b)
    target_clean = target_model.split(":")[0]
    for m in available_models:
        if m.startswith(target_model) or target_model.startswith(m):
            return m
        if ":" in m and m.split(":")[0] == target_clean:
            return m

    return None


async def get_status(base_url: str = None, force_refresh: bool = False) -> dict:
    """Check whether the AI endpoint is reachable and return available models.
    
    Supports standard OpenAPI/OpenAPI endpoints (/models, /v1/models)
    as well as Ollama native endpoints (/api/tags).
    """
    global _status_cache, _status_cache_time
    now = time.time()
    current_model = get_default_model()
    if not force_refresh and not base_url and _status_cache and (now - _status_cache_time < 15.0):
        return {**_status_cache, "default_model": current_model}

    target = endpoint()
    if not base_url and target["provider"] in HOSTED_PROVIDERS:
        return {"connected": True, "provider": target["provider"], "base_url": target["base_url"],
                "default_model": current_model, "available_models": [target["model"]]}
    result = await _probe(base_url, current_model, target)
    result["provider"] = target["provider"] if not base_url else "custom"
    if not base_url:
        # Failures are cached too, so a page polling the status does not hammer a bridge that is down.
        _status_cache = result
        _status_cache_time = now
    return result


async def _probe(base_url: str | None, current_model: str, target: dict) -> dict:
    url_base = (base_url or target["base_url"]).rstrip("/")
    headers = _get_headers()

    # 1. First attempt: Standard OpenAPI / OpenAI models endpoint
    models_url = f"{url_base}/models" if url_base.endswith("/v1") else f"{url_base}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=3.0, headers=headers) as client:
            resp = await client.get(models_url)
            if resp.status_code == 200:
                data = resp.json()
                raw_models = data.get("data", [])
                if isinstance(raw_models, list) and raw_models:
                    model_names = [m["id"] for m in raw_models if isinstance(m, dict) and "id" in m]
                    res = {
                        "connected": True,
                        "base_url": url_base,
                        "default_model": current_model,
                        "available_models": model_names,
                    }
                    return res
    except Exception as exc:
        logger.debug(f"OpenAPI /v1/models check failed on {models_url}: {exc}")

    # 2. Second attempt: Ollama native /api/tags
    ollama_tags_url = f"{native_root(url_base)}/api/tags"
    try:
        async with httpx.AsyncClient(timeout=3.0, headers=headers) as client:
            resp = await client.get(ollama_tags_url)
            if resp.status_code == 200:
                data = resp.json()
                models = [m.get("name") for m in data.get("models", [])]
                res = {
                    "connected": True,
                    "base_url": url_base,
                    "default_model": current_model,
                    "available_models": models,
                }
                return res
            return {
                "connected": False,
                "base_url": url_base,
                "default_model": current_model,
                "error": f"AI endpoint returned HTTP {resp.status_code}",
                "available_models": [],
            }
    except Exception as exc:
        return {
            "connected": False,
            "base_url": url_base,
            "default_model": current_model,
            "error": str(exc),
            "available_models": [],
        }


def clean_summary(text: str, join_delimiter: str = " ") -> str:
    """Strip reasoning/thought blocks and metadata labels from LLM output so only narrative sentences remain."""
    if not text:
        return ""
    # Remove completed thinking tags
    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    # In case <think> was unclosed (e.g. truncated before closing tag)
    if "<think>" in text:
        text = re.sub(r"<think>[\s\S]*", "", text).strip()

    lines = [line.strip() for line in text.split("\n") if line.strip()]
    cleaned_lines = []
    for line in lines:
        lower = line.lower()
        if any(
            lower.startswith(p)
            for p in [
                "title:",
                "event:",
                "category:",
                "date & time:",
                "date:",
                "time:",
                "location:",
                "when:",
                "where:",
            ]
        ):
            continue
        for prefix in [
            "details:",
            "summary:",
            "2-sentence summary:",
            "bulletin summary:",
            "event summary:",
        ]:
            if lower.startswith(prefix):
                line = line[len(prefix) :].strip()
        if line:
            cleaned_lines.append(line)
    result = join_delimiter.join(cleaned_lines).strip()
    # Strip enclosing quotation marks if returned by the LLM
    if result.startswith('"') and result.endswith('"') and len(result) > 2:
        result = result[1:-1].strip()
    return result if result else text.strip()


async def generate_text(
    system_prompt: str,
    user_prompt: str,
    model: str | None = None,
    temperature: float = 0.6,
    max_tokens: int = 800,
    client: httpx.AsyncClient | None = None,
    preserve_newlines: bool = False,
) -> str:
    """Send a prompt to the configured AI endpoint to generate completion text."""
    requested_model = model or get_default_model()
    target = endpoint()
    url_base = target["base_url"]
    headers = _get_headers()
    delim = "\n" if preserve_newlines else " "
    # Chat-provider base URLs already include the API version (Gloo's has no /v1 at all).
    from_chat = target["provider"] not in ("custom", "local")

    # Verify AI endpoint status
    status = await get_status()
    if not status.get("connected"):
        raise RuntimeError(
            f"Cannot connect to AI endpoint at {url_base}. "
            f"Please verify the AI service is running and accessible."
        )

    # Use resolved installed model or requested model
    available = status.get("available_models", [])
    resolved_model = find_matching_model(requested_model, available) or requested_model

    result_text = ""

    async def _execute_with_client(http_client: httpx.AsyncClient):
        nonlocal result_text
        # 1. Primary method: OpenAPI / OpenAI-compatible /chat/completions
        chat_url = (f"{url_base}/chat/completions" if from_chat or url_base.endswith("/v1")
                    else f"{url_base}/v1/chat/completions")
        native_fallback = not from_chat or target["provider"] == "ollama"
        try:
            chat_resp = await http_client.post(
                chat_url,
                json={
                    **target["extra_body"],
                    "model": resolved_model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
            )
            if chat_resp.status_code == 200:
                chat_data = chat_resp.json()
                choices = chat_data.get("choices", [])
                if choices:
                    msg = choices[0].get("message", {})
                    content = msg.get("content", "")
                    result_text = clean_summary(content, join_delimiter=delim)
            elif chat_resp.status_code == 404:
                logger.info(f"OpenAPI chat endpoint {chat_url} returned 404, attempting fallback endpoints...")
            else:
                native_fallback = False
                logger.info(f"AI chat endpoint returned HTTP {chat_resp.status_code}")
        except Exception as exc:
            # Not after a timeout: the native endpoints would triple the wait on a slow model.
            native_fallback = False
            logger.debug(f"OpenAPI chat completion call failed on {chat_url}: {exc}")

        # 2. Fallback: Ollama native /api/generate
        if not result_text and native_fallback:
            try:
                gen_prompt = f"{system_prompt}\n\n{user_prompt}"
                gen_resp = await http_client.post(
                    f"{native_root(url_base)}/api/generate",
                    json={
                        "model": resolved_model,
                        "prompt": gen_prompt,
                        "stream": False,
                        "options": {
                            "temperature": temperature,
                            "num_predict": max_tokens,
                        },
                    },
                )
                if gen_resp.status_code == 200:
                    data = gen_resp.json()
                    result_text = clean_summary(data.get("response", ""), join_delimiter=delim)
            except Exception as gen_err:
                logger.debug(f"/api/generate attempt failed: {gen_err}")

        # 3. Fallback: Ollama native /api/chat
        if not result_text and native_fallback:
            try:
                native_chat_resp = await http_client.post(
                    f"{native_root(url_base)}/api/chat",
                    json={
                        "model": resolved_model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        "stream": False,
                        "options": {
                            "temperature": temperature,
                            "num_predict": max_tokens,
                        },
                    },
                )
                if native_chat_resp.status_code == 200:
                    chat_data = native_chat_resp.json()
                    msg = chat_data.get("message", {})
                    result_text = clean_summary(msg.get("content", ""), join_delimiter=delim)
            except Exception as native_err:
                logger.debug(f"/api/chat attempt failed: {native_err}")

    if client:
        await _execute_with_client(client)
    else:
        async with httpx.AsyncClient(timeout=get_timeout(), headers=headers) as local_client:
            await _execute_with_client(local_client)

    if not result_text:
        raise RuntimeError(
            f"AI endpoint ({resolved_model}) returned an empty response. "
            f"Please check your AI service and model configuration."
        )

    return result_text


async def summarize_event(
    title: str,
    category: str,
    description: str,
    date: str,
    time: str,
    location: str,
    model: str = None,
    client: httpx.AsyncClient = None,
) -> str:
    """Send an event prompt to the configured AI endpoint to generate an AI summary.
    
    Compatible with any OpenAPI / OpenAI chat completions endpoint
    as well as native Ollama generate/chat endpoints.
    """
    system_prompt = (
        "You are an editor for a church newsletter. Write a warm, inviting 2-sentence bulletin summary "
        "of this church event for members and visitors. Output ONLY the summary."
    )
    user_prompt = (
        f"Church Event: {title}\n"
        f"Category: {category}\n"
        f"When & Where: {date} at {time} in {location}\n"
        f"Event Details: {description}\n\n"
        "Bulletin Summary:"
    )
    return await generate_text(system_prompt, user_prompt, model=model, client=client)

