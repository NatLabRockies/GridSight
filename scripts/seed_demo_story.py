#!/usr/bin/env python3
"""
Seed an "AI Test Drive" story whose steps carry pre-canned prompts, so you can
click through the prompts as chips in the Atlas chat instead of typing them —
handy for testing the AI quickly.

How it works:
  - Each step references a MINIMAL (empty-config) perspective. Applying an
    empty perspective is a no-op in the frontend (applyViewState ignores it),
    so advancing the story just surfaces that step's prompt chips without
    disturbing your current map/scenario/clock state.
  - The story's per-step `suggested_prompts` are what render as tap-to-send
    chips above the Atlas composer when that step is active.

Usage:
    # with ./dev.sh running (backend on :5001):
    python3 scripts/seed_demo_story.py

    # against another backend / key:
    GRIDSIGHT_URL=http://127.0.0.1:5001 API_KEY=dev-api-key python3 scripts/seed_demo_story.py

Re-running deletes the existing "AI Test Drive" story and recreates it, so edit
the BEATS below and re-run to iterate on the prompt set.

To use it: open the story (story picker / playback panel) — step 1's prompts
appear as chips in Atlas; use the playback Prev/Next to move between steps.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

STORY_NAME = "AI Test Drive"
STORY_DESCRIPTION = "Click-through pre-canned prompts for testing the Atlas AI."

# Each beat becomes one story step. `prompts` render as tap-to-send chips in
# Atlas when that step is active. Edit freely — these exercise the tools the
# chat supports (describe_data, list_charts/open_chart, fit_map_to_bounds/
# pan_map, set_clock_year, list_layers/update_layer_style, update_input_control).
BEATS = [
    {
        "title": "Orientation",
        "prompts": [
            "What data do you have access to?",
            "List the pre-configured charts.",
            "What can you help me do with this map?",
        ],
    },
    {
        "title": "Map navigation",
        "prompts": [
            "Zoom into Texas.",
            "Zoom back out to the whole US.",
            "Pan to Houston.",
        ],
    },
    {
        "title": "SEDS energy charts",
        "prompts": [
            "Show US total energy over time.",
            "Open the US fuel mix chart.",
            "Plot Texas electricity consumption by sector over time.",
        ],
    },
    {
        "title": "Time travel",
        "prompts": [
            "Set the year to 1970.",
            "Now set the year to 2020.",
        ],
    },
    {
        "title": "Layers & styling",
        "prompts": [
            "List the map layers.",
            "Color the states by electricity consumption.",
        ],
    },
    {
        "title": "Assumptions",
        "prompts": [
            "Set the EV stock share to 80%.",
            "Reset the EV stock share to 0%.",
        ],
    },
]

BASE_URL = os.environ.get("GRIDSIGHT_URL", "http://127.0.0.1:5001").rstrip("/")
API_KEY = os.environ.get("API_KEY", "dev-api-key")


def _request(method: str, path: str, body: dict | None = None):
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-MyApp-ApiKey", API_KEY)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise SystemExit(f"HTTP {e.code} on {method} {path}: {detail}") from e
    except urllib.error.URLError as e:
        raise SystemExit(
            f"Could not reach the backend at {BASE_URL} ({e.reason}). "
            "Is ./dev.sh running?"
        ) from e


def main() -> None:
    # Delete any existing story of the same name so re-runs stay idempotent.
    stories = _request("GET", "/api/stories") or []
    for s in stories:
        if s.get("name") == STORY_NAME:
            _request("DELETE", f"/api/stories/{s['id']}")
            print(f"Removed existing '{STORY_NAME}' (id {s['id']}).")

    story = _request("POST", "/api/stories",
                     {"name": STORY_NAME, "description": STORY_DESCRIPTION})
    story_id = story["id"]
    print(f"Created story '{STORY_NAME}' (id {story_id}).")

    for i, beat in enumerate(BEATS, start=1):
        persp = _request("POST", "/api/perspectives", {
            "name": f"{STORY_NAME} — {beat['title']}",
            "description": "Prompt-chip carrier (no view change).",
            "config": {},
        })
        persp_id = persp["id"]
        _request("POST", f"/api/stories/{story_id}/steps", {
            "perspective_id": persp_id,
            "narration": beat["title"],
            "suggested_prompts": beat["prompts"],
        })
        print(f"  Step {i}: {beat['title']} ({len(beat['prompts'])} prompts)")

    print(
        f"\nDone. Open the '{STORY_NAME}' story in GridSight, then click the "
        "prompt chips above the Atlas composer. Use the story Prev/Next to "
        "move between prompt groups."
    )


if __name__ == "__main__":
    sys.exit(main())
