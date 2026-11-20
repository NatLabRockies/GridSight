"""
LineageManager — core service for tracking data lineage and provenance.

Every data source, transformation, visualization config, and rendered output
is recorded as a node in a directed acyclic graph (DAG). Edges encode the
derivation relationships between nodes. The LineageManager is the single
entry point for creating and querying lineage — extensions and AI agents
interact with it indirectly through instrumented endpoints.
"""

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Optional

from models.orm import (
    LineageEdge,
    LineageNode,
    LineageReview,
    LineageReviewRequest,
    Perspective,
    PerspectiveLineage,
    User,
)

logger = logging.getLogger("gridsight.lineage")


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class LineageNodeType(str, Enum):
    DATA_SOURCE = "data_source"
    TRANSFORM = "transform"
    RESULT = "result"
    VIZ_CONFIG = "viz_config"
    OUTPUT = "output"


class TransformKind(str, Enum):
    SQL_MANUAL = "sql_manual"
    SQL_AI = "sql_ai"
    INPUT_CONTROL = "input_control"
    DATA_CONTROL = "data_control"


class ReviewStatus(str, Enum):
    UNREVIEWED = "unreviewed"
    AI_REVIEWED = "ai_reviewed"
    HUMAN_REVIEWED = "human_reviewed"
    AI_AND_HUMAN_REVIEWED = "ai_and_human_reviewed"


class ReviewerType(str, Enum):
    AI = "ai"
    HUMAN = "human"


class CreatorType(str, Enum):
    USER = "user"
    AI = "ai"
    SYSTEM = "system"


# ---------------------------------------------------------------------------
# Return types
# ---------------------------------------------------------------------------

@dataclass
class LineageDAG:
    """Serializable DAG subgraph for API responses."""
    nodes: list[dict]
    edges: list[dict]


# ---------------------------------------------------------------------------
# LineageManager
# ---------------------------------------------------------------------------

class LineageManager:

    def __init__(self, get_session: Callable):
        self._get_session = get_session

    # -- helpers --

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _content_hash(self, content: dict) -> str:
        raw = json.dumps(content, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()

    def _serialize_node(self, node: LineageNode) -> dict:
        reviews = []
        for r in (node.reviews or []):
            reviews.append({
                "id": r.id,
                "reviewer_type": r.reviewer_type,
                "reviewer_user_id": r.reviewer_user_id,
                "ai_model": r.ai_model,
                "status": r.status,
                "comment": r.comment,
                "created_at": r.created_at,
            })
        pending_requests = sum(
            1 for rr in (node.review_requests or []) if rr.status == "pending"
        )
        return {
            "id": node.id,
            "node_type": node.node_type,
            "transform_kind": node.transform_kind,
            "content_json": node.content_json,
            "content_hash": node.content_hash,
            "creator_type": node.creator_type,
            "creator_user_id": node.creator_user_id,
            "ai_model": node.ai_model,
            "ai_conversation_id": node.ai_conversation_id,
            "review_status": node.review_status,
            "version": node.version,
            "created_at": node.created_at,
            "updated_at": node.updated_at,
            "project_id": node.project_id,
            "scenario_id": node.scenario_id,
            "extension_name": node.extension_name,
            "label": node.label,
            "reviews": reviews,
            "pending_requests": pending_requests,
        }

    def _serialize_edge(self, edge: LineageEdge) -> dict:
        return {
            "id": edge.id,
            "parent_node_id": edge.parent_node_id,
            "child_node_id": edge.child_node_id,
            "edge_type": edge.edge_type,
            "created_at": edge.created_at,
        }

    def _create_node(
        self,
        session,
        *,
        node_type: str,
        content: dict,
        creator_type: str = "system",
        transform_kind: str | None = None,
        creator_user_id: int | None = None,
        ai_model: str | None = None,
        ai_conversation_id: str | None = None,
        project_id: int | None = None,
        scenario_id: int | None = None,
        extension_name: str | None = None,
        label: str | None = None,
    ) -> LineageNode:
        now = self._now()
        content_json = json.dumps(content, default=str)
        node = LineageNode(
            node_type=node_type,
            transform_kind=transform_kind,
            content_json=content_json,
            content_hash=self._content_hash(content),
            creator_type=creator_type,
            creator_user_id=creator_user_id,
            ai_model=ai_model,
            ai_conversation_id=ai_conversation_id,
            review_status=(
                ReviewStatus.AI_REVIEWED.value
                if creator_type == CreatorType.AI.value
                else ReviewStatus.UNREVIEWED.value
            ),
            version=1,
            created_at=now,
            updated_at=now,
            project_id=project_id,
            scenario_id=scenario_id,
            extension_name=extension_name,
            label=label,
        )
        session.add(node)
        session.flush()  # populate node.id
        return node

    def _detach(self, session, obj):
        """Refresh and expunge an ORM object so it remains usable after session.close()."""
        session.refresh(obj)
        session.expunge(obj)
        return obj

    def _add_edges(
        self,
        session,
        *,
        child_node_id: int,
        parent_node_ids: list[int],
        edge_type: str = "derives_from",
    ):
        now = self._now()
        for parent_id in parent_node_ids:
            edge = LineageEdge(
                parent_node_id=parent_id,
                child_node_id=child_node_id,
                edge_type=edge_type,
                created_at=now,
            )
            session.add(edge)

    # -----------------------------------------------------------------------
    # Node creation
    # -----------------------------------------------------------------------

    def record_data_source(
        self,
        *,
        source_type: str,
        table_name: str,
        extension_name: str | None = None,
        extension_ref: str | None = None,
        columns: list[dict] | None = None,
        project_id: int | None = None,
        scenario_id: int | None = None,
        creator_user_id: int | None = None,
    ) -> LineageNode:
        session = self._get_session()
        try:
            # Dedup: don't re-create if already tracked
            existing = (
                session.query(LineageNode)
                .filter(
                    LineageNode.node_type == LineageNodeType.DATA_SOURCE.value,
                    LineageNode.extension_name == extension_name,
                    LineageNode.label == table_name,
                )
                .first()
            )
            if existing:
                self._detach(session, existing)
                return existing

            content = {
                "source_type": source_type,
                "table_name": table_name,
                "extension_name": extension_name,
                "extension_ref": extension_ref,
                "columns": columns,
            }
            node = self._create_node(
                session,
                node_type=LineageNodeType.DATA_SOURCE.value,
                content=content,
                creator_type=CreatorType.SYSTEM.value,
                creator_user_id=creator_user_id,
                extension_name=extension_name,
                project_id=project_id,
                scenario_id=scenario_id,
                label=table_name,
            )
            session.commit()
            self._detach(session, node)
            logger.info("Recorded DATA_SOURCE: %s", table_name)
            return node
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def record_transform(
        self,
        *,
        kind: TransformKind,
        content: dict,
        parent_node_ids: list[int] | None = None,
        creator_type: CreatorType = CreatorType.USER,
        creator_user_id: int | None = None,
        ai_model: str | None = None,
        ai_conversation_id: str | None = None,
        project_id: int | None = None,
        scenario_id: int | None = None,
        extension_name: str | None = None,
        label: str | None = None,
    ) -> LineageNode:
        session = self._get_session()
        try:
            node = self._create_node(
                session,
                node_type=LineageNodeType.TRANSFORM.value,
                transform_kind=kind.value,
                content=content,
                creator_type=creator_type.value,
                creator_user_id=creator_user_id,
                ai_model=ai_model,
                ai_conversation_id=ai_conversation_id,
                project_id=project_id,
                scenario_id=scenario_id,
                extension_name=extension_name,
                label=label,
            )
            if parent_node_ids:
                self._add_edges(
                    session,
                    child_node_id=node.id,
                    parent_node_ids=parent_node_ids,
                )
            session.commit()
            self._detach(session, node)
            logger.info("Recorded TRANSFORM (%s): %s", kind.value, label)
            return node
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def record_result(
        self,
        *,
        content: dict,
        parent_node_ids: list[int] | None = None,
        creator_type: CreatorType = CreatorType.SYSTEM,
        project_id: int | None = None,
        scenario_id: int | None = None,
        label: str | None = None,
    ) -> LineageNode:
        session = self._get_session()
        try:
            node = self._create_node(
                session,
                node_type=LineageNodeType.RESULT.value,
                content=content,
                creator_type=creator_type.value,
                project_id=project_id,
                scenario_id=scenario_id,
                label=label,
            )
            if parent_node_ids:
                self._add_edges(
                    session,
                    child_node_id=node.id,
                    parent_node_ids=parent_node_ids,
                )
            session.commit()
            self._detach(session, node)
            return node
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def record_viz_config(
        self,
        *,
        content: dict,
        parent_node_ids: list[int] | None = None,
        creator_type: CreatorType = CreatorType.USER,
        creator_user_id: int | None = None,
        tier: int = 1,
        label: str | None = None,
    ) -> LineageNode:
        content["tier"] = tier
        session = self._get_session()
        try:
            node = self._create_node(
                session,
                node_type=LineageNodeType.VIZ_CONFIG.value,
                content=content,
                creator_type=creator_type.value,
                creator_user_id=creator_user_id,
                label=label or f"Viz config (tier {tier})",
            )
            if parent_node_ids:
                self._add_edges(
                    session,
                    child_node_id=node.id,
                    parent_node_ids=parent_node_ids,
                    edge_type="configured_by",
                )
            session.commit()
            self._detach(session, node)
            return node
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def record_output(
        self,
        *,
        content: dict,
        parent_node_ids: list[int] | None = None,
        perspective_id: int,
        creator_type: CreatorType = CreatorType.USER,
        creator_user_id: int | None = None,
        label: str | None = None,
    ) -> LineageNode:
        session = self._get_session()
        try:
            node = self._create_node(
                session,
                node_type=LineageNodeType.OUTPUT.value,
                content=content,
                creator_type=creator_type.value,
                creator_user_id=creator_user_id,
                label=label,
            )
            if parent_node_ids:
                self._add_edges(
                    session,
                    child_node_id=node.id,
                    parent_node_ids=parent_node_ids,
                    edge_type="renders",
                )
            # Link to perspective
            pl = PerspectiveLineage(
                perspective_id=perspective_id,
                lineage_node_id=node.id,
                role="root_output",
            )
            session.add(pl)
            session.commit()
            self._detach(session, node)
            logger.info("Recorded OUTPUT for perspective %d", perspective_id)
            return node
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    # -----------------------------------------------------------------------
    # DAG queries
    # -----------------------------------------------------------------------

    def get_node(self, node_id: int) -> dict | None:
        session = self._get_session()
        try:
            node = session.query(LineageNode).filter(LineageNode.id == node_id).first()
            if not node:
                return None
            return self._serialize_node(node)
        finally:
            session.close()

    def get_dag_for_perspective(self, perspective_id: int) -> LineageDAG:
        session = self._get_session()
        try:
            # Find all lineage nodes linked to this perspective
            links = (
                session.query(PerspectiveLineage)
                .filter(PerspectiveLineage.perspective_id == perspective_id)
                .all()
            )
            root_ids = [link.lineage_node_id for link in links]
            if not root_ids:
                return LineageDAG(nodes=[], edges=[])

            # Walk ancestors from root output nodes
            visited_ids = set()
            queue = list(root_ids)
            while queue:
                current_id = queue.pop(0)
                if current_id in visited_ids:
                    continue
                visited_ids.add(current_id)
                parent_edges = (
                    session.query(LineageEdge)
                    .filter(LineageEdge.child_node_id == current_id)
                    .all()
                )
                for edge in parent_edges:
                    queue.append(edge.parent_node_id)

            # Fetch all nodes and edges
            nodes = (
                session.query(LineageNode)
                .filter(LineageNode.id.in_(visited_ids))
                .all()
            )
            edges = (
                session.query(LineageEdge)
                .filter(
                    LineageEdge.parent_node_id.in_(visited_ids),
                    LineageEdge.child_node_id.in_(visited_ids),
                )
                .all()
            )
            return LineageDAG(
                nodes=[self._serialize_node(n) for n in nodes],
                edges=[self._serialize_edge(e) for e in edges],
            )
        finally:
            session.close()

    def get_dag_for_node(self, node_id: int, depth: int = -1) -> LineageDAG:
        session = self._get_session()
        try:
            visited_ids = set()
            queue = [(node_id, 0)]
            while queue:
                current_id, current_depth = queue.pop(0)
                if current_id in visited_ids:
                    continue
                if depth >= 0 and current_depth > depth:
                    continue
                visited_ids.add(current_id)
                parent_edges = (
                    session.query(LineageEdge)
                    .filter(LineageEdge.child_node_id == current_id)
                    .all()
                )
                for edge in parent_edges:
                    queue.append((edge.parent_node_id, current_depth + 1))

            nodes = (
                session.query(LineageNode)
                .filter(LineageNode.id.in_(visited_ids))
                .all()
            )
            edges = (
                session.query(LineageEdge)
                .filter(
                    LineageEdge.parent_node_id.in_(visited_ids),
                    LineageEdge.child_node_id.in_(visited_ids),
                )
                .all()
            )
            return LineageDAG(
                nodes=[self._serialize_node(n) for n in nodes],
                edges=[self._serialize_edge(e) for e in edges],
            )
        finally:
            session.close()

    def get_ancestors(self, node_id: int) -> list[dict]:
        dag = self.get_dag_for_node(node_id)
        return dag.nodes

    # -----------------------------------------------------------------------
    # Reviews
    # -----------------------------------------------------------------------

    def add_review(
        self,
        node_id: int,
        reviewer_type: str,
        status: str,
        *,
        reviewer_user_id: int | None = None,
        ai_model: str | None = None,
        comment: str | None = None,
    ) -> dict:
        session = self._get_session()
        try:
            review = LineageReview(
                lineage_node_id=node_id,
                reviewer_type=reviewer_type,
                reviewer_user_id=reviewer_user_id,
                ai_model=ai_model,
                status=status,
                comment=comment,
                created_at=self._now(),
            )
            session.add(review)
            session.flush()

            # Recompute node review_status
            self._recompute_review_status(session, node_id)
            session.commit()
            return {
                "id": review.id,
                "lineage_node_id": review.lineage_node_id,
                "reviewer_type": review.reviewer_type,
                "status": review.status,
            }
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def get_reviews(self, node_id: int) -> list[dict]:
        session = self._get_session()
        try:
            reviews = (
                session.query(LineageReview)
                .filter(LineageReview.lineage_node_id == node_id)
                .order_by(LineageReview.created_at)
                .all()
            )
            return [
                {
                    "id": r.id,
                    "reviewer_type": r.reviewer_type,
                    "reviewer_user_id": r.reviewer_user_id,
                    "ai_model": r.ai_model,
                    "status": r.status,
                    "comment": r.comment,
                    "created_at": r.created_at,
                }
                for r in reviews
            ]
        finally:
            session.close()

    def _recompute_review_status(self, session, node_id: int):
        reviews = (
            session.query(LineageReview)
            .filter(LineageReview.lineage_node_id == node_id)
            .all()
        )
        has_ai = any(r.reviewer_type == ReviewerType.AI.value for r in reviews)
        has_human = any(r.reviewer_type == ReviewerType.HUMAN.value for r in reviews)

        if has_ai and has_human:
            new_status = ReviewStatus.AI_AND_HUMAN_REVIEWED.value
        elif has_human:
            new_status = ReviewStatus.HUMAN_REVIEWED.value
        elif has_ai:
            new_status = ReviewStatus.AI_REVIEWED.value
        else:
            new_status = ReviewStatus.UNREVIEWED.value

        node = session.query(LineageNode).filter(LineageNode.id == node_id).first()
        if node:
            node.review_status = new_status

    # -----------------------------------------------------------------------
    # Review requests
    # -----------------------------------------------------------------------

    def request_review(
        self,
        node_id: int,
        requested_by_user_id: int | None,
        *,
        reviewer_type: str,
        reviewer_user_id: int | None = None,
        ai_model: str | None = None,
        message: str | None = None,
    ) -> dict:
        session = self._get_session()
        try:
            rr = LineageReviewRequest(
                lineage_node_id=node_id,
                requested_by_user_id=requested_by_user_id,
                requested_reviewer_type=reviewer_type,
                requested_reviewer_user_id=reviewer_user_id,
                requested_ai_model=ai_model,
                message=message,
                status="pending",
                created_at=self._now(),
            )
            session.add(rr)
            session.commit()
            return {"id": rr.id, "status": rr.status}
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def get_pending_review_requests(
        self,
        *,
        reviewer_user_id: int | None = None,
        ai_model: str | None = None,
    ) -> list[dict]:
        session = self._get_session()
        try:
            q = session.query(LineageReviewRequest).filter(
                LineageReviewRequest.status == "pending"
            )
            if reviewer_user_id is not None:
                q = q.filter(
                    LineageReviewRequest.requested_reviewer_user_id == reviewer_user_id
                )
            if ai_model is not None:
                q = q.filter(LineageReviewRequest.requested_ai_model == ai_model)

            return [
                {
                    "id": rr.id,
                    "lineage_node_id": rr.lineage_node_id,
                    "requested_reviewer_type": rr.requested_reviewer_type,
                    "requested_reviewer_user_id": rr.requested_reviewer_user_id,
                    "requested_ai_model": rr.requested_ai_model,
                    "message": rr.message,
                    "created_at": rr.created_at,
                }
                for rr in q.all()
            ]
        finally:
            session.close()

    def complete_review_request(self, request_id: int, review_id: int) -> None:
        session = self._get_session()
        try:
            rr = (
                session.query(LineageReviewRequest)
                .filter(LineageReviewRequest.id == request_id)
                .first()
            )
            if rr:
                rr.status = "completed"
                rr.completed_at = self._now()
                rr.completed_review_id = review_id
                session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def dismiss_review_request(self, request_id: int) -> None:
        session = self._get_session()
        try:
            rr = (
                session.query(LineageReviewRequest)
                .filter(LineageReviewRequest.id == request_id)
                .first()
            )
            if rr:
                rr.status = "dismissed"
                rr.completed_at = self._now()
                session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    # -----------------------------------------------------------------------
    # Lookup
    # -----------------------------------------------------------------------

    def find_data_source_node(self, table_name: str) -> dict | None:
        session = self._get_session()
        try:
            node = (
                session.query(LineageNode)
                .filter(
                    LineageNode.node_type == LineageNodeType.DATA_SOURCE.value,
                    LineageNode.label == table_name,
                )
                .first()
            )
            return self._serialize_node(node) if node else None
        finally:
            session.close()

    def find_data_source_id(self, table_name: str) -> int | None:
        session = self._get_session()
        try:
            node = (
                session.query(LineageNode.id)
                .filter(
                    LineageNode.node_type == LineageNodeType.DATA_SOURCE.value,
                    LineageNode.label == table_name,
                )
                .first()
            )
            return node[0] if node else None
        finally:
            session.close()

    def search_nodes(
        self,
        *,
        node_type: str | None = None,
        extension_name: str | None = None,
        creator_type: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        session = self._get_session()
        try:
            q = session.query(LineageNode)
            if node_type:
                q = q.filter(LineageNode.node_type == node_type)
            if extension_name:
                q = q.filter(LineageNode.extension_name == extension_name)
            if creator_type:
                q = q.filter(LineageNode.creator_type == creator_type)
            nodes = q.order_by(LineageNode.created_at.desc()).limit(limit).all()
            return [self._serialize_node(n) for n in nodes]
        finally:
            session.close()

    # -----------------------------------------------------------------------
    # Backfill
    # -----------------------------------------------------------------------

    def backfill_existing_perspectives(self):
        """Create stub OUTPUT nodes for perspectives that lack lineage."""
        session = self._get_session()
        try:
            perspectives = session.query(Perspective).all()
            count = 0
            for p in perspectives:
                existing = (
                    session.query(PerspectiveLineage)
                    .filter(PerspectiveLineage.perspective_id == p.id)
                    .first()
                )
                if existing:
                    continue
                now = self._now()
                node = LineageNode(
                    node_type=LineageNodeType.OUTPUT.value,
                    content_json=json.dumps({
                        "output_type": "perspective",
                        "perspective_id": p.id,
                        "backfilled": True,
                    }),
                    creator_type=CreatorType.SYSTEM.value,
                    review_status=ReviewStatus.UNREVIEWED.value,
                    version=1,
                    created_at=now,
                    updated_at=now,
                    label=f"Perspective: {p.name}",
                )
                session.add(node)
                session.flush()
                session.add(PerspectiveLineage(
                    perspective_id=p.id,
                    lineage_node_id=node.id,
                    role="root_output",
                ))
                count += 1
            session.commit()
            if count:
                logger.info("Backfilled lineage for %d perspectives", count)
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    # -----------------------------------------------------------------------
    # Perspective lineage
    # -----------------------------------------------------------------------

    def record_perspective_lineage(
        self,
        perspective_id: int,
        perspective_name: str,
        config_json: str,
        *,
        creator_type: CreatorType = CreatorType.USER,
        creator_user_id: int | None = None,
        project_id: int | None = None,
        scenario_id: int | None = None,
    ) -> LineageNode:
        """
        Create OUTPUT and VIZ_CONFIG lineage nodes for a perspective save.

        Parses config_json to extract painting and plot references, creates
        VIZ_CONFIG nodes for each visual component, and an OUTPUT node that
        links them all together via the PerspectiveLineage join table.
        """
        try:
            config = json.loads(config_json) if isinstance(config_json, str) else config_json
        except (json.JSONDecodeError, TypeError):
            config = {}

        parent_node_ids = []

        # --- Extract VIZ_CONFIG nodes from paintings ---
        paintings = config.get("paintings", [])
        for painting in paintings:
            painting_id = painting.get("painting_id")
            layer_id = painting.get("layer_id")
            overrides = painting.get("overrides", {})

            viz_node = self.record_viz_config(
                content={
                    "viz_type": "map_layer",
                    "painting_id": painting_id,
                    "layer_id": layer_id,
                    "overrides": overrides,
                },
                creator_type=creator_type,
                creator_user_id=creator_user_id,
                tier=1,
                label=f"Map painting {painting_id} (layer {layer_id})",
            )
            parent_node_ids.append(viz_node.id)

        # --- Extract VIZ_CONFIG nodes from plots ---
        plots = config.get("plots", [])
        for i, plot in enumerate(plots):
            plot_type = plot.get("type", "unknown")
            dataset_id = plot.get("datasetId")

            viz_node = self.record_viz_config(
                content={
                    "viz_type": "chart",
                    "chart_type": plot_type,
                    "dataset_id": dataset_id,
                    "plot_config": plot,
                },
                creator_type=creator_type,
                creator_user_id=creator_user_id,
                tier=1,
                label=f"Plot {i + 1}: {plot_type}",
            )
            parent_node_ids.append(viz_node.id)

        # --- Create OUTPUT node for the perspective ---
        output_node = self.record_output(
            content={
                "output_type": "perspective",
                "perspective_id": perspective_id,
                "painting_count": len(paintings),
                "plot_count": len(plots),
                "view_state": config.get("viewState"),
            },
            parent_node_ids=parent_node_ids,
            perspective_id=perspective_id,
            creator_type=creator_type,
            creator_user_id=creator_user_id,
            label=f"Perspective: {perspective_name}",
        )
        return output_node

    def clear_perspective_lineage(self, perspective_id: int) -> None:
        """Remove existing lineage links for a perspective (before re-recording on update)."""
        session = self._get_session()
        try:
            session.query(PerspectiveLineage).filter(
                PerspectiveLineage.perspective_id == perspective_id,
            ).delete()
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    # -----------------------------------------------------------------------
    # User helpers
    # -----------------------------------------------------------------------

    def get_default_user_id(self) -> int | None:
        """Return the default admin user's ID. Stub for future auth."""
        session = self._get_session()
        try:
            user = (
                session.query(User)
                .filter(User.role == "admin")
                .first()
            )
            return user.id if user else None
        finally:
            session.close()
