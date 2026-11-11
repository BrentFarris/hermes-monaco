import os
from pathlib import Path

import pytest

from backend.errors import WorkspaceError
from backend.files import MAX_TEXT_BYTES, Workspace


def test_unicode_bom_crlf_roundtrip_and_conflict(workspace):
    snapshot = workspace.write("hello λ.py", "# café\r\nprint('λ')\r\n", None, bom=True)
    assert snapshot["bom"] and snapshot["eol"] == "crlf"
    assert (workspace.root / snapshot["path"]).read_bytes().startswith(b"\xef\xbb\xbf")
    next_snapshot = workspace.write(snapshot["path"], snapshot["text"] + "# second\r\n", snapshot["revision"], bom=True)
    with pytest.raises(WorkspaceError, match="changed on disk") as error:
        workspace.write(snapshot["path"], "stale", snapshot["revision"])
    assert error.value.details["current"]["revision"] == next_snapshot["revision"]
    assert workspace.read(snapshot["path"])["text"].endswith("# second\r\n")


def test_create_only_and_deleted_revision(workspace):
    workspace.create("src", True)
    original = workspace.create("src/a.txt")
    with pytest.raises(WorkspaceError):
        workspace.write("src/a.txt", "clobber", None)
    (workspace.root / "src/a.txt").unlink()
    with pytest.raises(WorkspaceError) as error:
        workspace.write("src/a.txt", "draft", original["revision"])
    assert error.value.code == "deleted"
    workspace.write("src/a.txt", "recovered", None)
    assert workspace.read("src/a.txt")["text"] == "recovered"


@pytest.mark.parametrize("path", ["../outside", "src/../../outside", "/etc/passwd", "C:\\Windows\\win.ini", "//host/share", "a.txt:stream", "name.", "name "])
def test_rejects_path_escape(workspace, path):
    with pytest.raises(WorkspaceError):
        workspace.path(path)


def test_symlink_escape(workspace, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "private").write_text("not in project")
    try:
        (workspace.root / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("This Windows account cannot create symlinks")
    with pytest.raises(WorkspaceError) as error:
        workspace.read("link/private")
    assert error.value.code == "outside_workspace"
    assert workspace.list()["entries"][0]["available"] is False
    with pytest.raises(WorkspaceError):
        workspace.write("link/new", "bad", None)


def test_move_tree_without_overwrite(workspace):
    workspace.create("src", True)
    workspace.write("src/main.py", "pass\n", None)
    workspace.move("src", "source")
    assert workspace.read("source/main.py")["text"] == "pass\n"
    with pytest.raises(WorkspaceError):
        workspace.move("source", "source/inside")
    workspace.create("other", True)
    with pytest.raises(WorkspaceError):
        workspace.move("source", "other")


def test_binary_encoding_size_and_os_trash_failure(workspace, monkeypatch):
    for name, data, code in [("binary", b"x\0y", "binary"), ("latin", b"\xff", "encoding"), ("large", b"x" * (MAX_TEXT_BYTES + 1), "too_large")]:
        (workspace.root / name).write_bytes(data)
        with pytest.raises(WorkspaceError) as error:
            workspace.read(name)
        assert error.value.code == code
    import send2trash
    def unavailable(_path):
        raise OSError("no trash on this mount")
    monkeypatch.setattr(send2trash, "send2trash", unavailable)
    with pytest.raises(WorkspaceError) as error:
        workspace.trash("latin")
    assert error.value.code == "trash_unavailable"
    assert (workspace.root / "latin").exists()


def test_external_change_between_read_and_publish(workspace, monkeypatch):
    snapshot = workspace.write("a", "old", None)
    actual = os.fsync
    def concurrent_write(fd):
        actual(fd)
        (workspace.root / "a").write_text("agent changed this", encoding="utf-8")
    monkeypatch.setattr(os, "fsync", concurrent_write)
    with pytest.raises(WorkspaceError) as error:
        workspace.write("a", "my edit", snapshot["revision"])
    assert error.value.code == "conflict"
    assert (workspace.root / "a").read_text() == "agent changed this"
    assert not list(workspace.root.glob(".hermes-monaco-*"))

