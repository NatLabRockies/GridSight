"""Shared JSON response helper."""
from fastapi.responses import JSONResponse


def make_response(data, status: int = 200, cache_seconds: int | None = None):
    """Return a JSONResponse, optionally with a browser HTTP cache header.

    `cache_seconds` is for endpoints whose response is stable for the
    lifetime of a browser session (chart specs, entity timeseries, etc.).
    The browser HTTP cache is cross-tab on the same origin, so a tab
    that already fetched a chart hands the response to a sibling tab
    without re-hitting the server.
    """
    headers = {}
    if status == 200 and cache_seconds is not None and cache_seconds > 0:
        headers["Cache-Control"] = f"private, max-age={cache_seconds}"
    return JSONResponse(content=data, status_code=status, headers=headers or None)
