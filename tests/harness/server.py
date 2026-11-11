"""Loopback-only integration fixture. Never included in the plugin package."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import sys
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".test-runtime"
PACKAGE = RUNTIME / "plugins" / "hermes-monaco"
spec = importlib.util.spec_from_file_location("isolated_monaco_api", PACKAGE / "dashboard" / "plugin_api.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
backend = plugin._bootstrap.load_backend()
runtime = sys.modules[backend.__name__ + ".runtime"]
files = sys.modules[backend.__name__ + ".files"]


@asynccontextmanager
async def lifespan(_app):
    yield
    runtime.shutdown()


app = FastAPI(lifespan=lifespan)
app.include_router(plugin.router, prefix="/api/plugins/hermes-monaco")


def service(x_hermes_profile: str = Header(default="default"), x_hermes_connection: str = Header(default="local")):
    return runtime.services_for(x_hermes_connection + ":" + x_hermes_profile)


app.dependency_overrides[runtime.current_services] = service


@app.middleware("http")
async def csp(request, call_next):
    response = await call_next(request)
    # Same relevant restrictions as Hermes's browser host: no eval, no CDN,
    # module/worker blobs allowed, styles inline, fonts embedded as data URLs.
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https: http:; connect-src 'self'; object-src 'none'"
    return response


@app.get("/test/health")
def health():
    return {"ok": True}


@app.post("/test/setup")
def setup():
    base = RUNTIME / "workspaces" / uuid.uuid4().hex
    a, b = base / "alpha space λ", base / "beta"
    for root in [a, b]:
        root.mkdir(parents=True)
        (root / ".git").mkdir()
        (root / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        (root / "ignored.txt").write_text("secret needle\n", encoding="utf-8")
        (root / "main.ts").write_text("// " + root.name + "\nexport const greeting = 'hello';\nconsole.log(greeting);\n", encoding="utf-8")
        (root / "data.json").write_text('{"answer": 42}\n', encoding="utf-8")
        (root / "runner.py").write_text("import pathlib, sys, time\nprint(pathlib.Path('main.ts').read_text(encoding='utf-8'), flush=True)\nprint('RUN READY', flush=True)\nprint('STDERR READY', file=sys.stderr, flush=True)\ntime.sleep(60)\n", encoding="utf-8")
    command = f'& "{sys.executable}" runner.py' if os.name == "nt" else f"{shlex.quote(sys.executable)} runner.py"
    return {"a": str(a), "b": str(b), "command": command}


def fixture_workspace(root):
    path = Path(root).resolve()
    if not path.is_relative_to((RUNTIME / "workspaces").resolve()):
        raise HTTPException(403)
    return files.Workspace(str(path))


@app.post("/test/file")
def change_file(body: dict):
    workspace = fixture_workspace(body["root"])
    path = workspace.path(body["path"], mutate=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body["text"].encode("utf-8"))
    return {"ok": True}


@app.get("/test/file")
def read_file(root: str, path: str):
    return fixture_workspace(root).read(path)


@app.get("/plugin.js")
def source():
    return FileResponse(PACKAGE / "desktop" / "plugin.js", media_type="text/javascript")


@app.get("/")
def index():
    return FileResponse(ROOT / "tests" / "harness" / "index.html")


app.mount("/assets", StaticFiles(directory=ROOT / ".build" / "harness"), name="assets")
