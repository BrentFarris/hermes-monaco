from contextlib import asynccontextmanager
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from .errors import WorkspaceError
from .runtime import Services, current_services, shutdown
from .scripts import load_config, save_config
from .search import search

log = logging.getLogger("hermes-monaco")


class ErrorRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handle(request):
            try:
                return await original(request)
            except WorkspaceError as error:
                # Desktop's native REST bridge flattens non-2xx response bodies.
                # Keep domain failures (especially conflict snapshots) intact.
                return JSONResponse(error.payload())
            except FileNotFoundError:
                return JSONResponse(WorkspaceError("not_found", "This file or folder no longer exists.", 404).payload())
            except PermissionError:
                return JSONResponse(WorkspaceError("permission", "The backend cannot access this file or folder.", 403).payload())
            except OSError as error:
                return JSONResponse(WorkspaceError("io_error", str(error), 409).payload())
        return handle


@asynccontextmanager
async def lifespan(_app):
    try:
        yield
    finally:
        shutdown()


router = APIRouter(route_class=ErrorRoute, lifespan=lifespan)
Service = Annotated[Services, Depends(current_services)]


class BindRequest(BaseModel):
    cwd: str = Field(min_length=1, max_length=32768)


class FileRef(BaseModel):
    workspaceId: str
    path: str


class SaveRequest(FileRef):
    text: str = Field(max_length=4 * 1024 * 1024)
    expectedRevision: str | None
    bom: bool = False


class CreateRequest(FileRef):
    directory: bool = False


class MoveRequest(FileRef):
    destination: str


class Overlay(BaseModel):
    path: str
    text: str = Field(max_length=4 * 1024 * 1024)


class SearchRequest(BaseModel):
    workspaceId: str
    query: str = Field(max_length=2048)
    kind: Literal["text", "files"] = "text"
    case: bool = False
    word: bool = False
    regex: bool = False
    include: list[str] = Field(default_factory=list, max_length=32)
    exclude: list[str] = Field(default_factory=list, max_length=32)
    ignored: bool = False
    overlays: list[Overlay] = Field(default_factory=list, max_length=100)


class ConfigRequest(BaseModel):
    workspaceId: str
    config: dict
    expectedRevision: str | None


class StartRequest(BaseModel):
    workspaceId: str
    scriptId: str
    configRevision: str


@router.get("/health")
def health():
    return {"apiVersion": 1, "maxTextBytes": 4 * 1024 * 1024}


@router.post("/workspace")
def bind(body: BindRequest, service: Service):
    return service.bind(body.cwd)


@router.get("/entries")
def entries(workspaceId: str, service: Service, path: str = ""):
    return service.workspace(workspaceId).list(path)


@router.get("/file")
def read(workspaceId: str, path: str, service: Service):
    return service.workspace(workspaceId).read(path)


@router.put("/file")
def save(body: SaveRequest, service: Service):
    return service.workspace(body.workspaceId).write(body.path, body.text, body.expectedRevision, bom=body.bom)


@router.post("/entries")
def create(body: CreateRequest, service: Service):
    return service.workspace(body.workspaceId).create(body.path, body.directory)


@router.patch("/entries")
def move(body: MoveRequest, service: Service):
    return service.workspace(body.workspaceId).move(body.path, body.destination)


@router.post("/trash")
def trash(body: FileRef, service: Service):
    return service.workspace(body.workspaceId).trash(body.path)


@router.post("/search")
def find(body: SearchRequest, service: Service):
    if not service.search_slots.acquire(blocking=False):
        raise WorkspaceError("search_busy", "A previous search is still finishing. Try again shortly.", 429)
    try:
        options = body.model_dump(exclude={"workspaceId", "query"})
        return search(service.workspace(body.workspaceId), body.query, **options)
    finally:
        service.search_slots.release()


@router.get("/scripts")
def scripts(workspaceId: str, service: Service):
    return load_config(service.workspace(workspaceId))


@router.put("/scripts")
def update_scripts(body: ConfigRequest, service: Service):
    return save_config(service.workspace(body.workspaceId), body.config, body.expectedRevision)


@router.get("/runs")
def runs(service: Service):
    return {"runs": service.runner.list()}


@router.post("/runs")
def start(body: StartRequest, service: Service):
    return service.runner.start(service.workspace(body.workspaceId), body.scriptId, body.configRevision)


@router.post("/runs/{run_id}/stop")
def stop(run_id: str, service: Service):
    run = service.runner.get(run_id)
    run.stop()
    return run.describe()


@router.get("/runs/{run_id}/output")
def output(run_id: str, service: Service, cursor: int = Query(default=0, ge=0)):
    return service.runner.get(run_id).output(cursor)

