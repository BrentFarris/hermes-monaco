from pathlib import Path
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.api import router
from backend.runtime import Services, current_services
from backend.files import Workspace


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "project space λ"
    root.mkdir()
    return Workspace(str(root))


@pytest.fixture
def service():
    value = Services()
    yield value
    value.runner.shutdown()


@pytest.fixture
def client(service):
    app = FastAPI()
    app.include_router(router, prefix="/api/plugins/hermes-monaco")
    app.dependency_overrides[current_services] = lambda: service
    with TestClient(app) as client:
        yield client

