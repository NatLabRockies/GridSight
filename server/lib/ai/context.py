"""Context assembly helpers for agent-facing prompts.

The chat system prompt is rebuilt on *every* message, so anything rendered
into it is paid for on every turn. This module owns the parts of that prompt
that scale with how much data is loaded.

The first of those is the DuckDB table catalog. Extensions register tables per
scenario, so the catalog grows roughly linearly with the number of scenarios
loaded — a single GAT PCM scenario contributes ~80 tables, and on a typical
stack the catalog was ~19 KB of the ~45 KB prompt, dwarfing the extension
schemas that actually carry column-level meaning.

The strategy here is **collapse, not truncate**. A family of tables that share
a naming pattern is described once — pattern, count, shared description, a few
examples — so the agent can still *construct* any name in the family and knows
it exists. ``get_table_catalog(pattern=...)`` is the escape hatch for full
detail on anything collapsed, which keeps the compression lossless in
capability even though it is lossy in bytes.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable, Sequence

logger = logging.getLogger(__name__)

# A schema holding at most this many tables is always listed one-per-line.
SCHEMA_EXPAND_LIMIT = 12
# Inside a large schema, a family with at most this many members is expanded.
FAMILY_EXPAND_LIMIT = 8
# A group is only worth collapsing once it has at least this many members.
GROUP_COLLAPSE_MIN = 3
# How many example table names to show for a collapsed group.
EXAMPLE_COUNT = 3
# Soft ceiling on the whole rendered catalog. Past this we re-render with
# families collapsed wholesale rather than dropping tables silently.
DEFAULT_BUDGET_CHARS = 6000


def _split_qualified(table_name: str) -> tuple[str, str]:
    """Split ``schema.table`` into its parts (schema is "" if unqualified)."""
    schema, sep, rest = table_name.partition(".")
    return (schema, rest) if sep else ("", table_name)


def _segments(rest: str) -> tuple[str, str, str]:
    """Split a ``__``-delimited table name into (family, group, leaf).

    Extensions commonly namespace tables as ``{scenario}__{kind}__{name}``
    (GAT) or just ``{name}`` (SEDS, demand-tldr). Both shapes fall out of this
    without the renderer knowing anything about a specific extension.
    """
    parts = rest.split("__")
    if len(parts) == 1:
        return "", "", parts[0]
    if len(parts) == 2:
        return parts[0], "", parts[1]
    return parts[0], parts[1], "__".join(parts[2:])


def _common_prefix(values: Sequence[str]) -> str:
    """Longest shared prefix of ``values``, or "" if it isn't worth hoisting.

    Used to lift a repeated description stem (e.g. GAT's ``[Demo/Base] ``) out
    of every line in a group and state it once.
    """
    values = [v for v in values if v]
    if len(values) < 2:
        return ""
    first, last = min(values), max(values)
    i = 0
    while i < len(first) and i < len(last) and first[i] == last[i]:
        i += 1
    prefix = first[:i]
    # Only hoist a prefix that looks like a real stem, not a coincidence.
    return prefix if len(prefix.strip()) >= 4 else ""


def _describe(entry: Any) -> str:
    return (getattr(entry, "description", "") or "").strip()


def _name(entry: Any) -> str:
    return getattr(entry, "table_name", "") or ""


def _bullet(entry: Any, *, strip_prefix: str = "") -> str:
    desc = _describe(entry)
    if strip_prefix and desc.startswith(strip_prefix):
        desc = desc[len(strip_prefix):].strip()
    return f"- `{_name(entry)}`: {desc}" if desc else f"- `{_name(entry)}`"


def _collapsed(
    schema: str,
    pattern: str,
    entries: Sequence[Any],
) -> str:
    """One line standing in for a whole group of same-shaped tables."""
    stem = _common_prefix([_describe(e) for e in entries]).strip().rstrip(":-–— ")
    examples = ", ".join(
        f"`{_segments(_split_qualified(_name(e))[1])[2]}`"
        for e in entries[:EXAMPLE_COUNT]
    )
    desc = f" — {stem}" if stem else ""
    more = f" (+{len(entries) - EXAMPLE_COUNT} more)" if len(entries) > EXAMPLE_COUNT else ""
    return (
        f"- {len(entries)} × `{schema}.{pattern}*`{desc}; e.g. {examples}{more}. "
        f'Full list: get_table_catalog(pattern="{pattern}")'
    )


def _render_schema(schema: str, entries: Sequence[Any], *, terse: bool) -> list[str]:
    """Render one DuckDB schema, expanding what is small and collapsing what isn't."""
    if len(entries) <= SCHEMA_EXPAND_LIMIT and not terse:
        return [_bullet(e) for e in entries]

    # Group by family, preserving registration order (it is meaningful — an
    # extension registers its headline tables before its generated ones).
    families: dict[str, list[Any]] = {}
    for e in entries:
        family, _, _ = _segments(_split_qualified(_name(e))[1])
        families.setdefault(family, []).append(e)

    lines: list[str] = []
    for family, members in families.items():
        if not family:
            # Un-namespaced tables in a big schema: expand, they're the headline ones.
            lines.extend(_bullet(e) for e in members)
            continue

        stem = _common_prefix([_describe(e) for e in members])
        header = f"**`{family}__`** — {len(members)} tables"
        if stem:
            header += f", all described as \"{stem.strip()}…\""
        lines.append(header)

        if terse:
            groups_seen: dict[str, int] = {}
            for e in members:
                _, group, _ = _segments(_split_qualified(_name(e))[1])
                groups_seen[group or "(top level)"] = groups_seen.get(group or "(top level)", 0) + 1
            summary = ", ".join(f"{k}×{v}" for k, v in groups_seen.items())
            lines.append(
                f"- {summary}. "
                f'Full list: get_table_catalog(pattern="{family}__")'
            )
            continue

        if len(members) <= FAMILY_EXPAND_LIMIT:
            lines.extend(_bullet(e, strip_prefix=stem) for e in members)
            continue

        groups: dict[str, list[Any]] = {}
        for e in members:
            _, group, _ = _segments(_split_qualified(_name(e))[1])
            groups.setdefault(group, []).append(e)

        for group, g_members in groups.items():
            if not group or len(g_members) < GROUP_COLLAPSE_MIN:
                lines.extend(_bullet(e, strip_prefix=stem) for e in g_members)
            else:
                lines.append(_collapsed(schema, f"{family}__{group}__", g_members))

    return lines


def render_table_catalog(
    catalog: Iterable[Any],
    *,
    documented: set[str] | None = None,
    active_prefixes: set[str] | None = None,
    budget_chars: int = DEFAULT_BUDGET_CHARS,
) -> list[str]:
    """Render the DuckDB catalog as prompt lines, scoped and collapsed.

    ``documented`` names tables already rendered in full (with columns) by the
    extension-schema section — repeating them here is pure duplication.
    ``active_prefixes`` keeps the existing active-extension filter.
    """
    documented = documented or set()
    entries = []
    for t in catalog:
        name = _name(t)
        if not name or name in documented:
            continue
        if active_prefixes is not None and name.startswith("ext_"):
            if not any(name.startswith(p) for p in active_prefixes):
                continue
        entries.append(t)

    if not entries:
        return []

    by_schema: dict[str, list[Any]] = {}
    for e in entries:
        by_schema.setdefault(_split_qualified(_name(e))[0] or "(default)", []).append(e)

    def build(terse: bool) -> list[str]:
        out = ["\n## DuckDB Tables"]
        if documented:
            out.append(
                "Tables documented with full columns above are not repeated here. "
                "Use get_table_catalog(pattern=…) for columns on anything below."
            )
        for schema, schema_entries in by_schema.items():
            n = len(schema_entries)
            out.append(f"\n### `{schema}` — {n} table{'s' if n != 1 else ''}")
            out.extend(_render_schema(schema, schema_entries, terse=terse))
        return out

    lines = build(terse=False)
    if sum(len(l) for l in lines) > budget_chars:
        lines = build(terse=True)
    return lines



def is_empty_selection(value: Any) -> bool:
    """True when a control value selects NOTHING.

    An empty multi-select is not a filter, it is a blackout: every layer and
    chart downstream of it renders blank, which reads as a broken app rather
    than a narrow one. Shared with the input-control tool so the warning the
    assistant gets after a change and the state it is shown before one cannot
    disagree.
    """
    if value is None:
        return True
    if isinstance(value, (list, tuple, set, dict)) and len(value) == 0:
        return True
    if isinstance(value, str) and value.strip().lower() in ("", "none", "[]", "null"):
        return True
    return False


# ── Story / chapter context ─────────────────────────────────────────────────
#
# A story is the coarsest scope an agent works in, and the *chapter* inside it
# is the finest one the user is actually looking at. A perspective's saved
# config_json already records everything that makes a chapter concrete — the
# scenario, which layers are visible, which charts are open, the control
# values, the camera — so rendering it gives the agent the on-screen situation
# without the client having to serialise live app state on every message.

# Controls shown inline before the list is truncated.
MAX_CHAPTER_CONTROLS = 14
# Charts listed for a chapter before summarising the remainder.
MAX_CHAPTER_CHARTS = 6


def _config(perspective: Any) -> dict:
    try:
        parsed = json.loads(perspective.config_json or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        logger.debug("Unparseable config_json on perspective %s", getattr(perspective, "id", "?"))
        return {}


def _layer_names(session, layer_ids: Iterable[int]) -> dict[int, str]:
    """Map layer id → display name so the agent sees names, not bare numbers."""
    ids = [i for i in layer_ids if i is not None]
    if not ids:
        return {}
    from models.orm import Layer

    rows = session.query(Layer).filter(Layer.id.in_(ids)).all()
    return {r.id: (r.display_name or r.name) for r in rows}


def _chapter_charts(config: dict) -> list[str]:
    """Flatten the saved chart frames into readable 'what's open' entries."""
    out: list[str] = []
    for frame in config.get("chartFrames") or []:
        if not isinstance(frame, dict):
            continue
        anchor = frame.get("anchorMode") or "floating"
        for chart in frame.get("charts") or []:
            if not isinstance(chart, dict):
                continue
            spec = chart.get("chartSpec") or {}
            label = spec.get("display_name") or chart.get("chartName") or "chart"
            ext = chart.get("extName") or spec.get("extension") or "?"
            name = chart.get("chartName") or spec.get("name") or "?"
            entity = chart.get("entityId")
            entity_str = f", entity {entity}" if entity else ""
            out.append(f'"{label}" (open_chart: {ext}/{name}{entity_str}; anchored {anchor})')
    return out


def _chapter_body(session, perspective: Any, step: Any) -> list[str]:
    """The on-screen situation a chapter encodes: scenario, layers, charts, controls."""
    config = _config(perspective)
    lines: list[str] = []

    scenario = config.get("scenario") or {}
    if scenario.get("project"):
        enabled = ", ".join((config.get("extensions") or {}).get("enabled") or []) or "none"
        lines.append(
            f"- Scenario: `{scenario.get('project')}` / `{scenario.get('scenario')}` "
            f"(extensions enabled: {enabled})"
        )

    visibility = (config.get("layers") or {}).get("visibility") or {}
    if visibility:
        ids = {int(k): bool(v) for k, v in visibility.items() if str(k).lstrip("-").isdigit()}
        names = _layer_names(session, ids.keys())
        # A saved chapter can outlive the layers it referenced. An id with no
        # row is a deleted layer, not something on screen — drop it rather than
        # offering the agent a number it cannot act on.
        shown = [f"`{names[i]}` (layer_id={i})" for i, on in ids.items() if on and i in names]
        hidden = [f"`{names[i]}`" for i, on in ids.items() if not on and i in names]
        lines.append(f"- Visible layers: {', '.join(shown) if shown else 'none'}")
        if hidden:
            lines.append(f"- Hidden layers: {', '.join(hidden)}")

    charts = _chapter_charts(config)
    if charts:
        head = charts[:MAX_CHAPTER_CHARTS]
        more = f" (+{len(charts) - MAX_CHAPTER_CHARTS} more)" if len(charts) > MAX_CHAPTER_CHARTS else ""
        lines.append(f"- Open charts: {'; '.join(head)}{more}")

    controls = config.get("controls") or {}
    values = controls.get("values") or {}
    if values:
        items = list(values.items())[:MAX_CHAPTER_CONTROLS]
        rendered = ", ".join(f"{k}={v}" for k, v in items)
        more = f", +{len(values) - MAX_CHAPTER_CONTROLS} more" if len(values) > MAX_CHAPTER_CONTROLS else ""
        lines.append(
            f"- Control values saved with this chapter ({controls.get('extName', '?')}): "
            f"{rendered}{more}"
        )

    view = config.get("view") or {}
    if view.get("latitude") is not None:
        pitch = view.get("pitch") or 0
        pitch_str = f", pitch {pitch:.0f}°" if pitch else ""
        lines.append(
            f"- Camera: {view['latitude']:.2f}, {view['longitude']:.2f} "
            f"@ zoom {view.get('zoom', 0):.1f}{pitch_str}; basemap {config.get('basemap', 'default')}"
        )

    clock = config.get("clock") or {}
    if clock:
        state = "animating" if clock.get("animate") else "paused"
        lines.append(f"- Clock: index {clock.get('index', 0)}, {state}")

    narration = (getattr(step, "narration", None) or "").strip() if step is not None else ""
    if narration:
        lines.append(f"- Narration: {narration}")

    return lines


def render_story_context(db: Any, *, story_id: int | None, perspective_id: int | None) -> list[str]:
    """Render the active story and the chapter within it that is on screen.

    Placed last in the system prompt so it is the most salient block. Either id
    may be absent: a story with no applied chapter renders as an outline, and a
    perspective applied outside any story renders as the current view.
    """
    if db is None or (story_id is None and perspective_id is None):
        return []

    from models.orm import Perspective, Story, StoryStep

    parts: list[str] = []
    session = db.get_session()
    try:
        story = (
            session.query(Story).filter(Story.id == story_id).first()
            if story_id is not None else None
        )
        steps = []
        if story:
            steps = (
                session.query(StoryStep, Perspective)
                .join(Perspective, Perspective.id == StoryStep.perspective_id)
                .filter(StoryStep.story_id == story.id)
                .order_by(StoryStep.sort_order.asc(), StoryStep.id.asc())
                .all()
            )

        # Locate the applied chapter within the story, if it is one.
        current_index = next(
            (i for i, (st, _) in enumerate(steps) if st.perspective_id == perspective_id),
            -1,
        )
        current_persp = steps[current_index][1] if current_index >= 0 else None
        current_step = steps[current_index][0] if current_index >= 0 else None
        if current_persp is None and perspective_id is not None:
            current_persp = (
                session.query(Perspective).filter(Perspective.id == perspective_id).first()
            )

        if story:
            parts.append(f'\n## Active Story: "{story.name}"')
            parts.append(
                "The user is working within this saved story — treat it as the "
                "primary context for what they're trying to convey and answer in "
                "keeping with it."
            )
            if story.description:
                parts.append(story.description)
            if getattr(story, "guiding_prompt", None):
                parts.append("\n### Story guide")
                parts.append(story.guiding_prompt)

            if steps:
                parts.append("\n### Chapters (in order)")
                for i, (st, p) in enumerate(steps):
                    marker = " ← **currently applied**" if i == current_index else ""
                    name = p.name if p else "Chapter"
                    desc = f" — {p.description}" if (p and p.description) else ""
                    parts.append(
                        f"{i + 1}. \"{name}\" (perspective_id={st.perspective_id}){desc}{marker}"
                    )

        if current_persp is not None:
            if current_index >= 0:
                header = (
                    f"\n### Current chapter — {current_index + 1} of {len(steps)}: "
                    f'"{current_persp.name}"'
                )
            else:
                header = f'\n## Current view: "{current_persp.name}"'
            parts.append(header)
            if current_persp.description:
                parts.append(current_persp.description)
            body = _chapter_body(session, current_persp, current_step)
            if body:
                parts.append("\nWhat is on screen:")
                parts.extend(body)
            parts.append(
                "\nThese are the chapter's saved settings, applied when it was opened. "
                "The user may have changed things since — when a tool result disagrees "
                "with this block, trust the tool result."
            )
        elif story and steps:
            parts.append(
                "\nNo chapter is currently applied — the user is in the story but has "
                "not opened a specific chapter yet."
            )

        if story:
            parts.append("\n### Working from a story — reuse before building")
            parts.append(
                "Prefer reusing the story's existing work over creating from "
                "scratch. In priority order:"
            )
            parts.append(
                "1. Stay in the current chapter — toggle a layer, open one of its "
                "charts, or change a control — when the answer lives there."
            )
            parts.append(
                "2. Apply another existing chapter as-is (apply_perspective with its "
                "perspective_id) when it already frames what's asked."
            )
            parts.append(
                "3. Prefer the extensions' pre-built charts (list_charts → "
                "open_chart) and the known datasets/SQL; adjust the style or "
                "aggregation of a known query before authoring a brand-new one."
            )
            parts.append(
                "4. Only create new charts / SQL / layers from scratch when nothing "
                "above fits."
            )
            parts.append(
                "Keep every change consistent with the story's intent and the "
                "current chapter."
            )
    except Exception:
        logger.debug("Could not build story/chapter context", exc_info=True)
        return []
    finally:
        session.close()

    return parts


# ── Live view state ─────────────────────────────────────────────────────────
#
# What is on screen RIGHT NOW, as opposed to what a saved chapter recorded.
# Rendered into the system prompt before the turn, and again after each round
# of tool calls so the assistant can VERIFY its changes landed rather than
# assuming. Repeatedly this session the narration described the intent
# ("the map now shows Texas counties") while the screen disagreed, because
# nothing ever fed the result back.

# Tools that change what the user sees. Anything here triggers a re-render of
# the view state after the round that ran it.
VIEW_MUTATING_TOOLS = frozenset({
    "set_layer_visibility", "set_visible_layers", "filter_layer", "style_layer",
    "update_layer_style",
    "update_input_control", "set_input_controls", "update_control", "open_chart",
    "create_chart",
    "close_charts", "arrange_charts", "apply_perspective", "apply_story",
    "set_scenario", "set_extension_state", "fit_map_to_bounds", "pan_map",
    "zoom_map", "set_basemap", "set_basemap_detail",
    "set_clock_year", "configure_layer_interaction",
})


def render_view_state(
    db: Any,
    registry: Any,
    *,
    visible_layer_ids: list[int] | None,
    active_extensions: list[str] | None = None,
    heading: str = "## What is on screen right now",
) -> list[str]:
    """Render live view state: visible layers and current control values.

    Layer visibility is client state and must be supplied; control values are
    read from the extensions, which are the authority on them.
    """
    parts: list[str] = []
    visible: list[str] = []
    hidden: list[str] = []

    if db is not None and visible_layer_ids is not None:
        try:
            from models.orm import Layer

            session = db.get_session()
            try:
                vis = set(visible_layer_ids)
                for lyr in session.query(Layer).all():
                    label = f"`{lyr.display_name or lyr.name}` (layer_id={lyr.id})"
                    (visible if lyr.id in vis else hidden).append(label)
            finally:
                session.close()
        except Exception:
            logger.debug("Could not read layers for view state", exc_info=True)

    control_lines: list[str] = []
    if registry is not None:
        for name, ext in (registry.items() if hasattr(registry, "items") else []):
            if active_extensions is not None and name not in active_extensions:
                continue
            try:
                projects = ext.list_projects() if hasattr(ext, "list_projects") else []
                proj = projects[0].name if projects else None
                scens = ext.list_scenarios(proj) if proj and hasattr(ext, "list_scenarios") else []
                scen = scens[0].name if scens else None
                if not (proj and scen):
                    continue
                rendered = []
                empty = []
                for dc in ext.get_input_controls(proj, scen):
                    v = dc.current_value
                    # An EMPTY multi-select matches nothing, so every chart and
                    # layer downstream of it is blank — a state that reads as
                    # "broken" rather than "filtered". Printing `carrier=[]`
                    # among twelve other values does not carry that; it has to
                    # be called out or it is skimmed past.
                    is_empty = is_empty_selection(v)
                    rendered.append(f"{dc.name}={v!r}" if is_empty else f"{dc.name}={v}")
                    if is_empty:
                        empty.append(dc.name)
                if rendered:
                    control_lines.append(f"- {name} ({proj}/{scen}): {', '.join(rendered)}")
                if empty:
                    control_lines.append(
                        f"  ⚠ SELECTS NOTHING: {', '.join(empty)} — these are empty, so "
                        f"any layer or chart filtered by them will render blank. If the "
                        f"user's question needs them, widen the selection first."
                    )
            except Exception:
                continue

    if not (visible or hidden or control_lines):
        return []

    parts.append(f"\n{heading}")
    if visible or hidden:
        parts.append(f"- Visible layers: {', '.join(visible) if visible else 'NONE'}")
        if hidden:
            parts.append(f"- Hidden layers: {', '.join(hidden)}")
    if control_lines:
        parts.append("- Current control values:")
        parts.extend(f"  {line}" for line in control_lines)
    return parts
