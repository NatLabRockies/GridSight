"""
ExtensionRegistry — discovers, loads, and manages GridSight extensions.
"""

from __future__ import annotations

import importlib.metadata
import logging
from typing import Iterator

from gridsight.extensions import (
    ExtensionManifest,
    GridSightExtensionBase,
    ExtensionContext,
)

logger = logging.getLogger(__name__)

ENTRY_POINT_GROUP = "gridsight.extensions"


class ExtensionRegistry:
    """Central registry for all discovered extensions."""

    def __init__(self) -> None:
        self._extensions: dict[str, GridSightExtensionBase] = {}
        self._manifests: dict[str, ExtensionManifest] = {}

    # -- Discovery & lifecycle --

    def discover_and_load(self, context: ExtensionContext) -> None:
        """Discover extensions via entry_points and initialize them."""
        eps = importlib.metadata.entry_points()
        # Python 3.12+: eps is a SelectableGroups, filter by group
        group_eps = eps.select(group=ENTRY_POINT_GROUP)

        for ep in group_eps:
            try:
                ext_class = ep.load()
                ext: GridSightExtensionBase = ext_class()
                manifest = ext.get_manifest()

                if manifest.name in self._extensions:
                    logger.warning(
                        "Duplicate extension name %r from %s — skipping",
                        manifest.name,
                        ep.value,
                    )
                    continue

                ext.on_startup(context)
                self._extensions[manifest.name] = ext
                self._manifests[manifest.name] = manifest
                logger.info(
                    "Loaded extension: %s v%s (%s)",
                    manifest.display_name,
                    manifest.version,
                    manifest.name,
                )
            except Exception:
                logger.exception("Failed to load extension from %s", ep.value)

        logger.info("Extension discovery complete: %d loaded", len(self._extensions))

    def register(self, ext: GridSightExtensionBase, context: ExtensionContext) -> None:
        """Register a directly-instantiated extension (no entry_point).

        Used for built-in demo extensions that ship inside the server
        package so the app has *something* to show before any external
        extension is installed.
        """
        manifest = ext.get_manifest()
        if manifest.name in self._extensions:
            logger.warning("Extension %r already registered; ignoring", manifest.name)
            return
        ext.on_startup(context)
        self._extensions[manifest.name] = ext
        self._manifests[manifest.name] = manifest
        logger.info(
            "Registered built-in extension: %s v%s (%s)",
            manifest.display_name, manifest.version, manifest.name,
        )

    def shutdown_all(self) -> None:
        for name, ext in self._extensions.items():
            try:
                ext.on_shutdown()
            except Exception:
                logger.exception("Error shutting down extension %s", name)

    # -- Accessors --

    def get(self, name: str) -> GridSightExtensionBase | None:
        return self._extensions.get(name)

    def get_manifest(self, name: str) -> ExtensionManifest | None:
        return self._manifests.get(name)

    def list_manifests(self) -> list[ExtensionManifest]:
        return list(self._manifests.values())

    def items(self) -> Iterator[tuple[str, GridSightExtensionBase]]:
        yield from self._extensions.items()

    def __len__(self) -> int:
        return len(self._extensions)
