"""
LLM provider registry — loads provider config from JSON, resolves env vars, builds clients.

Providers are auto-discovered from environment variables. Set API keys to enable
cloud providers; Ollama is probed automatically if configured. Set
GRIDSIGHT_DISABLE_AI=true to force-disable all AI functionality.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import ssl

import httpx
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)


def _get_ssl_verify() -> ssl.SSLContext | bool:
    """Return an SSL context that uses the OS native trust store.

    Uses `truststore` to delegate certificate verification to the
    operating system (macOS Keychain, Windows cert store, etc.).
    This handles corporate proxy CAs and custom CA bundles that
    Python's built-in ssl module may reject due to expired intermediates.
    """
    try:
        import truststore
        ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        return ctx
    except ImportError:
        logger.debug("truststore not installed, using default SSL verification")
    return True


def _get_httpx_client(**kwargs) -> httpx.AsyncClient:
    """Create an httpx AsyncClient that respects SSL_CERT_FILE."""
    if "verify" not in kwargs:
        kwargs["verify"] = _get_ssl_verify()
    return httpx.AsyncClient(**kwargs)


# Cached state
_providers: list[dict[str, Any]] | None = None
_clients: dict[str, AsyncOpenAI] = {}
_ollama_reachable: bool | None = None


def is_ai_disabled() -> bool:
    """Check if AI is force-disabled via environment variable."""
    val = os.environ.get("GRIDSIGHT_DISABLE_AI", "").lower()
    return val in ("true", "1", "yes")


def _resolve_providers_path() -> Path:
    """Find the providers JSON file using resolution order:
    1. LLM_PROVIDERS_FILE env var
    2. {DATA_DIR}/llm_providers.json
    3. server/llm_providers.json (shipped default)
    """
    explicit = os.environ.get("LLM_PROVIDERS_FILE")
    if explicit:
        return Path(explicit)

    data_dir = os.environ.get("DATA_DIR")
    if data_dir:
        override = Path(data_dir) / "llm_providers.json"
        if override.exists():
            return override

    # Default: shipped with the server package
    return Path(__file__).resolve().parent.parent.parent / "llm_providers.json"


def load_providers(path: Path | None = None) -> list[dict[str, Any]]:
    """Load provider definitions from JSON file."""
    global _providers, _clients, _ollama_reachable
    p = path or _resolve_providers_path()
    try:
        with open(p) as f:
            data = json.load(f)
        _providers = data.get("providers", [])
        _clients.clear()
        _ollama_reachable = None
        logger.info("Loaded %d LLM providers from %s", len(_providers), p)
        return _providers
    except Exception as e:
        logger.warning("Failed to load LLM providers from %s: %s", p, e)
        _providers = []
        return []


def _get_providers() -> list[dict[str, Any]]:
    """Return cached providers, loading on first access."""
    global _providers
    if _providers is None:
        load_providers()
    return _providers  # type: ignore[return-value]


def _resolve_base_url(provider: dict[str, Any]) -> str:
    """Resolve the base URL for a provider, checking env var overrides."""
    env_var = provider.get("base_url_env")
    if env_var:
        env_val = os.environ.get(env_var)
        if env_val:
            # Ensure the URL ends with /v1 for OpenAI compatibility
            url = env_val.rstrip("/")
            if not url.endswith("/v1"):
                url += "/v1"
            return url
    return provider.get("base_url", "")


def _resolve_api_key(provider: dict[str, Any]) -> str | None:
    """Resolve the API key for a provider from env vars."""
    env_var = provider.get("api_key_env")
    if env_var:
        return os.environ.get(env_var)
    return provider.get("api_key_default")


async def probe_ollama(base_url: str) -> bool:
    """Check if an Ollama server is reachable. Caches the result."""
    global _ollama_reachable
    if _ollama_reachable is not None:
        return _ollama_reachable
    # Strip /v1 suffix for the native Ollama API probe
    probe_url = base_url
    if probe_url.endswith("/v1"):
        probe_url = probe_url[:-3]
    try:
        async with _get_httpx_client() as client:
            resp = await client.get(f"{probe_url}/api/tags", timeout=1.5)
            _ollama_reachable = resp.status_code == 200
    except Exception:
        _ollama_reachable = False
    if _ollama_reachable:
        logger.info("Ollama detected at %s", probe_url)
    else:
        logger.debug("Ollama not reachable at %s", probe_url)
    return _ollama_reachable


async def get_active_providers() -> dict[str, dict[str, Any]]:
    """Return providers that are currently enabled based on env var configuration.

    For providers with enabled_when="always" (e.g. Ollama), probes for reachability.
    Returns a dict keyed by provider id with the full provider config
    plus resolved 'resolved_base_url' and 'resolved_api_key' fields.
    """
    if is_ai_disabled():
        return {}

    active = {}
    for p in _get_providers():
        pid = p["id"]
        enabled_when = p.get("enabled_when", "api_key")
        api_key = _resolve_api_key(p)
        base_url = _resolve_base_url(p)

        if enabled_when == "api_key" and not api_key:
            continue
        if enabled_when == "base_url":
            # A custom OpenAI-compatible endpoint (e.g. a self-hosted LiteLLM
            # proxy): enabled once its base_url env var is set, with or without
            # an API key.
            env_var = p.get("base_url_env")
            if not (env_var and os.environ.get(env_var)):
                continue
        if enabled_when == "always":
            # Probe reachability for "always" providers (e.g. Ollama)
            if not await probe_ollama(base_url):
                continue
        active[pid] = {
            **p,
            "resolved_base_url": base_url,
            "resolved_api_key": api_key or "not-needed",
        }
    return active


def get_provider_client(provider_id: str) -> AsyncOpenAI:
    """Get or create a cached AsyncOpenAI client for a provider.

    Note: This uses the raw provider config (not get_active_providers)
    to avoid async in a sync context. The caller should have already
    verified the provider is active.
    """
    if provider_id in _clients:
        return _clients[provider_id]

    # Resolve config directly from provider definitions
    for p in _get_providers():
        if p["id"] == provider_id:
            base_url = _resolve_base_url(p)
            api_key = _resolve_api_key(p) or "not-needed"
            # Use a custom httpx client to respect SSL_CERT_FILE
            http_client = httpx.AsyncClient(verify=_get_ssl_verify())
            client = AsyncOpenAI(
                base_url=base_url,
                api_key=api_key,
                http_client=http_client,
            )
            _clients[provider_id] = client
            return client

    raise ValueError(f"Provider '{provider_id}' is not configured")


def get_default_provider() -> tuple[str, str] | None:
    """Return (provider_id, model_name) from env vars, if set.

    Uses LLM_PROVIDER + LLM_MODEL. For backward compatibility,
    defaults to ollama + LLM_MODEL if LLM_PROVIDER is not set.
    Returns None if LLM_MODEL is not set — callers should allow
    the user to pick a model from the UI in that case.
    """
    model = os.environ.get("LLM_MODEL", "")
    if not model:
        return None
    provider = os.environ.get("LLM_PROVIDER", "ollama")
    return (provider, model)


def invalidate_cache() -> None:
    """Clear cached providers and clients (useful for testing or config reload)."""
    global _providers, _ollama_reachable
    _providers = None
    _ollama_reachable = None
    _clients.clear()
