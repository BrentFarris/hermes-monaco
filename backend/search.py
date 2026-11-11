"""Bounded ripgrep searches, with dirty buffers replacing disk results."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

from .errors import WorkspaceError
from .files import MAX_TEXT_BYTES, relative_path

MAX_OUTPUT = 4 * 1024 * 1024
MAX_RESULTS = 500


def ripgrep():
    try:
        import pm
    except ImportError:
        pm = None
    if pm is not None:
        try:
            installed = pm.installed_package("ripgrep")
            if installed and installed.binary and Path(installed.binary).is_file():
                return str(installed.binary)
        except (OSError, RuntimeError, ValueError):
            pass  # A portable/dev install can supply rg on its normal PATH.
    binary = shutil.which("rg")
    if not binary:
        raise WorkspaceError("ripgrep_missing", "Project search needs ripgrep. Install it through Hermes package management or put rg on the backend's PATH.", 503)
    return binary


def bounded_command(argv, cwd, data=None):
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **options)
    expired = threading.Event()

    def timeout():
        expired.set()
        if process.poll() is None:
            process.kill()

    timer = threading.Timer(8, timeout)
    timer.daemon = True
    timer.start()

    def feed():
        try:
            process.stdin.write(data)
        except BrokenPipeError:
            pass
        finally:
            process.stdin.close()

    writer = None
    if data is not None:
        writer = threading.Thread(target=feed, daemon=True)
        writer.start()
    output = bytearray()
    truncated = False
    try:
        while chunk := process.stdout.read1(16_384):
            room = MAX_OUTPUT - len(output)
            output.extend(chunk[:room])
            if len(chunk) > room:
                truncated = True
                process.kill()
                break
        process.wait(timeout=3)
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        if writer:
            writer.join(timeout=1)
    if expired.is_set():
        raise WorkspaceError("search_timeout", "Search took too long. Narrow the query or include pattern.", 408)
    if process.returncode not in (0, 1) and not truncated:
        raise WorkspaceError("search_error", output.decode("utf-8", "replace")[:1500] or "ripgrep failed.")
    return bytes(output), truncated


def filters(include, exclude, ignored):
    args = ["--hidden", "--glob", "!.git/**", "--glob", "!.hermes-monaco-*"]
    if ignored:
        args.append("--no-ignore")
    for pattern in include:
        if pattern:
            args += ["--glob", pattern]
    for pattern in exclude:
        if pattern:
            args += ["--glob", "!" + pattern]
    return args


def fuzzy_score(path, query):
    value, query = path.casefold(), query.casefold()
    if not query:
        return len(value)
    at = value.find(query)
    if at >= 0:
        return at + len(value) / 10000
    position = -1
    for char in query:
        position = value.find(char, position + 1)
        if position < 0:
            return None
    return 10000 + position + len(value) / 10000


def utf16_column(raw, offset):
    return len(raw[:offset].decode("utf-8", "replace").encode("utf-16-le")) // 2 + 1


def parse_matches(output, forced_path=None):
    matches = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue  # The bounded output may end inside its last JSON record.
        if event.get("type") != "match":
            continue
        data = event["data"]
        path = forced_path or data.get("path", {}).get("text", "")
        path = path.replace("\\", "/").removeprefix("./")
        text = data.get("lines", {}).get("text")
        if text is None:
            continue  # Non-UTF-8 file content cannot be opened by this editor.
        raw = text.encode("utf-8")
        for match in data.get("submatches", []):
            matches.append({"path": path, "line": data["line_number"],
                            "column": utf16_column(raw, match["start"]),
                            "endColumn": utf16_column(raw, match["end"]),
                            "preview": text.rstrip("\r\n")[:1000]})
    return matches


def search(workspace, query, *, kind="text", case=False, word=False, regex=False,
           include=None, exclude=None, ignored=False, overlays=None):
    workspace.check()
    if len(query) > 2048:
        raise WorkspaceError("search_query", "Search queries are limited to 2,048 characters.")
    if not query and kind == "text":
        return {"items": [], "truncated": False}
    executable = ripgrep()
    selection = filters(include or [], exclude or [], ignored)
    names, truncated = bounded_command([executable, "--files", "--null", *selection, "--", "."], workspace.root)
    paths = {name.decode("utf-8", "replace").removeprefix("./").removeprefix(".\\").replace("\\", "/")
             for name in names.split(b"\0") if name}
    if kind == "files":
        ranked = [(score, path) for path in paths if (score := fuzzy_score(path, query)) is not None]
        ranked.sort()
        return {"items": [{"path": path} for _, path in ranked[:MAX_RESULTS]],
                "truncated": truncated or len(ranked) > MAX_RESULTS}
    pattern = ["--json", "--no-messages", "--max-filesize", "4M", "--color", "never"]
    if not regex:
        pattern.append("--fixed-strings")
    if not case:
        pattern.append("--ignore-case")
    if word:
        pattern.append("--word-regexp")
    pattern += ["-e", query]
    dirty = {}
    total = 0
    for overlay in overlays or []:
        path = relative_path(overlay["path"])
        workspace.path(path)
        raw = overlay["text"].encode("utf-8")
        total += len(raw)
        if len(raw) > MAX_TEXT_BYTES or total > 16 * 1024 * 1024:
            raise WorkspaceError("search_overlays", "Unsaved search buffers exceed the 16 MiB request limit.", 413)
        dirty[path] = raw
    output, limited = bounded_command([executable, *pattern, *selection, "--", "."], workspace.root)
    items = [m for m in parse_matches(output) if m["path"] not in dirty]
    truncated |= limited
    for path, raw in dirty.items():
        if path not in paths:
            continue
        result, limited = bounded_command([executable, *pattern, "--", "-"], workspace.root, raw)
        items.extend(parse_matches(result, path))
        truncated |= limited
    items.sort(key=lambda item: (item["path"], item["line"], item["column"]))
    return {"items": items[:MAX_RESULTS], "truncated": truncated or len(items) > MAX_RESULTS}

