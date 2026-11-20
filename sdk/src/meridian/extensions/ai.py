"""
AI schema types for extension-provided context to the chat system.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class AITableSchema:
    """Describes a DuckDB table for AI context."""

    table_name: str
    description: str
    columns: list[dict] = field(default_factory=list)
    # Each dict: {"name": str, "type": str, "description": str}
    example_queries: list[str] = field(default_factory=list)


@dataclass
class AIControlSchema:
    """Describes available controls for AI context."""

    control_name: str
    description: str
    value_type: str  # "float", "int", "string", "bool"
    value_range: str | None = None  # human-readable, e.g. "0.0 - 1.0"


@dataclass
class AIDatasetDescription:
    """Rich description of a dataset, including join relationships."""

    dataset_name: str
    description: str
    joinable_columns: list[dict] = field(default_factory=list)
    # Each dict: {"column": str, "target_table": str, "target_column": str, "description": str}
    key_columns: list[str] = field(default_factory=list)
    # Human-readable identifier columns (e.g. county_name, state_abbr)


@dataclass
class AISchema:
    """Full AI context an extension provides."""

    description: str  # what this extension does, for the system prompt
    tables: list[AITableSchema] = field(default_factory=list)
    controls: list[AIControlSchema] = field(default_factory=list)
    example_prompts: list[str] = field(default_factory=list)
    dataset_descriptions: list[AIDatasetDescription] = field(default_factory=list)
    global_description: str = ""  # high-level extension overview
    plotting_hints: list[str] = field(default_factory=list)  # suggested chart types/approaches
