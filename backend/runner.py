from __future__ import annotations

from collections import deque
import codecs
import os
import subprocess
import threading
import time
import uuid

from .errors import WorkspaceError
from .process_tree import ProcessTree
from .scripts import effective_script, load_config, shell_arguments

OUTPUT_LIMIT = 1024 * 1024
ACTIVE = {"starting", "running", "stopping"}


class Run:
    def __init__(self, workspace, script):
        self.id = uuid.uuid4().hex
        self.workspace_id = workspace.id
        self.workspace_root = str(workspace.root)
        self.script_id = script["id"]
        self.name = script["name"]
        self.command = script["command"]
        self.status = "starting"
        self.exit_code = None
        self.started = time.time()
        self.ended = None
        self.error = None
        self.lock = threading.RLock()
        self.chunks = deque()
        self.output_size = 0
        self.cursor = 0
        self.tree = None
        self.process = None
        self.stopped = False

    def describe(self):
        with self.lock:
            return {"id": self.id, "workspaceId": self.workspace_id, "root": self.workspace_root,
                    "scriptId": self.script_id, "name": self.name, "command": self.command,
                    "status": self.status, "exitCode": self.exit_code, "started": self.started,
                    "ended": self.ended, "error": self.error}

    def append(self, stream, text):
        if not text:
            return
        with self.lock:
            self.cursor += 1
            self.chunks.append({"cursor": self.cursor, "stream": stream, "text": text})
            self.output_size += len(text.encode("utf-8"))
            while self.output_size > OUTPUT_LIMIT and len(self.chunks) > 1:
                self.output_size -= len(self.chunks.popleft()["text"].encode("utf-8"))

    def output(self, after=0):
        with self.lock:
            return {"run": self.describe(), "chunks": [c for c in self.chunks if c["cursor"] > after],
                    "cursor": self.cursor, "truncated": bool(self.chunks and after < self.chunks[0]["cursor"] - 1)}

    def drain(self, pipe, stream):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while chunk := pipe.read1(4096):
                self.append(stream, decoder.decode(chunk))
            self.append(stream, decoder.decode(b"", final=True))
        finally:
            pipe.close()

    def start(self, workspace, script):
        try:
            cwd = workspace.path(script.get("cwd", "."), allow_root=True)
            if not cwd.is_dir():
                raise WorkspaceError("script_cwd", "The script's working directory does not exist.")
            argv = shell_arguments(script["command"], script.get("shell", "default"))
            env = {**os.environ, "PYTHONIOENCODING": "utf-8", **script.get("env", {})}
            with self.lock:
                self.tree = ProcessTree()
                self.process = self.tree.spawn(argv, str(cwd), env)
                self.status = "running"
            readers = [threading.Thread(target=self.drain, args=(pipe, stream), daemon=True)
                       for pipe, stream in [(self.process.stdout, "stdout"), (self.process.stderr, "stderr")]]
            for reader in readers:
                reader.start()
            threading.Thread(target=self.watch, args=(readers,), daemon=True).start()
        except Exception as error:
            with self.lock:
                self.status, self.error, self.ended = "failed", str(error), time.time()
            if self.tree:
                self.tree.close()

    def watch(self, readers):
        code = self.process.wait()
        # A managed command must keep its foreground process alive. Reap any
        # children it leaves behind so a completed run cannot hide a live server.
        self.tree.stop(grace=0.1)
        for reader in readers:
            reader.join(timeout=2)
        with self.lock:
            self.exit_code = code
            self.status = "stopped" if self.stopped else "exited"
            self.ended = time.time()
            self.tree.close()

    def stop(self, grace=2.0):
        with self.lock:
            if self.status not in ACTIVE:
                return
            self.stopped, self.status = True, "stopping"
            tree = self.tree
        if tree:
            tree.stop(grace)
        if self.process:
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass


class Runner:
    def __init__(self):
        self.runs = {}
        self.lock = threading.RLock()
        self.closed = False

    def start(self, workspace, script_id, config_revision):
        with self.lock:
            if self.closed:
                raise WorkspaceError("unavailable", "The plugin backend is shutting down.", 503)
            loaded = load_config(workspace)
            if loaded["revision"] != config_revision:
                raise WorkspaceError("script_changed", "The script configuration changed. Review it and press Play again.", 409)
            if any(r.workspace_id == workspace.id and r.script_id == script_id and r.status in ACTIVE for r in self.runs.values()):
                raise WorkspaceError("already_running", "This script is already running. Use Stop or Restart.", 409)
            if sum(r.status in ACTIVE for r in self.runs.values()) >= 8:
                raise WorkspaceError("run_limit", "Eight scripts are already running in this profile.", 429)
            finished = [r for r in self.runs.values() if r.status not in ACTIVE]
            for old in finished[:-31]:
                self.runs.pop(old.id)
            script = effective_script(loaded["config"], script_id)
            run = Run(workspace, script)
            self.runs[run.id] = run
            run.start(workspace, script)
            return run.describe()

    def get(self, run_id):
        with self.lock:
            run = self.runs.get(run_id)
        if not run:
            raise WorkspaceError("run_missing", "This run is no longer available.", 404)
        return run

    def list(self):
        with self.lock:
            return [r.describe() for r in reversed(list(self.runs.values()))]

    def shutdown(self):
        with self.lock:
            self.closed = True
            runs = list(self.runs.values())
        for run in runs:
            run.stop(grace=0)
