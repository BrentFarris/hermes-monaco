from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import router
from backend.runtime import Services, current_services

BASE = "/api/plugins/hermes-monaco"


def test_api_revision_conflict_preserves_snapshot(client, workspace):
    binding = client.post(BASE + "/workspace", json={"cwd": str(workspace.root)}).json()
    body = {"workspaceId": binding["id"], "path": "file.txt", "text": "first", "expectedRevision": None}
    first = client.put(BASE + "/file", json=body).json()
    result = client.put(BASE + "/file", json={**body, "text": "second", "expectedRevision": first["revision"]}).json()
    stale = client.put(BASE + "/file", json={**body, "text": "stale", "expectedRevision": first["revision"]}).json()
    assert stale["error"]["code"] == "conflict"
    assert stale["error"]["status"] == 409
    assert stale["error"]["current"]["text"] == result["text"] == "second"


def test_profiles_cannot_reuse_workspace_or_run_handles(workspace):
    profiles = [Services(), Services()]
    current = [0]
    app = FastAPI()
    app.include_router(router, prefix=BASE)
    app.dependency_overrides[current_services] = lambda: profiles[current[0]]
    with TestClient(app) as client:
        first = client.post(BASE + "/workspace", json={"cwd": str(workspace.root)}).json()
        current[0] = 1
        denied = client.get(BASE + "/entries", params={"workspaceId": first["id"]}).json()
        assert denied["error"]["code"] == "workspace_missing"
        second = client.post(BASE + "/workspace", json={"cwd": str(workspace.root)}).json()
        assert first["id"] != second["id"]


def test_api_bad_paths_and_config(client, workspace):
    workspace_id = client.post(BASE + "/workspace", json={"cwd": str(workspace.root)}).json()["id"]
    result = client.get(BASE + "/file", params={"workspaceId": workspace_id, "path": "../escape"}).json()
    assert result["error"]["code"] == "outside_workspace"
    workspace.write(".hidden", "visible", None)
    listing = client.get(BASE + "/entries", params={"workspaceId": workspace_id}).json()
    assert listing["entries"][0]["name"] == ".hidden"
    result = client.put(BASE + "/scripts", json={"workspaceId": workspace_id, "config": {"version": 2}, "expectedRevision": None}).json()
    assert result["error"]["code"] == "script_config"
