"""
Single source of truth for the AI tool surface.

Both the in-process web chat (lib/ai/tools.py) and the out-of-process MCP
server (mcp_server.py, a separate stdio process reaching the backend over
HTTP) expose tools to an LLM. Historically each defined its own list, which
drifted (divergent names, missing tools on one side). This module holds the
canonical OpenAI-format schemas; the chat imports them directly and the MCP
server aligns its names/descriptions to them.

Canonical tool names follow the MCP verb-style (query_data, set_scenario,
set_layer_visibility, ...). NAME_ALIASES maps legacy chat names to the
canonical name so the chat dispatcher keeps accepting either during the
migration.
"""
from __future__ import annotations


# Legacy web-chat tool name -> canonical name. The exposed schemas below use
# the canonical names; this lets the dispatcher resolve an old name if a model
# (or cached conversation) still emits one.
NAME_ALIASES = {
    "query_duckdb": "query_data",
    "toggle_layer_visibility": "set_layer_visibility",
    "switch_project_scenario": "set_scenario",
    "list_projects_and_scenarios": "list_scenarios",
}


def to_canonical(name: str) -> str:
    """Resolve a (possibly legacy) tool name to its canonical form."""
    return NAME_ALIASES.get(name, name)


TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "query_data",
            "description": (
                "Execute a read-only SQL query against the DuckDB analytical engine. "
                "Returns results as a JSON array of objects. Use this to answer questions "
                "about data, compute aggregations, filter datasets, etc."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "The SQL query to execute. Must be read-only (SELECT only).",
                    },
                },
                "required": ["sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_table_catalog",
            "description": (
                "List available DuckDB tables with their columns and descriptions. "
                "Pass `pattern` to expand a table family the system prompt collapsed "
                "(e.g. pattern='Demo_Base__sim__'); omit it only when you genuinely "
                "need the whole catalog, which can be hundreds of tables."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": (
                            "Case-insensitive substring of the fully-qualified table name. "
                            "Use the pattern shown in a collapsed catalog entry."
                        ),
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_basemap_detail",
            "description": (
                "Choose which basemap features are drawn — highways, streets, water "
                "bodies, waterways, labels/POIs — so the base can be decluttered to the "
                "task (\"turn off the city streets\", \"just show water\", \"drop the "
                "labels\"). Pass `visible` with the complete set to keep, or `hidden` "
                "with the set to remove. Categories: roads_major, roads_minor, water, "
                "waterways, labels. Applies to vector basemaps only; satellite imagery "
                "has no categories."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "visible": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Complete set to show; everything else is hidden.",
                    },
                    "hidden": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Set to hide; everything else is shown.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_extensions",
            "description": (
                "List every INSTALLED extension and whether it is enabled. A disabled "
                "extension's tables, charts and controls are absent from your context "
                "entirely, so if a user asks for data you cannot find — grid/power-system "
                "simulation, a particular dataset — check here before concluding it does "
                "not exist. It may simply be switched off."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_extension_state",
            "description": (
                "Enable or disable an extension. Enabling loads its layers, data and "
                "charts into the app; disabling removes them from the view. After "
                "enabling, call list_layers again before referring to its layers — the "
                "ids you saw earlier will not include them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "extension": {"type": "string", "description": "Extension name from list_extensions."},
                    "state": {
                        "type": "string",
                        "enum": ["enabled", "disabled", "hidden"],
                        "description": "Default 'enabled'.",
                    },
                },
                "required": ["extension"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_input_controls",
            "description": (
                "Set SEVERAL input controls on one extension in a single call, as "
                "{control_name: value}. PREFER THIS over repeated update_input_control: "
                "controls are interdependent — sectors chosen while carriers are left "
                "empty renders blank everywhere — so applying them together avoids a "
                "half-configured state and recomputes the affected datasets once "
                "instead of once per control. Names are validated before anything is "
                "applied; an unknown name changes nothing and returns the real list. "
                "The result reports any control that ended up selecting nothing, or "
                "whose value the extension coerced, so you can correct it in the same "
                "turn. Controls you do not name are left unchanged."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "extension": {"type": "string", "description": "Extension name, e.g. 'demand-tldr'."},
                    "values": {
                        "type": "object",
                        "description": (
                            "{control_name: value}, e.g. "
                            "{\"state\": \"TX\", \"sectors\": [\"industry\"], "
                            "\"carrier\": [\"electricity\", \"natural_gas\"]}"
                        ),
                    },
                    "project": {"type": "string", "description": "Optional; inferred when omitted."},
                    "scenario": {"type": "string", "description": "Optional; inferred when omitted."},
                },
                "required": ["extension", "values"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_visible_layers",
            "description": (
                "Set the COMPLETE set of visible map layers in one call — every layer "
                "you list is shown, every other layer is hidden. PREFER THIS over "
                "repeated set_layer_visibility when composing a view for a question: "
                "state the layers the answer needs and everything left over from an "
                "earlier question disappears by construction, instead of having to "
                "remember what to turn off. Pass [] to clear the map."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "layer_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": (
                            "Layer ids that should be visible AFTERWARDS. Anything not "
                            "listed is hidden."
                        ),
                    },
                },
                "required": ["layer_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "filter_layer",
            "description": (
                "Show only the features of a map layer whose property matches given "
                "values — e.g. data-centre sites whose `stage` includes 'Construction', "
                "or counties in one state. This is how you narrow WHAT IS DRAWN; "
                "set_layer_visibility only shows or hides the layer whole. Property "
                "names come from the layer's geometry_properties in list_layers. A "
                "feature matches on equality, or, for set-valued properties like "
                "'{Construction,Planned}', if the set contains one of the values. If "
                "the values don't exist the tool refuses and returns the real ones."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "layer_id": {
                        "type": "integer",
                        "description": "Layer to filter (from list_layers).",
                    },
                    "property": {
                        "type": "string",
                        "description": "Feature property to filter on, e.g. 'stage'.",
                    },
                    "values": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Keep features matching any of these values.",
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "Pass false to clear the layer's filter. Default true.",
                    },
                },
                "required": ["layer_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_lineage",
            "description": (
                "Retrieve the data lineage DAG showing how data was produced. "
                "Returns nodes (data sources, transforms, results, viz configs, outputs) "
                "and edges showing derivation relationships. Use this to explain provenance, "
                "trace data origins, or understand the pipeline that produced a result."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "integer",
                        "description": "Optional: get ancestors of a specific node. If omitted, returns all lineage.",
                    },
                    "node_type": {
                        "type": "string",
                        "description": "Optional: filter by node type (data_source, transform, result, viz_config, output).",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_chart",
            "description": (
                "Create a chart from SQL query results, rendered inline in the chat. "
                "Use this when the user asks for a visualization, plot, or chart of their data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "SQL query to get chart data from DuckDB.",
                    },
                    "chart_type": {
                        "type": "string",
                        "enum": ["bar", "line", "scatter", "pie", "stacked_bar", "stacked_area"],
                        "description": "Type of chart to create. Use stacked_bar or stacked_area with color_column for grouped/stacked visualizations.",
                    },
                    "x_column": {
                        "type": "string",
                        "description": "Column name for the x-axis.",
                    },
                    "y_column": {
                        "type": "string",
                        "description": "Column name for the y-axis (or values for pie).",
                    },
                    "title": {
                        "type": "string",
                        "description": "Chart title.",
                    },
                    "color_column": {
                        "type": "string",
                        "description": "Optional column to group data by color (creates separate traces).",
                    },
                },
                "required": ["sql", "chart_type", "x_column", "y_column"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_control",
            "description": (
                "Update a data control value for a specific entity in an extension. "
                "This can change simulation parameters, thresholds, etc."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "extension": {"type": "string", "description": "Extension name"},
                    "project": {"type": "string", "description": "Project name"},
                    "scenario": {"type": "string", "description": "Scenario name"},
                    "entity_id": {"type": "string", "description": "Entity identifier"},
                    "control_name": {"type": "string", "description": "Name of the control to update"},
                    "value": {"description": "New value for the control"},
                },
                "required": ["extension", "project", "scenario", "entity_id", "control_name", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_input_control",
            "description": (
                "Update a project-level input control such as a slider or dropdown. "
                "These controls change simulation parameters that affect datasets and map layers. "
                "Use this for controls like 'EV Stock Share', 'Demand Growth Factor', etc."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "extension": {"type": "string", "description": "Extension name"},
                    "project": {"type": "string", "description": "Project name"},
                    "scenario": {"type": "string", "description": "Scenario name"},
                    "control_name": {"type": "string", "description": "Name of the input control to update"},
                    "value": {"description": "New value for the control"},
                },
                "required": ["extension", "project", "scenario", "control_name", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_layers",
            "description": (
                "List all map layers with their visual style mappings. "
                "Call this to discover layer IDs, style mapping IDs, current colormaps, "
                "and other visual properties before changing layer styles."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_layer_style",
            "description": (
                "Change the visual styling of a map layer's style mapping. "
                "Can update the colormap, scale type, and value domain. "
                "Call list_layers first to get the layer_id and style_id."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "layer_id": {"type": "integer", "description": "Layer ID from list_layers"},
                    "style_id": {"type": "integer", "description": "Style mapping ID from list_layers"},
                    "colormap": {
                        "type": "string",
                        "enum": ["viridis", "plasma", "coolwarm", "rdylgn"],
                        "description": "Color scheme for the mapping",
                    },
                    "scale_type": {
                        "type": "string",
                        "enum": ["linear", "log", "quantile", "categorical"],
                        "description": "How values are scaled to colors",
                    },
                    "domain_min": {"type": "number", "description": "Minimum value of the color scale"},
                    "domain_max": {"type": "number", "description": "Maximum value of the color scale"},
                    "column": {"type": "string", "description": "Data column to drive the visual property"},
                },
                "required": ["layer_id", "style_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "style_layer",
            "description": (
                "Create a NEW visual style on a map layer, driving a visual property from a "
                "data column. Use this to style a freshly-uploaded layer from scratch (e.g. "
                "color and size transmission lines by voltage). Call list_layers first to get "
                "the layer_id and its geometry_properties (name + numeric hint + sample). "
                "Routing is automatic: a geometry feature property writes a geoMapping; a "
                "dataset column creates a style mapping. To fine-tune an EXISTING mapping "
                "afterwards, use update_layer_style."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "layer_id": {"type": "integer", "description": "Layer ID from list_layers"},
                    "visual_property": {
                        "type": "string",
                        "enum": [
                            "getColor", "getFillColor", "getLineColor",
                            "getLineWidth", "getPointRadius", "getElevation",
                        ],
                        "description": "Which visual attribute to drive from the column.",
                    },
                    "column": {
                        "type": "string",
                        "description": "Column / feature-property name (from geometry_properties or an attached dataset).",
                    },
                    "scale_type": {
                        "type": "string",
                        "enum": ["linear", "log", "quantile", "categorical"],
                        "description": "How values map to the visual. Use categorical for discrete classes.",
                    },
                    "colormap": {
                        "type": "string",
                        "enum": ["viridis", "plasma", "coolwarm", "rdylgn"],
                        "description": "Color scheme (for color visual properties).",
                    },
                    "domain_min": {"type": "number", "description": "Optional minimum of the value domain (for color ramps)."},
                    "domain_max": {"type": "number", "description": "Optional maximum of the value domain (for color ramps)."},
                    "units": {
                        "type": "string",
                        "enum": ["meters", "pixels"],
                        "description": (
                            "For SIZE properties (getPointRadius/getLineWidth): render size in "
                            "'meters' (geographic, scales with zoom) or 'pixels' (constant screen "
                            "size). A raw value like planned_mw is multiplied by `scale` in these units, "
                            "so pick units+scale that keep sizes sensible (e.g. meters with a small scale)."
                        ),
                    },
                    "scale": {"type": "number", "description": "For SIZE properties: linear multiplier applied to the raw value (radiusScale / lineWidthScale)."},
                    "min_pixels": {"type": "number", "description": "For SIZE properties: minimum on-screen size in pixels (clamp)."},
                    "max_pixels": {"type": "number", "description": "For SIZE properties: maximum on-screen size in pixels (clamp)."},
                    "category_colors": {
                        "type": "object",
                        "description": (
                            "For scale_type='categorical' only: {category_value: '#RRGGBB'} "
                            "assigning a colour to each value. YOU choose these — group "
                            "related categories into nearby hues and reserve contrast for "
                            "genuinely different ones. Omit on a first call and the tool "
                            "returns `category_values`; re-call with a palette built from "
                            "them. The category keys must match those values exactly."
                        ),
                    },
                    "source": {
                        "type": "string",
                        "enum": ["geometry", "dataset"],
                        "description": "Force routing. Omit to auto-detect from whether the column is a geometry property.",
                    },
                },
                "required": ["layer_id", "visual_property", "column"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "configure_layer_interaction",
            "description": (
                "Configure cross-layer click interactions on a map layer. "
                "When a user clicks a feature on the source layer, the configured actions "
                "execute in order. Use this to wire up drill-down patterns like: "
                "click a state → filter counties to that state, hide states, show counties, zoom in. "
                "Call list_layers first to get layer names and geometry join keys."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_layer_name": {
                        "type": "string",
                        "description": "Name of the layer to attach click actions to (from list_layers).",
                    },
                    "actions": {
                        "type": "array",
                        "description": "Ordered list of actions to execute on click.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": {
                                    "type": "string",
                                    "enum": ["filter", "show", "hide_self", "fly_to_bounds", "drilldown"],
                                    "description": (
                                        "filter: filter a target layer by a property matching the clicked feature. "
                                        "show: make a target layer visible. "
                                        "hide_self: hide the clicked layer. "
                                        "fly_to_bounds: zoom the map to the clicked feature's bounding box. "
                                        "drilldown: composite action — filter target layer + show target + hide source + zoom in."
                                    ),
                                },
                                "targetLayerName": {
                                    "type": "string",
                                    "description": "Name of the target layer (for filter and show actions).",
                                },
                                "filterProperty": {
                                    "type": "string",
                                    "description": "Geometry property on the TARGET layer to filter by (for filter action).",
                                },
                                "sourceProperty": {
                                    "type": "string",
                                    "description": "Geometry property on the SOURCE layer to read the filter value from (for filter action).",
                                },
                            },
                            "required": ["action"],
                        },
                    },
                },
                "required": ["source_layer_name", "actions"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_layer_visibility",
            "description": (
                "Toggle the visibility of a map layer on or off. "
                "Call list_layers first to get available layer IDs and names."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "layer_id": {"type": "integer", "description": "Layer ID from list_layers"},
                    "visible": {"type": "boolean", "description": "True to show the layer, False to hide it"},
                },
                "required": ["layer_id", "visible"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_description",
            "description": (
                "Update or create a description for a DuckDB table or column. "
                "Use this to persist metadata you discover about data — e.g. what a column "
                "represents, which columns are joinable between tables, or what a table contains. "
                "These descriptions are saved permanently and help you (and future conversations) "
                "understand the data without re-discovering it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "table_name": {
                        "type": "string",
                        "description": "Fully qualified table name (e.g. 'ext_myext.my_table')",
                    },
                    "description": {
                        "type": "string",
                        "description": "Description of the table (omit if only updating a column)",
                    },
                    "column_name": {
                        "type": "string",
                        "description": "Column to describe (omit if only updating the table)",
                    },
                    "column_description": {
                        "type": "string",
                        "description": "Description of the column",
                    },
                    "column_type": {
                        "type": "string",
                        "description": "Data type of the column (e.g. 'VARCHAR', 'INTEGER', 'DOUBLE')",
                    },
                    "is_joinable": {
                        "type": "boolean",
                        "description": "Whether this column can be used to join with another table",
                    },
                    "join_target_table": {
                        "type": "string",
                        "description": "If joinable, the target table name",
                    },
                    "join_target_column": {
                        "type": "string",
                        "description": "If joinable, the target column name",
                    },
                },
                "required": ["table_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_style_preference",
            "description": (
                "Save the user's default map-styling preferences so future layers "
                "match their taste. Use when the user expresses a styling preference "
                "(e.g. 'I prefer the plasma colormap', 'make bubbles more transparent', "
                "'use orange points by default'). Applied automatically when new "
                "layers are created. Partial updates are fine — set only what changed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "colormap": {
                        "type": "string",
                        "description": "Default colormap, e.g. 'viridis', 'plasma', 'coolwarm', 'rdylgn'.",
                    },
                    "opacity": {
                        "type": "number",
                        "description": "Default layer opacity, 0.0–1.0.",
                    },
                    "point_color": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Default RGBA color for point/bubble layers, e.g. [255,152,0,200].",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_memory",
            "description": (
                "Save a reusable artifact (chart, query, insight) to AI memory for future retrieval. "
                "Use this when you create something the user might want to reuse later, or when "
                "you discover an important insight worth remembering across conversations."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Short descriptive name (e.g. 'County demand by fuel type')",
                    },
                    "description": {
                        "type": "string",
                        "description": "Detailed description of what this memory contains and when to reuse it",
                    },
                    "memory_type": {
                        "type": "string",
                        "enum": ["chart", "query", "insight", "perspective_ref", "story_ref"],
                        "description": "Type of artifact being saved",
                    },
                    "content": {
                        "type": "object",
                        "description": "The artifact content (SQL string for queries, chart config for charts, free text for insights)",
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tags for searchability (e.g. ['demand', 'county', 'timeseries'])",
                    },
                },
                "required": ["name", "description", "memory_type", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_memory",
            "description": (
                "Search AI memory for previously saved artifacts (charts, queries, insights). "
                "Use this before creating something new — check if a similar artifact already exists."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search text to match against names, descriptions, and tags",
                    },
                    "memory_type": {
                        "type": "string",
                        "enum": ["chart", "query", "insight", "perspective_ref", "story_ref"],
                        "description": "Optional filter by memory type",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum results to return (default 10)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_artifacts",
            "description": (
                "Search across all stored artifacts — perspectives, stories, paintings, "
                "table descriptions, and AI memories. Use this to find existing work to "
                "reuse or build upon, or to answer questions about what's available."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search text to match against names and descriptions",
                    },
                    "artifact_types": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["perspective", "story", "painting", "table", "memory"],
                        },
                        "description": "Optional filter by artifact type(s). If omitted, searches all types.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum results to return (default 20)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_perspectives",
            "description": (
                "List all saved perspectives (multi-layer compositions) with their names "
                "and descriptions. Use search_artifacts for broader searches."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "Optional: filter by project ID"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_perspective",
            "description": (
                "Load and apply a saved perspective by ID, restoring its map view, "
                "layer styles, and chart configuration. The map and UI will update to "
                "reflect the perspective's saved state."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "perspective_id": {"type": "integer", "description": "Perspective ID from list_perspectives"},
                },
                "required": ["perspective_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_perspective",
            "description": (
                "Create a new perspective capturing the current map view state. "
                "If a perspective with the same name already exists, you must get "
                "explicit user confirmation before overwriting."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Name for the perspective"},
                    "description": {"type": "string", "description": "Description of what this perspective shows"},
                    "project_id": {"type": "integer", "description": "Optional project to scope to"},
                    "scenario_id": {"type": "integer", "description": "Optional scenario to scope to"},
                    "overwrite": {
                        "type": "boolean",
                        "description": "Set to true only after user explicitly confirms overwriting an existing perspective",
                    },
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_stories",
            "description": (
                "List all saved stories (guided analysis narratives) with their names, "
                "descriptions, and step counts."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "Optional: filter by project ID"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_story",
            "description": (
                "Start playing a saved story by ID. The UI will enter story playback mode, "
                "stepping through perspectives with transitions and narration."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "story_id": {"type": "integer", "description": "Story ID from list_stories"},
                },
                "required": ["story_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_scenarios",
            "description": (
                "List all available projects and their scenarios with names, descriptions, "
                "and extension associations. Use this to understand what data contexts "
                "are available before switching."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_scenario",
            "description": (
                "Switch the active project and scenario in the UI. This changes which "
                "data and layers are displayed on the map."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "extension": {"type": "string", "description": "Extension name"},
                    "project": {"type": "string", "description": "Project name"},
                    "scenario": {"type": "string", "description": "Scenario name"},
                },
                "required": ["extension", "project", "scenario"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_project_description",
            "description": (
                "Update the description of a project or scenario. Good descriptions "
                "help users and AI understand the purpose of each data context."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "Project ID to update"},
                    "description": {"type": "string", "description": "New description for the project"},
                    "scenario_id": {"type": "integer", "description": "Optional: scenario ID to update instead"},
                    "scenario_description": {"type": "string", "description": "New description for the scenario"},
                },
                "required": ["project_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_hover_chart",
            "description": (
                "Attach a dynamic chart to a map layer that appears when a user clicks or "
                "hovers a feature. The SQL template uses {property_name} placeholders that "
                "get filled with the clicked feature's properties. "
                "Example: \"SELECT * FROM ext_demo.demand WHERE county_fips = '{GEOID}'\""
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "layer_name": {
                        "type": "string",
                        "description": "Name of the layer to attach the chart to",
                    },
                    "sql_template": {
                        "type": "string",
                        "description": "SQL query with {property_name} placeholders for feature properties",
                    },
                    "chart_type": {
                        "type": "string",
                        "enum": ["bar", "line", "scatter", "pie", "stacked_bar", "stacked_area"],
                        "description": "Type of chart to create",
                    },
                    "x_column": {"type": "string", "description": "Column name for the x-axis"},
                    "y_column": {"type": "string", "description": "Column name for the y-axis"},
                    "title_template": {
                        "type": "string",
                        "description": "Chart title with {property_name} placeholders (e.g. 'Demand for {county_name}')",
                    },
                    "trigger": {
                        "type": "string",
                        "enum": ["click", "hover"],
                        "description": "Event trigger: click or hover (default: click)",
                    },
                    "color_column": {
                        "type": "string",
                        "description": "Optional column to group data by color",
                    },
                },
                "required": ["layer_name", "sql_template", "chart_type", "x_column", "y_column"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_category_colors",
            "description": (
                "Set the color palette for categorical data displayed on charts and maps. "
                "Each category gets a hex color. Use this when the user asks to generate, "
                "adjust, or suggest a color palette. Consider grouping related categories "
                "with similar hues (e.g., subcategories of the same parent should share a "
                "hue family but vary in lightness/saturation)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "colors": {
                        "type": "object",
                        "description": (
                            "Mapping of category name → hex color string. "
                            "Example: {\"Solar\": \"#FFD700\", \"Wind\": \"#87CEEB\", \"Coal\": \"#4A4A4A\"}"
                        ),
                        "additionalProperties": {"type": "string"},
                    },
                    "palette_name": {
                        "type": "string",
                        "description": (
                            "Name to save this palette under for later reuse. "
                            "Choose a short descriptive name like 'Energy Status' or 'Data Center Stages'."
                        ),
                    },
                },
                "required": ["colors", "palette_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fit_map_to_bounds",
            "description": (
                "Move the map to frame a geographic bounding box — the best way to "
                "'zoom into' a state, region, or country. Provide the west/south/east/"
                "north longitude/latitude edges; the map flies to fit them. Use your "
                "knowledge of geography for the bounds (e.g. Texas is roughly "
                "west=-106.6, south=25.8, east=-93.5, north=36.5). Applies to the live "
                "map and any synced displays."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "west": {"type": "number", "description": "Western edge longitude"},
                    "south": {"type": "number", "description": "Southern edge latitude"},
                    "east": {"type": "number", "description": "Eastern edge longitude"},
                    "north": {"type": "number", "description": "Northern edge latitude"},
                },
                "required": ["west", "south", "east", "north"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pan_map",
            "description": (
                "Pan and zoom the map to a specific latitude/longitude center. Use "
                "fit_map_to_bounds instead when framing an area like a state. Applies "
                "to the live map and any synced displays."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "latitude": {"type": "number", "description": "Center latitude"},
                    "longitude": {"type": "number", "description": "Center longitude"},
                    "zoom": {"type": "number", "description": "Zoom level (0-20); ~5 for a state, ~10 for a city"},
                },
                "required": ["latitude", "longitude"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_basemap",
            "description": (
                "Change the map's base layer (background tiles). Options: "
                "'dark-matter' (dark, minimal — the default), 'positron' (light, minimal), "
                "'voyager' (light with more labels/detail), 'satellite' (Esri aerial "
                "imagery). Use 'satellite' when the user wants aerial/photographic context "
                "(e.g. 'satellite view' or 'show the imagery'). Applies to the live map and "
                "any synced displays."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "basemap": {
                        "type": "string",
                        "enum": ["dark-matter", "positron", "voyager", "satellite"],
                        "description": "The base layer to switch to.",
                    },
                },
                "required": ["basemap"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "zoom_map",
            "description": (
                "Zoom the map in or out by a RELATIVE amount, keeping the current center. "
                "Each +1 roughly doubles the scale (zooms in); each -1 halves it (zooms out). "
                "Use for 'zoom in a little' (delta ~1), 'zoom in' (~2), 'zoom out' (~-2). To "
                "jump to a specific place instead, use fit_map_to_bounds or pan_map. Applies "
                "to the live map and any synced displays."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "delta": {
                        "type": "number",
                        "description": "Relative zoom change; positive = closer, negative = further.",
                    },
                },
                "required": ["delta"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_clock_year",
            "description": (
                "Set the animation clock to a specific year (or time index) and pause "
                "playback. Use when the user asks to jump the map/charts to a year, "
                "e.g. 'show 2030'. Applies to the live view and any synced displays."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "year": {"type": "integer", "description": "Year (or time index) to set the clock to"},
                },
                "required": ["year"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "close_charts",
            "description": "Close all open AI/extension chart panels. Applies to the live view and any synced displays.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "arrange_charts",
            "description": (
                "Re-anchor every open chart panel to one dock so they tile together. "
                "Applies to the live view and any synced displays."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "anchor": {
                        "type": "string",
                        "enum": ["right", "left", "bottom", "floating", "tray"],
                        "description": "Where to dock the charts. Default 'right'.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_charts",
            "description": (
                "List the pre-configured charts that installed extensions provide "
                "(e.g. SEDS 'US total energy', 'US fuel mix', per-state history). "
                "PREFER these over create_chart when one matches what the user wants: "
                "they are already correctly built (proper labels, Plotly, reactive to "
                "the year/control sliders, draggable/resizable). Each result has an "
                "extension, chart_name, display_name, and scope ('scenario' = system-"
                "wide, open directly; 'entity' = needs an entity_id like a state)."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_chart",
            "description": (
                "Open a pre-configured extension chart (from list_charts) as a "
                "draggable/resizable panel. Reactive to the year/control sliders. Use "
                "this instead of create_chart whenever a pre-configured chart matches "
                "the request; fall back to create_chart only for custom views no "
                "pre-configured chart covers."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_name": {"type": "string", "description": "Chart name from list_charts"},
                    "extension": {"type": "string", "description": "Extension that owns the chart (from list_charts)"},
                    "entity_id": {
                        "type": "string",
                        "description": (
                            "Required for scope='entity' charts: the entity's id, e.g. a "
                            "state FIPS code ('48' = Texas). Omit for scope='scenario' "
                            "charts. If you don't know the id, query the data/geometry first."
                        ),
                    },
                    "anchor": {
                        "type": "string",
                        "enum": ["floating", "right", "left", "bottom", "tray"],
                        "description": (
                            "Where to place the panel. OMIT unless the user asks for a "
                            "specific placement — the app then puts the chart where its "
                            "own charts go (normally the chart tray)."
                        ),
                    },
                },
                "required": ["chart_name"],
            },
        },
    },
]

