"""
Direct Ollama API client that properly handles thinking models + tool calls.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from pathlib import Path
from typing import Any

import re

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 60.0  # seconds per LLM call


def _convert_messages_for_ollama(messages: list[dict]) -> list[dict]:
    """
    Convert OpenAI-format messages to Ollama format.

    Key differences:
    - Ollama tool_calls use: {"function": {"name": ..., "arguments": {dict}}}
    - OpenAI tool_calls use: {"id": ..., "type": "function", "function": {"name": ..., "arguments": "json string"}}
    - Ollama images use: {"images": [base64_string, ...]}
    """
    converted = []
    for msg in messages:
        out: dict[str, Any] = {"role": msg["role"], "content": msg.get("content") or ""}

        # Convert tool_calls
        if "tool_calls" in msg and msg["tool_calls"]:
            out["tool_calls"] = []
            for tc in msg["tool_calls"]:
                fn = tc.get("function", tc)
                name = fn.get("name", "")
                args = fn.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                out["tool_calls"].append({
                    "function": {"name": name, "arguments": args}
                })

        # Convert images (base64 strings)
        if "images" in msg and msg["images"]:
            out["images"] = msg["images"]

        converted.append(out)
    return converted


# Pattern matching tool calls written as text by small models.
# Matches: {"name": "tool_name", "parameters": {...}}
# Uses a brace-balancing approach to handle nested JSON.
_TEXT_TOOL_CALL_START_RE = re.compile(
    r'\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"parameters"\s*:\s*',
    re.DOTALL,
)


def _extract_balanced_json(text: str, start: int) -> str | None:
    """Extract a balanced JSON object starting at text[start] which must be '{'."""
    if start >= len(text) or text[start] != '{':
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        c = text[i]
        if escape:
            escape = False
            continue
        if c == '\\' and in_string:
            escape = True
            continue
        if c == '"' and not escape:
            in_string = not in_string
            continue
        if in_string:
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _extract_text_tool_calls(
    content: str, tools: list[dict],
) -> list[dict] | None:
    """Try to extract tool calls that the model wrote as text."""
    valid_names = set()
    for t in tools:
        fn = t.get("function", t)
        if "name" in fn:
            valid_names.add(fn["name"])

    calls = []
    for m in _TEXT_TOOL_CALL_START_RE.finditer(content):
        name = m.group(1)
        if name not in valid_names:
            continue
        # Find the balanced JSON object for parameters
        params_start = m.end()
        args_str = _extract_balanced_json(content, params_start)
        if not args_str:
            continue
        try:
            args = json.loads(args_str)
        except json.JSONDecodeError:
            continue

        # Fix common model mistakes for create_chart:
        # Model passes "data" (raw rows) instead of "sql" — drop the invalid param
        if name == "create_chart" and "data" in args and "sql" not in args:
            logger.warning("create_chart called with 'data' instead of 'sql' — dropping invalid param")
            del args["data"]

        calls.append({
            "id": f"call_text_{len(calls)}",
            "name": name,
            "arguments": json.dumps(args),
        })

    return calls if calls else None


def _strip_tool_call_text(content: str) -> str:
    """Remove tool-call JSON from visible content, keeping surrounding text."""
    # Remove code-block-wrapped tool calls (handle nested braces)
    cleaned = re.sub(
        r'```(?:json)?\s*\{[^`]*"name"\s*:\s*"\w+"[^`]*\}\s*```',
        '', content, flags=re.DOTALL,
    )
    # Remove bare JSON tool calls by finding balanced braces
    for m in reversed(list(_TEXT_TOOL_CALL_START_RE.finditer(cleaned))):
        # Find the full extent: from the outer { before "name" to the closing }
        outer_start = m.start()
        params_start = m.end()
        params_json = _extract_balanced_json(cleaned, params_start)
        if params_json:
            # The outer object closes after the params: ...parameters: {...}}
            outer_end = params_start + len(params_json)
            # Skip past the closing brace of the outer object
            rest = cleaned[outer_end:].lstrip()
            if rest.startswith('}'):
                outer_end = cleaned.index('}', outer_end) + 1
            cleaned = cleaned[:outer_start] + cleaned[outer_end:]
    # Clean up extra whitespace
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned).strip()
    return cleaned


async def ollama_list_models(base_url: str) -> list[dict]:
    """List locally available models with capability detection.

    For each model, calls /api/show to check for tool call and thinking support.
    Returns a list of dicts with 'name', 'size', 'modified_at',
    'supports_tools', and 'supports_thinking' keys.
    """
    url = f"{base_url}/api/tags"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=10.0)
            resp.raise_for_status()
            data = resp.json()
            raw_models = data.get("models", [])

            results = []
            for m in raw_models:
                name = m.get("name", "")
                entry = {
                    "name": name,
                    "size": m.get("size", 0),
                    "modified_at": m.get("modified_at", ""),
                    "supports_tools": False,
                    "supports_thinking": False,
                }
                # Probe capabilities via /api/show
                try:
                    show_resp = await client.post(
                        f"{base_url}/api/show",
                        json={"name": name},
                        timeout=5.0,
                    )
                    if show_resp.status_code == 200:
                        show_data = show_resp.json()
                        template = show_data.get("template", "")
                        model_info = show_data.get("model_info", {})
                        # Tool support: template contains .ToolCalls or model_info lists tools
                        if ".ToolCalls" in template or "tools" in template.lower():
                            entry["supports_tools"] = True
                        # Also check capabilities in model_info
                        for key, val in model_info.items():
                            if "tool" in key.lower():
                                entry["supports_tools"] = True
                        # Thinking support: template contains <think> or .ThinkingEnabled
                        if "<think>" in template or ".ThinkingEnabled" in template or "thinking" in template.lower():
                            entry["supports_thinking"] = True
                except Exception:
                    pass  # capability detection is best-effort
                results.append(entry)

            return results
    except Exception as e:
        logger.warning("Failed to list Ollama models: %s", e)
        return []


async def ollama_chat(
    base_url: str,
    model: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    cancel_event: asyncio.Event | None = None,
    think: bool | None = None,
) -> dict:
    """
    Call the Ollama /api/chat endpoint and return the parsed response message.

    Args:
        cancel_event: If set, the request will be cancelled when this event fires.
        timeout: Max seconds to wait for a response.
        think: Enable extended thinking (True/False). None = model default.

    Returns: {"content": str, "tool_calls": list[dict] | None}
    """
    payload: dict[str, Any] = {
        "model": model,
        "messages": _convert_messages_for_ollama(messages),
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
    if think is not None:
        payload["think"] = think

    async with httpx.AsyncClient(timeout=timeout) as client:
        if cancel_event:
            # Race the HTTP request against the cancel event
            request_task = asyncio.create_task(
                client.post(f"{base_url}/api/chat", json=payload)
            )
            cancel_task = asyncio.create_task(cancel_event.wait())
            done, pending = await asyncio.wait(
                {request_task, cancel_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            if cancel_task in done:
                raise asyncio.CancelledError("Chat cancelled by user")
            resp = request_task.result()
        else:
            resp = await client.post(f"{base_url}/api/chat", json=payload)

        resp.raise_for_status()
        data = resp.json()

    msg = data.get("message", {})
    content = msg.get("content", "")
    raw_tool_calls = msg.get("tool_calls")

    # Normalize tool_calls to our internal format
    tool_calls = None
    if raw_tool_calls:
        tool_calls = []
        for i, tc in enumerate(raw_tool_calls):
            fn = tc.get("function", {})
            tool_calls.append({
                "id": f"call_{i}",
                "name": fn.get("name", ""),
                "arguments": json.dumps(fn.get("arguments", {})),
            })

    # Fallback: some models output tool calls as text instead of using the
    # tool calling API.  Detect JSON tool-call patterns in content and
    # extract them so the rest of the pipeline can execute them normally.
    if not tool_calls and content:
        extracted = _extract_text_tool_calls(content, tools or [])
        if extracted:
            tool_calls = extracted
            # Strip the tool-call JSON from the visible content
            content = _strip_tool_call_text(content)

    return {"content": content, "tool_calls": tool_calls}


def encode_image_base64(image_path: str | Path) -> str:
    """Read an image file and return its base64 encoding for Ollama vision."""
    data = Path(image_path).read_bytes()
    return base64.b64encode(data).decode("utf-8")
