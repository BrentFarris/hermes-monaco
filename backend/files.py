"""Workspace-relative, revision checked text file operations."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path, PureWindowsPath
import stat
import tempfile
import threading
import uuid

from .errors import WorkspaceError

MAX_TEXT_BYTES = 4 * 1024 * 1024


def relative_path(value: str, *, allow_root=False) -> str:
    if not isinstance(value, str) or "\0" in value or ":" in value:
        raise WorkspaceError("invalid_path", "Use a path relative to this workspace.")
    value = value.replace("\\", "/")
    if value.startswith("/") or PureWindowsPath(value).is_absolute():
        raise WorkspaceError("invalid_path", "Absolute file paths are not allowed.")
    parts = value.split("/")
    if ".." in parts:
        raise WorkspaceError("outside_workspace", "The path leaves this workspace.", 403)
    parts = [part for part in parts if part not in ("", ".")]
    if any(part.endswith((" ", ".")) for part in parts):
        raise WorkspaceError("invalid_path", "Names cannot end with spaces or periods.")
    result = "/".join(parts)
    if not result and not allow_root:
        raise WorkspaceError("invalid_path", "Choose a file or folder within the workspace.")
    return result


def revision(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class Workspace:
    def __init__(self, root: str):
        path = Path(root).expanduser()
        if not path.is_absolute():
            raise WorkspaceError("invalid_workspace", "The workspace folder must be absolute.")
        self.root = path.resolve(strict=True)
        if not self.root.is_dir():
            raise WorkspaceError("invalid_workspace", "The workspace must be a directory.")
        self.identity = self._identity()
        self.id = uuid.uuid4().hex
        self.lock = threading.RLock()

    def _identity(self):
        info = self.root.stat()
        return info.st_dev, info.st_ino

    def check(self):
        if self.root.is_symlink() or self._identity() != self.identity:
            raise WorkspaceError("workspace_changed", "The workspace folder was replaced. Reopen it.", 409)

    def path(self, ref: str, *, allow_root=False, mutate=False) -> Path:
        self.check()
        rel = relative_path(ref, allow_root=allow_root)
        path = self.root / rel
        try:
            path.resolve().relative_to(self.root)
        except (ValueError, RuntimeError):
            raise WorkspaceError("outside_workspace", "This link leaves the workspace.", 403) from None
        if mutate:
            current = self.root
            for part in Path(rel).parts:
                current /= part
                if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
                    raise WorkspaceError("linked_path", "Open the link's target directly to change it.", 403)
        return path

    def describe(self):
        return {"id": self.id, "root": str(self.root), "name": self.root.name or str(self.root)}

    def list(self, ref=""):
        folder = self.path(ref, allow_root=True)
        entries = []
        truncated = False
        with os.scandir(folder) as iterator:
            for item in iterator:
                if item.name == ".git":
                    continue
                if len(entries) >= 10_000:
                    truncated = True
                    break
                child = relative_path(f"{ref}/{item.name}".lstrip("/"))
                available = True
                try:
                    self.path(child)
                except WorkspaceError:
                    available = False
                try:
                    info = item.stat(follow_symlinks=False)
                    is_dir = available and item.is_dir()
                except FileNotFoundError:
                    continue  # An external rename during enumeration is refreshed next poll.
                entries.append({
                    "name": item.name, "path": child, "directory": is_dir,
                    "size": info.st_size, "mtime": info.st_mtime_ns,
                    "linked": item.is_symlink(), "available": available,
                })
        entries.sort(key=lambda entry: (not entry["directory"], entry["name"].casefold()))
        return {"entries": entries, "truncated": truncated}

    def _read_raw(self, ref):
        path = self.path(ref)
        # No special devices or pipes: these can block a request indefinitely.
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            raise WorkspaceError("not_file", "This entry is not a regular file.")
        if info.st_size > MAX_TEXT_BYTES:
            raise WorkspaceError("too_large", "Text editing is limited to 4 MiB per file.", 413)
        with path.open("rb") as source:
            raw = source.read(MAX_TEXT_BYTES + 1)
        if len(raw) > MAX_TEXT_BYTES:
            raise WorkspaceError("too_large", "Text editing is limited to 4 MiB per file.", 413)
        self.path(ref)
        return raw

    def read(self, ref):
        raw = self._read_raw(ref)
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            raise WorkspaceError("encoding", "This file uses UTF-16. Save it as UTF-8 to edit it here.", 415)
        if b"\0" in raw:
            raise WorkspaceError("binary", "Binary files cannot be edited as text.", 415)
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise WorkspaceError("encoding", "This file is not valid UTF-8.", 415) from None
        crlf = text.count("\r\n")
        return {
            "path": relative_path(ref), "text": text, "revision": revision(raw),
            "bom": raw.startswith(b"\xef\xbb\xbf"),
            "eol": "crlf" if crlf and crlf >= text.count("\n") - crlf else "lf",
            "size": len(raw),
        }

    def write(self, ref, text, expected_revision, *, bom=False):
        if not isinstance(text, str) or "\0" in text:
            raise WorkspaceError("invalid_text", "Provide UTF-8 text without NUL characters.")
        raw = (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")
        if len(raw) > MAX_TEXT_BYTES:
            raise WorkspaceError("too_large", "Text editing is limited to 4 MiB per file.", 413)
        with self.lock:
            path = self.path(ref, mutate=True)
            existing = path.exists()
            if existing:
                current = self.read(ref)
                if current["revision"] != expected_revision:
                    raise WorkspaceError("conflict", "This file changed on disk. Compare the versions before saving.", 409, current=current)
            elif expected_revision is not None:
                raise WorkspaceError("deleted", "This file was deleted on disk. Recreate it explicitly to save your draft.", 409)
            mode = stat.S_IMODE(path.stat().st_mode) if existing else None
            fd, temporary = tempfile.mkstemp(prefix=".hermes-monaco-", dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(raw)
                    output.flush()
                    os.fsync(output.fileno())
                if mode is not None:
                    os.chmod(temporary, mode)
                self.path(ref, mutate=True)
                # Recheck after writing the temporary file to catch an external
                # editor/agent changing the destination during a slower write.
                if existing:
                    if not path.exists() or revision(self._read_raw(ref)) != expected_revision:
                        current = self.read(ref) if path.exists() else None
                        raise WorkspaceError("conflict", "The file changed while saving.", 409, current=current)
                    os.replace(temporary, path)
                else:
                    # Atomic create-only publication; never clobber a file which
                    # appeared after the existence check. Both paths are on one FS.
                    try:
                        os.link(temporary, path)
                    except FileExistsError:
                        raise WorkspaceError("conflict", "A file with this name was just created.", 409, current=self.read(ref)) from None
                return self.read(ref)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def create(self, ref, directory=False):
        with self.lock:
            path = self.path(ref, mutate=True)
            if path.exists():
                raise WorkspaceError("exists", "An entry with this name already exists.", 409)
            if directory:
                path.mkdir()
                return {"path": relative_path(ref), "directory": True}
            return self.write(ref, "", None)

    def move(self, source, destination):
        with self.lock:
            old = self.path(source, mutate=True)
            new = self.path(destination, mutate=True)
            if new.exists():
                raise WorkspaceError("exists", "The destination already exists.", 409)
            if old.is_dir() and new.is_relative_to(old):
                raise WorkspaceError("invalid_path", "A folder cannot be moved into itself.")
            old.rename(new)
            return {"previousPath": relative_path(source), "path": relative_path(destination)}

    def trash(self, ref):
        with self.lock:
            path = self.path(ref, mutate=True)
            try:
                from send2trash import send2trash
            except ImportError:
                raise WorkspaceError("trash_unavailable", "OS trash is unavailable. Install the plugin's Send2Trash dependency.", 501) from None
            try:
                send2trash(str(path))
            except Exception as error:
                raise WorkspaceError("trash_unavailable", f"Could not move this entry to the OS trash: {error}", 409) from error
            return {"path": relative_path(ref)}
