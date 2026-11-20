"""Internal startup/sync helpers shared by the lifespan and extension routes.

These functions are not endpoints — they're invoked from the lifespan
during startup and (in the case of `_sync_extension_data`) from the
extension upload route to refresh the ORM after a new scenario lands.
"""
from __future__ import annotations

import json
import logging

import db
from lib.extensions.registry import ExtensionRegistry
from models.orm import (
    CategoryMap, Dataset, GeometryFile, Layer, LayerDataset, LayerStyleMapping,
    Project, Scenario,
)

logger = logging.getLogger("gridsight")


def sync_extension_data(registry: ExtensionRegistry):
    """Sync extension-provided projects, scenarios, geometries, and datasets into the ORM."""
    session = db.get_session()
    try:
        for ext_name, ext in registry.items():
            manifest = registry.get_manifest(ext_name)
            if not manifest:
                continue

            for ext_proj in ext.list_projects():
                proj = (
                    session.query(Project)
                    .filter(Project.name == ext_proj.name, Project.extension_name == ext_name)
                    .first()
                )
                if not proj:
                    proj = Project(
                        name=ext_proj.name,
                        owner="extension",
                        display_name=ext_proj.display_name,
                        description=ext_proj.description,
                        extension_name=ext_name,
                    )
                    session.add(proj)
                    session.flush()

                from models.orm import ProjectTag
                for tag in getattr(ext_proj, 'tags', []) or []:
                    existing_tag = session.query(ProjectTag).filter(
                        ProjectTag.project_id == proj.id, ProjectTag.tag == tag
                    ).first()
                    if not existing_tag:
                        session.add(ProjectTag(project_id=proj.id, tag=tag))

                for ext_scen in ext.list_scenarios(ext_proj.name):
                    scen = (
                        session.query(Scenario)
                        .filter(
                            Scenario.project_id == proj.id,
                            Scenario.name == ext_scen.name,
                        )
                        .first()
                    )
                    if not scen:
                        scen = Scenario(
                            project_id=proj.id,
                            name=ext_scen.name,
                            display_name=ext_scen.display_name,
                            description=ext_scen.description,
                        )
                        session.add(scen)
                        session.flush()

                    for geo_desc in ext.list_geometries(ext_proj.name, ext_scen.name):
                        existing = (
                            session.query(GeometryFile)
                            .filter(
                                GeometryFile.extension_name == ext_name,
                                GeometryFile.extension_ref == geo_desc.name,
                            )
                            .first()
                        )
                        if not existing:
                            geo = GeometryFile(
                                name=geo_desc.display_name,
                                content_hash="",
                                format=geo_desc.format,
                                join_key=geo_desc.join_key,
                                description=geo_desc.description,
                                extension_name=ext_name,
                                extension_ref=geo_desc.name,
                                scope="global" if getattr(geo_desc, "shared", False) else "extension",
                            )
                            session.add(geo)

                    for ds_desc in ext.list_datasets(ext_proj.name, ext_scen.name):
                        existing = (
                            session.query(Dataset)
                            .filter(
                                Dataset.extension_name == ext_name,
                                Dataset.extension_ref == ds_desc.name,
                            )
                            .first()
                        )
                        ds_scope = "global" if getattr(ds_desc, "shared", False) else "extension"
                        if existing:
                            existing.name = ds_desc.display_name
                            existing.format = ds_desc.format
                            existing.join_key = ds_desc.join_key
                            existing.timestamp_col = ds_desc.timestamp_col
                            existing.description = ds_desc.description
                            existing.scope = ds_scope
                        else:
                            session.add(Dataset(
                                name=ds_desc.display_name,
                                content_hash="",
                                format=ds_desc.format,
                                join_key=ds_desc.join_key,
                                timestamp_col=ds_desc.timestamp_col,
                                description=ds_desc.description,
                                extension_name=ext_name,
                                extension_ref=ds_desc.name,
                                scope=ds_scope,
                            ))

                    for cm_desc in ext.list_category_maps(ext_proj.name, ext_scen.name):
                        existing = (
                            session.query(CategoryMap)
                            .filter(
                                CategoryMap.extension_name == ext_name,
                                CategoryMap.extension_ref == cm_desc.name,
                            )
                            .first()
                        )
                        if not existing:
                            cm = CategoryMap(
                                name=cm_desc.name,
                                display_name=cm_desc.display_name,
                                description=cm_desc.description,
                                entity_column=cm_desc.entity_column,
                                category_column=cm_desc.category_column,
                                colors_json=json.dumps(cm_desc.colors) if cm_desc.colors else None,
                                extension_name=ext_name,
                                extension_ref=cm_desc.name,
                            )
                            session.add(cm)

        session.commit()

        for ext_name, ext in registry.items():
            for ext_proj in ext.list_projects():
                proj = (
                    session.query(Project)
                    .filter(Project.name == ext_proj.name, Project.extension_name == ext_name)
                    .first()
                )
                if not proj:
                    continue
                for ext_scen in ext.list_scenarios(ext_proj.name):
                    scen = (
                        session.query(Scenario)
                        .filter(Scenario.project_id == proj.id, Scenario.name == ext_scen.name)
                        .first()
                    )
                    if not scen:
                        continue

                    layer_defs = ext.list_layers(ext_proj.name, ext_scen.name)
                    for layer_def in layer_defs:
                        geo_ref = f"__layer_geo__{layer_def.name}"
                        geo = (
                            session.query(GeometryFile)
                            .filter(
                                GeometryFile.extension_name == ext_name,
                                GeometryFile.extension_ref == geo_ref,
                            )
                            .first()
                        )
                        if not geo:
                            geo = GeometryFile(
                                name=f"{layer_def.display_name} Geometry",
                                content_hash="",
                                format="geojson",
                                join_key=layer_def.geom_join_key,
                                extension_name=ext_name,
                                extension_ref=geo_ref,
                            )
                            session.add(geo)
                            session.flush()

                        ds = None
                        if layer_def.dataset_ref:
                            ds = (
                                session.query(Dataset)
                                .filter(
                                    Dataset.extension_name == ext_name,
                                    Dataset.extension_ref == layer_def.dataset_ref,
                                )
                                .first()
                            )

                        layer = (
                            session.query(Layer)
                            .filter(Layer.scenario_id == scen.id, Layer.name == layer_def.name)
                            .first()
                        )
                        if layer:
                            layer.geometry_id = geo.id
                            layer.deck_layer_type = layer_def.deck_layer_type
                            layer.display_name = layer_def.display_name
                            layer.source_type = "extension"
                            layer.source_extension = ext_name
                            layer.default_style_json = (
                                json.dumps(layer_def.default_style)
                                if layer_def.default_style
                                else None
                            )
                        else:
                            layer = Layer(
                                scenario_id=scen.id,
                                geometry_id=geo.id,
                                name=layer_def.name,
                                deck_layer_type=layer_def.deck_layer_type,
                                display_name=layer_def.display_name,
                                source_type="extension",
                                source_extension=ext_name,
                                default_style_json=(
                                    json.dumps(layer_def.default_style)
                                    if layer_def.default_style
                                    else None
                                ),
                            )
                            session.add(layer)
                            logging.info("Created layer '%s' for %s/%s", layer_def.name, proj.name, scen.name)
                        session.flush()

                        for old_ld in session.query(LayerDataset).filter(LayerDataset.layer_id == layer.id).all():
                            session.query(LayerStyleMapping).filter(LayerStyleMapping.layer_dataset_id == old_ld.id).delete()
                            session.delete(old_ld)
                        session.flush()

                        ld_by_role: dict[str, LayerDataset] = {}
                        if ds:
                            ld = LayerDataset(
                                layer_id=layer.id,
                                dataset_id=ds.id,
                                geom_join_key=layer_def.geom_join_key,
                                data_join_key=layer_def.data_join_key,
                                role="primary",
                            )
                            session.add(ld)
                            session.flush()
                            ld_by_role["primary"] = ld

                        for extra in (layer_def.dataset_refs or []):
                            extra_ds = (
                                session.query(Dataset)
                                .filter(
                                    Dataset.extension_name == ext_name,
                                    Dataset.extension_ref == extra.get("ref"),
                                )
                                .first()
                            )
                            if extra_ds:
                                extra_role = extra.get("role", extra.get("ref", ""))
                                extra_ld = LayerDataset(
                                    layer_id=layer.id,
                                    dataset_id=extra_ds.id,
                                    geom_join_key=layer_def.geom_join_key,
                                    data_join_key=extra.get("join_key") or layer_def.data_join_key,
                                    role=extra_role,
                                )
                                session.add(extra_ld)
                                session.flush()
                                ld_by_role[extra_role] = extra_ld

                        for sm in layer_def.style_mappings:
                            if not ld_by_role:
                                continue
                            sm_role = sm.get("dataset_role", "primary")
                            target_ld = ld_by_role.get(sm_role) or next(iter(ld_by_role.values()))
                            mapping = LayerStyleMapping(
                                layer_id=layer.id,
                                layer_dataset_id=target_ld.id,
                                visual_property=sm.get("visual_property", "getFillColor"),
                                column=sm.get("column", ""),
                                colormap=sm.get("colormap"),
                                scale_type=sm.get("scale_type"),
                                domain_min=sm.get("domain_min"),
                                domain_max=sm.get("domain_max"),
                                shared_legend_group=sm.get("shared_legend_group"),
                            )
                            cm_ref = sm.get("category_map_ref")
                            if cm_ref:
                                cm = (
                                    session.query(CategoryMap)
                                    .filter(
                                        CategoryMap.extension_name == ext_name,
                                        CategoryMap.extension_ref == cm_ref,
                                    )
                                    .first()
                                )
                                if cm:
                                    mapping.category_map_id = cm.id
                            session.add(mapping)

        session.commit()

        for ext_name, ext in registry.items():
            default_layers = ext.list_default_layers()
            logging.info("Extension %s returned %d default layers", ext_name, len(default_layers))
            for layer_cfg in default_layers:
                logging.info(
                    "  Layer %s: geometry_ref=%s dataset_ref=%s",
                    layer_cfg.name, layer_cfg.geometry_ref, layer_cfg.dataset_ref,
                )
                geo = (
                    session.query(GeometryFile)
                    .filter(
                        GeometryFile.extension_name == ext_name,
                        GeometryFile.extension_ref == layer_cfg.geometry_ref,
                    )
                    .first()
                )
                if not geo:
                    logging.warning(
                        "Default layer %s references unknown geometry %s",
                        layer_cfg.name, layer_cfg.geometry_ref,
                    )
                    continue

                ds = None
                if layer_cfg.dataset_ref:
                    ds = (
                        session.query(Dataset)
                        .filter(
                            Dataset.extension_name == ext_name,
                            Dataset.extension_ref == layer_cfg.dataset_ref,
                        )
                        .first()
                    )

                ext_projects = (
                    session.query(Project)
                    .filter(Project.extension_name == ext_name)
                    .all()
                )
                for proj in ext_projects:
                    scenarios = session.query(Scenario).filter(Scenario.project_id == proj.id).all()
                    for scen in scenarios:
                        existing = (
                            session.query(Layer)
                            .filter(
                                Layer.scenario_id == scen.id,
                                Layer.name == layer_cfg.name,
                            )
                            .first()
                        )
                        if existing:
                            continue

                        layer = Layer(
                            scenario_id=scen.id,
                            geometry_id=geo.id,
                            name=layer_cfg.name,
                            deck_layer_type=layer_cfg.deck_layer_type,
                            display_name=layer_cfg.display_name,
                            default_style_json=(
                                json.dumps(layer_cfg.default_style)
                                if getattr(layer_cfg, "default_style", None)
                                else None
                            ),
                        )
                        session.add(layer)
                        session.flush()

                        ld = None
                        if ds:
                            ld = LayerDataset(
                                layer_id=layer.id,
                                dataset_id=ds.id,
                                geom_join_key=layer_cfg.geom_join_key,
                                data_join_key=layer_cfg.data_join_key,
                            )
                            session.add(ld)
                            session.flush()

                        for sm in layer_cfg.style_mappings:
                            if not ld:
                                continue
                            mapping = LayerStyleMapping(
                                layer_id=layer.id,
                                layer_dataset_id=ld.id,
                                visual_property=sm.get("visual_property", "getFillColor"),
                                column=sm.get("column", ""),
                                colormap=sm.get("colormap"),
                                scale_type=sm.get("scale_type"),
                                domain_min=sm.get("domain_min"),
                                domain_max=sm.get("domain_max"),
                                shared_legend_group=sm.get("shared_legend_group"),
                            )
                            cm_ref = sm.get("category_map_ref")
                            if cm_ref:
                                cm = (
                                    session.query(CategoryMap)
                                    .filter(
                                        CategoryMap.extension_name == ext_name,
                                        CategoryMap.extension_ref == cm_ref,
                                    )
                                    .first()
                                )
                                if cm:
                                    mapping.category_map_id = cm.id
                            session.add(mapping)

                        logging.info(
                            "Created default layer '%s' for %s/%s",
                            layer_cfg.name, proj.name, scen.name,
                        )

        session.commit()
        db.save_to_disk()
    except Exception:
        session.rollback()
        logging.exception("Failed to sync extension data into ORM")
    finally:
        session.close()


def seed_metadata_descriptions(registry: ExtensionRegistry):
    """Seed table/column descriptions from extension AISchema on startup."""
    from models.orm import TableDescription, ColumnDescription

    session = db.get_session()
    try:
        for ext_name, ext in registry.items():
            ai_schema = ext.get_ai_schema()
            if not ai_schema:
                continue
            for table_schema in ai_schema.tables:
                existing = session.query(TableDescription).filter(
                    TableDescription.table_name == table_schema.table_name,
                ).first()
                if not existing:
                    td = TableDescription(
                        table_name=table_schema.table_name,
                        description=table_schema.description,
                        source="extension",
                        extension_name=ext_name,
                    )
                    session.add(td)
                    session.flush()
                    for col in table_schema.columns:
                        cd = ColumnDescription(
                            table_description_id=td.id,
                            column_name=col.get("name", ""),
                            description=col.get("description", ""),
                            data_type=col.get("type", ""),
                            source="extension",
                        )
                        session.add(cd)
        session.commit()
        db.save_to_disk()
    except Exception:
        session.rollback()
        logger.debug("Could not seed metadata descriptions", exc_info=True)
    finally:
        session.close()
