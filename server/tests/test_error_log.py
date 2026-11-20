"""The agent-readable error log: GET /api/errors, POST /api/client-errors."""
from tests.conftest import AUTH_HEADERS


def _latest(client):
    return client.get("/api/errors", headers=AUTH_HEADERS).json()["latest_seq"]


def test_failed_request_is_recorded(client):
    start = _latest(client)
    r = client.get("/api/extensions/no-such-ext/charts", headers=AUTH_HEADERS)
    assert r.status_code >= 400
    body = client.get(f"/api/errors?since={start}", headers=AUTH_HEADERS).json()
    hits = [e for e in body["errors"] if e["source"] == "http"
            and "/api/extensions/no-such-ext/charts" in e["message"]]
    assert hits, body
    assert hits[0]["detail"]["body"]  # the error body is kept for the agent
    assert body["next_since"] >= hits[0]["seq"]


def test_client_errors_are_recorded_and_paged(client):
    start = _latest(client)
    r = client.post("/api/client-errors", headers=AUTH_HEADERS, json={"errors": [
        {"source": "chart", "message": "boom 1"},
        {"source": "console", "message": "boom 2", "detail": {"k": 1}},
    ]})
    assert r.status_code == 200 and r.json()["recorded"] == 2
    first = client.get(f"/api/errors?since={start}&limit=1", headers=AUTH_HEADERS).json()
    assert [e["message"] for e in first["errors"]] == ["boom 1"]
    rest = client.get(f"/api/errors?since={first['next_since']}", headers=AUTH_HEADERS).json()
    assert [e["source"] for e in rest["errors"]] == ["client:console"]


def test_errors_need_the_api_key(client):
    assert client.get("/api/errors").status_code == 401
