"""
Unified LLM client using the OpenAI Python library.

Connects to any OpenAI-compatible provider (OpenAI, Anthropic, xAI, Ollama, etc.)
via the provider registry in providers.py.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any

import httpx

from .providers import get_active_providers, get_provider_client

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 60.0


async def llm_chat(
    provider_id: str,
    model: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    cancel_event: asyncio.Event | None = None,
    think: bool | None = None,
    reasoning_effort: str | None = None,
) -> dict:
    """
    Call a chat completion via the OpenAI-compatible API.

    Returns: {"content": str, "tool_calls": list[dict] | None}
    Same shape as the legacy ollama_chat() for drop-in compatibility.
    """
    client = get_provider_client(provider_id)

    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
    }

    # Build tools in OpenAI format
    if tools:
        kwargs["tools"] = tools

    # Provider-specific thinking support
    if think is not None and provider_id == "ollama":
        # Ollama supports 'extra_body' for non-standard params
        kwargs["extra_body"] = {"think": think}

    # Reasoning effort for OpenAI-compatible reasoning models (e.g. gpt-oss
    # via a LiteLLM proxy): low/medium/high turns DOWN how long the model
    # "thinks". Only sent when the provider config opts in via
    # `reasoning_effort_env` (or a static `reasoning_effort`), so providers
    # that don't understand the param never receive it. Passed in extra_body
    # so it merges into the request body without SDK-side validation.
    if provider_id != "ollama":
        pcfg = _get_provider_config(provider_id) or {}
        eff_env = pcfg.get("reasoning_effort_env")
        # Caller's choice wins over the deployment default. Effort is the main
        # latency lever on a reasoning model — a "turn this layer on" turn does
        # not need deep thinking — so it belongs where the user can reach it,
        # not only in an env var set at launch.
        effort = reasoning_effort or (
            os.environ.get(eff_env, "").strip() if eff_env else pcfg.get("reasoning_effort")
        )
        if effort:
            kwargs.setdefault("extra_body", {})["reasoning_effort"] = effort

    async def _do_request():
        return await client.chat.completions.create(
            **kwargs,
            timeout=timeout,
        )

    if cancel_event:
        request_task = asyncio.create_task(_do_request())
        cancel_task = asyncio.create_task(cancel_event.wait())
        done, pending = await asyncio.wait(
            {request_task, cancel_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        if cancel_task in done:
            raise asyncio.CancelledError("Chat cancelled by user")
        completion = request_task.result()
    else:
        completion = await _do_request()

    # Extract the response
    choice = completion.choices[0] if completion.choices else None
    if not choice:
        return {"content": "", "tool_calls": None}

    msg = choice.message
    content = msg.content or ""

    # Extract thinking/reasoning content if present
    # OpenAI o-series: reasoning_content
    # Some providers use a 'thinking' field
    thinking = getattr(msg, "reasoning_content", None) or getattr(msg, "thinking", None) or ""

    # Normalize tool calls to our internal format
    tool_calls = None
    if msg.tool_calls:
        tool_calls = []
        for tc in msg.tool_calls:
            tool_calls.append({
                "id": tc.id,
                "name": tc.function.name,
                "arguments": tc.function.arguments,
            })

    # Ollama fallback: small models sometimes emit tool calls as text
    if not tool_calls and content and provider_id == "ollama":
        from .ollama_client import _extract_text_tool_calls, _strip_tool_call_text
        extracted = _extract_text_tool_calls(content, tools or [])
        if extracted:
            tool_calls = extracted
            content = _strip_tool_call_text(content)

    return {"content": content, "tool_calls": tool_calls, "thinking": thinking}


async def llm_list_models(provider_id: str) -> list[dict]:
    """List available models for a provider.

    For Ollama, delegates to the native API for capability detection.
    For cloud providers, resolution order:
      1. Custom models_endpoint (direct HTTP call) if defined in provider config
      2. Standard OpenAI /models endpoint via the client library
      3. known_models from the provider JSON config as fallback
    """
    if provider_id == "ollama":
        return await _list_ollama_models()

    # Check for a custom models_endpoint first
    provider_config = _get_provider_config(provider_id)
    models_endpoint = provider_config.get("models_endpoint") if provider_config else None

    results = []
    if models_endpoint:
        results = await _list_models_from_endpoint(provider_id, provider_config)

    # Try the standard OpenAI client library
    if not results:
        results = await _list_models_from_api(provider_id)

    # Fall back to known_models from the provider config
    if not results:
        results = _get_known_models(provider_id)

    # Restrict the listed models if the provider defines an allowlist and/or a
    # regex filter (e.g. limit a LiteLLM proxy to its free models). Configured
    # via the env vars named in "models_allowlist_env" / "models_filter_env".
    results = _apply_model_restrictions(provider_id, provider_config, results)

    return results


def _apply_model_restrictions(
    provider_id: str,
    provider_config: dict[str, Any] | None,
    results: list[dict],
) -> list[dict]:
    """Narrow the listed models via two optional, composable restrictions:

      * ``models_allowlist_env`` — comma-separated exact model names. If the
        live listing surfaced none of them (e.g. the /models call failed),
        the allowlist names are exposed directly so a model is still
        selectable rather than the provider appearing empty.
      * ``models_filter_env`` — a regex matched against each model name with
        ``re.search`` (so a plain substring like ``llama`` works, as does an
        anchored ``^gpt``). Useful when related models share a name prefix.

    Either may be set; both narrow the list. When neither env var is set the
    full list passes through unchanged.
    """
    if not provider_config:
        return results

    # 1) Exact allowlist.
    allow_env = provider_config.get("models_allowlist_env")
    if allow_env:
        raw = os.environ.get(allow_env, "")
        allow = {m.strip() for m in raw.split(",") if m.strip()}
        if allow:
            filtered = [r for r in results if r["name"] in allow]
            if not filtered:
                filtered = [
                    {
                        "name": name,
                        "supports_tools": _infer_tool_support(provider_id, name),
                        "supports_thinking": _infer_thinking_support(provider_id, name),
                    }
                    for name in sorted(allow)
                ]
            results = filtered

    # 2) Regex / substring filter.
    filter_env = provider_config.get("models_filter_env")
    if filter_env:
        pattern = os.environ.get(filter_env, "").strip()
        if pattern:
            try:
                rx = re.compile(pattern)
                results = [r for r in results if rx.search(r["name"])]
            except re.error:
                logger.warning(
                    "Ignoring invalid model filter regex for %s: %r",
                    provider_id, pattern,
                )

    return results


def _get_provider_config(provider_id: str) -> dict[str, Any] | None:
    """Get the raw provider config dict from the JSON definitions."""
    from .providers import _get_providers

    for p in _get_providers():
        if p["id"] == provider_id:
            return p
    return None


async def _list_models_from_endpoint(
    provider_id: str, provider_config: dict[str, Any],
) -> list[dict]:
    """Fetch models from a custom models_endpoint via direct HTTP call."""
    from .providers import _resolve_api_key

    endpoint = provider_config.get("models_endpoint", "")
    if not endpoint:
        return []

    api_key = _resolve_api_key(provider_config)
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        from .providers import _get_httpx_client
        async with _get_httpx_client() as client:
            resp = await client.get(endpoint, headers=headers, timeout=10.0)
            resp.raise_for_status()
            data = resp.json()

        # OpenAI-compatible format: {"data": [{"id": "model-name", ...}, ...]}
        # Some providers use {"models": [...]} or return a plain list
        models_list = data.get("data") or data.get("models") or (data if isinstance(data, list) else [])
        logger.debug("Raw models from %s endpoint: %d items", provider_id, len(models_list))

        results = []
        for m in models_list:
            # Handle both object format and plain string format
            if isinstance(m, str):
                model_id = m
            else:
                model_id = m.get("id") or m.get("name") or m.get("model") or ""
            if not model_id:
                continue
            results.append({
                "name": model_id,
                "supports_tools": _infer_tool_support(provider_id, model_id),
                "supports_thinking": _infer_thinking_support(provider_id, model_id),
            })

        results.sort(key=lambda x: x["name"])
        logger.info("Listed %d models from %s endpoint %s (from %d raw)", len(results), provider_id, endpoint, len(models_list))
        return results
    except Exception as e:
        logger.info("Could not list models from %s endpoint %s: %s", provider_id, endpoint, e)
        return []


async def _list_models_from_api(provider_id: str) -> list[dict]:
    """Try to list models from the provider's /models endpoint via the OpenAI client."""
    try:
        client = get_provider_client(provider_id)
        response = await client.models.list()

        results = []
        for m in response.data:
            model_id = m.id
            if not _is_chat_model(provider_id, model_id):
                continue
            results.append({
                "name": model_id,
                "supports_tools": _infer_tool_support(provider_id, model_id),
                "supports_thinking": _infer_thinking_support(provider_id, model_id),
            })

        results.sort(key=lambda x: x["name"])
        if results:
            logger.debug("Listed %d models from %s API", len(results), provider_id)
        return results
    except Exception as e:
        logger.info("Could not list models from %s API (will try fallbacks): %s", provider_id, e)
        return []


def _get_known_models(provider_id: str) -> list[dict]:
    """Return known_models from the provider's JSON config as a fallback."""
    config = _get_provider_config(provider_id)
    if not config:
        return []

    known = config.get("known_models", [])
    if known:
        logger.debug("Using %d known_models for provider %s", len(known), provider_id)
        return [
            {
                "name": m["name"],
                "supports_tools": m.get("supports_tools", True),
                "supports_thinking": m.get("supports_thinking", False),
            }
            for m in known
        ]
    return []


async def _list_ollama_models() -> list[dict]:
    """Use the native Ollama API for model listing with capability detection."""
    from .ollama_client import ollama_list_models
    providers = await get_active_providers()
    ollama = providers.get("ollama")
    if not ollama:
        return []
    # ollama_list_models expects the base Ollama URL (without /v1)
    base_url = ollama["resolved_base_url"]
    if base_url.endswith("/v1"):
        base_url = base_url[:-3]
    return await ollama_list_models(base_url)


def _is_chat_model(provider_id: str, model_id: str) -> bool:
    """Filter to chat-capable models based on known provider patterns."""
    mid = model_id.lower()

    if provider_id == "openai":
        # Include GPT and O-series models, exclude embeddings/tts/whisper/dall-e
        chat_prefixes = ("gpt-", "o1", "o3", "o4")
        skip_patterns = ("realtime", "audio", "search")
        if not any(mid.startswith(p) for p in chat_prefixes):
            return False
        if any(s in mid for s in skip_patterns):
            return False
        return True

    if provider_id == "xai":
        return any(p in mid for p in ("grok", "xai"))

    if provider_id == "anthropic":
        return "claude" in mid

    if provider_id == "google":
        return "gemini" in mid

    if provider_id == "bedrock":
        # Bedrock exposes models from multiple vendors
        return any(p in mid for p in ("anthropic", "amazon", "meta", "mistral", "cohere"))

    # Unknown provider: include all models
    return True


def _infer_tool_support(provider_id: str, model_id: str) -> bool:
    """Infer tool/function calling support from provider and model name."""
    if provider_id in ("openai", "xai", "anthropic", "google", "bedrock"):
        return True
    return True  # optimistic default


def _infer_thinking_support(provider_id: str, model_id: str) -> bool:
    """Infer extended thinking support from provider and model name."""
    mid = model_id.lower()

    if provider_id == "openai":
        return mid.startswith(("o1", "o3", "o4"))

    if provider_id == "anthropic":
        return "claude" in mid

    if provider_id == "xai":
        return "reasoning" in mid or "think" in mid

    if provider_id == "google":
        return "thinking" in mid or "2.5" in mid

    if provider_id == "bedrock":
        return "claude" in mid

    return False
