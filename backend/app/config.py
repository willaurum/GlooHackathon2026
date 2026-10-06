"""Centralized application configuration component.

Loads environment variables from `.env` and provides structured, reusable
configuration access for AI services, database, and third-party integrations.
"""

import os
from pathlib import Path
from typing import Optional


def load_env_file(env_path: Optional[Path] = None) -> None:
    """Load variables from a .env file into os.environ if not already present."""
    search_paths = []
    if env_path:
        search_paths.append(env_path)
    if os.environ.get("ENV_FILE"):
        search_paths.append(Path(os.environ["ENV_FILE"]))

    # Default search locations:
    # 1. Current working directory
    search_paths.append(Path.cwd() / ".env")
    # 2. Project root (two levels up from backend/app or one level up from backend)
    search_paths.append(Path(__file__).resolve().parent.parent / ".env")
    search_paths.append(Path(__file__).resolve().parent.parent.parent / ".env")

    # Try python-dotenv first if installed
    try:
        from dotenv import load_dotenv  # type: ignore

        for path in search_paths:
            if path.is_file():
                load_dotenv(dotenv_path=path, override=False)
                return
    except ImportError:
        pass

    # Built-in fallback parser if python-dotenv is not installed
    for path in search_paths:
        if path.is_file():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        key, val = line.split("=", 1)
                        key = key.strip()
                        val = val.strip().strip("'\"")
                        if key and key not in os.environ:
                            os.environ[key] = val
                return
            except OSError:
                continue


# Load .env file on module import
load_env_file()


class Settings:
    """Reusable application settings component."""

    @staticmethod
    def reload() -> None:
        """Reload configuration from .env."""
        load_env_file()

    # --- Database Settings ---
    @property
    def database_url(self) -> str:
        user = os.environ.get("POSTGRES_USER", "gloo")
        password = os.environ.get("POSTGRES_PASSWORD", "gloo")
        db_name = os.environ.get("POSTGRES_DB", "gloo")
        return os.environ.get(
            "DATABASE_URL",
            f"postgresql://{user}:{password}@db:5432/{db_name}",
        )

    # --- AI Provider Selection ---
    @property
    def ai_provider(self) -> str:
        return os.environ.get("AI_PROVIDER", "gloo").strip().lower()

    @property
    def ai_fallback(self) -> str:
        return os.environ.get("AI_FALLBACK", "").strip().lower()

    # --- AI Base URL & Model (Calendar & Generic OpenAPI/Ollama) ---
    @property
    def ai_base_url(self) -> str:
        """Return configured AI base URL (checking AI_BASE_URL, OPENAI_BASE_URL, OLLAMA_BASE_URL)."""
        url = (
            os.environ.get("AI_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("OLLAMA_BASE_URL")
            or "http://host.docker.internal:11434"
        ).rstrip("/")
        # If pointing to /v1 on Ollama, strip /v1 for native AI base URL callers
        if url.endswith("/v1"):
            url = url[:-3]
        return url

    @property
    def ai_model(self) -> str:
        """Return default AI model for summaries and general generation."""
        return (
            os.environ.get("AI_MODEL")
            or os.environ.get("OLLAMA_MODEL")
            or "qwen3.8:27b"
        )

    @property
    def ai_api_key(self) -> str:
        return os.environ.get("AI_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""

    # --- Ollama / Local AI Endpoint (OpenAI-compatible /v1 format) ---
    @property
    def ollama_base_url(self) -> str:
        """Return Ollama base URL (OpenAI-compatible /v1 endpoint)."""
        if os.environ.get("OLLAMA_BASE_URL"):
            return os.environ["OLLAMA_BASE_URL"].rstrip("/")
        base = self.ai_base_url
        return f"{base}/v1"

    @property
    def ollama_model(self) -> str:
        model = os.environ.get("OLLAMA_MODEL") or "qwen3.8:27b"
        if model in ("qwen", "qwen:"):
            return "qwen3.8:27b"
        return model

    @property
    def ollama_api_key(self) -> str:
        return os.environ.get("OLLAMA_API_KEY") or ""

    # --- Cloud AI Provider Credentials ---
    @property
    def gloo_api_key(self) -> str:
        return os.environ.get("GLOO_API_KEY") or ""

    @property
    def gloo_model(self) -> str:
        return os.environ.get("GLOO_MODEL") or "gloo-anthropic-claude-haiku-4.5"

    @property
    def openai_api_key(self) -> str:
        return os.environ.get("OPENAI_API_KEY") or ""

    @property
    def openai_model(self) -> str:
        return os.environ.get("OPENAI_MODEL") or "gpt-5-mini"

    @property
    def anthropic_api_key(self) -> str:
        return os.environ.get("ANTHROPIC_API_KEY") or ""

    @property
    def anthropic_model(self) -> str:
        return os.environ.get("ANTHROPIC_MODEL") or "claude-haiku-4-5"


settings = Settings()
