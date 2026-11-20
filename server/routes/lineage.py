"""Lineage routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from lib.auth import require_api_key
from lib.lineage import LineageManager
from lib.responses import make_response

router = APIRouter()


class ReviewBody(BaseModel):
    reviewer_type: str
    status: str
    reviewer_user_id: int | None = None
    ai_model: str | None = None
    comment: str | None = None


class ReviewRequestBody(BaseModel):
    reviewer_type: str
    reviewer_user_id: int | None = None
    ai_model: str | None = None
    message: str | None = None


class ReviewRequestUpdateBody(BaseModel):
    status: str
    review_id: int | None = None


@router.get("/api/lineage/perspective/{perspective_id}")
async def getLineageForPerspective(perspective_id: int, request: Request, _=Depends(require_api_key)):
    lm: LineageManager = request.app.state.lineage_manager
    dag = lm.get_dag_for_perspective(perspective_id)
    return make_response({"nodes": dag.nodes, "edges": dag.edges})


@router.get("/api/lineage/node/{node_id}")
async def getLineageNode(node_id: int, request: Request, _=Depends(require_api_key)):
    lm: LineageManager = request.app.state.lineage_manager
    node = lm.get_node(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Lineage node not found")
    return make_response(node)


@router.get("/api/lineage/node/{node_id}/ancestors")
async def getLineageNodeAncestors(node_id: int, request: Request, _=Depends(require_api_key)):
    lm: LineageManager = request.app.state.lineage_manager
    dag = lm.get_dag_for_node(node_id)
    return make_response({"nodes": dag.nodes, "edges": dag.edges})


@router.get("/api/lineage/node/{node_id}/reviews")
async def getLineageNodeReviews(node_id: int, request: Request, _=Depends(require_api_key)):
    lm: LineageManager = request.app.state.lineage_manager
    reviews = lm.get_reviews(node_id)
    return make_response(reviews)


@router.post("/api/lineage/node/{node_id}/reviews")
async def addLineageReview(node_id: int, body: ReviewBody, request: Request, _=Depends(require_api_key)):
    lm: LineageManager = request.app.state.lineage_manager
    review = lm.add_review(
        node_id,
        body.reviewer_type,
        body.status,
        reviewer_user_id=body.reviewer_user_id,
        ai_model=body.ai_model,
        comment=body.comment,
    )
    return make_response(review)


@router.post("/api/lineage/node/{node_id}/review-requests")
async def createLineageReviewRequest(node_id: int, body: ReviewRequestBody, request: Request, _=Depends(require_api_key)):
    lm: LineageManager = request.app.state.lineage_manager
    default_user_id = lm.get_default_user_id()
    result = lm.request_review(
        node_id,
        requested_by_user_id=default_user_id,
        reviewer_type=body.reviewer_type,
        reviewer_user_id=body.reviewer_user_id,
        ai_model=body.ai_model,
        message=body.message,
    )
    return make_response(result)


@router.get("/api/lineage/review-requests")
async def getPendingReviewRequests(
    request: Request,
    reviewer_user_id: int | None = None,
    ai_model: str | None = None,
    _=Depends(require_api_key),
):
    lm: LineageManager = request.app.state.lineage_manager
    requests = lm.get_pending_review_requests(
        reviewer_user_id=reviewer_user_id,
        ai_model=ai_model,
    )
    return make_response(requests)


@router.patch("/api/lineage/review-requests/{request_id}")
async def updateReviewRequest(request_id: int, body: ReviewRequestUpdateBody, request: Request, _=Depends(require_api_key)):
    lm: LineageManager = request.app.state.lineage_manager
    if body.status == "completed" and body.review_id:
        lm.complete_review_request(request_id, body.review_id)
    elif body.status == "dismissed":
        lm.dismiss_review_request(request_id)
    else:
        raise HTTPException(status_code=400, detail="Invalid status or missing review_id")
    return make_response({"ok": True})


@router.get("/api/lineage/search")
async def searchLineageNodes(
    request: Request,
    node_type: str | None = None,
    extension_name: str | None = None,
    creator_type: str | None = None,
    limit: int = 100,
    _=Depends(require_api_key),
):
    lm: LineageManager = request.app.state.lineage_manager
    nodes = lm.search_nodes(
        node_type=node_type,
        extension_name=extension_name,
        creator_type=creator_type,
        limit=limit,
    )
    return make_response(nodes)
