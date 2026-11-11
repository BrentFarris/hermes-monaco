import pytest

from backend.errors import WorkspaceError
from backend.search import ripgrep, search


@pytest.fixture(autouse=True)
def requires_rg():
    try:
        ripgrep()
    except WorkspaceError:
        pytest.skip("ripgrep must be installed for search integration tests")


def test_search_ignores_and_dirty_overlays(workspace):
    (workspace.root / ".git").mkdir()
    (workspace.root / ".gitignore").write_text("ignored.txt\n")
    workspace.write("main.txt", "old needle\n", None)
    workspace.write("ignored.txt", "needle\n", None)
    workspace.write("other.txt", "NEEDLE\n", None)
    result = search(workspace, "needle", overlays=[{"path": "main.txt", "text": "no match\n"}])
    assert [item["path"] for item in result["items"]] == ["other.txt"]
    result = search(workspace, "new", overlays=[{"path": "main.txt", "text": "prefix\nnew value\n"}])
    assert result["items"][0]["line"] == 2
    assert len(search(workspace, "needle", ignored=True)["items"]) == 3


def test_unicode_utf16_columns_regex_and_filters(workspace):
    workspace.write("a.py", "😀 λ needle\nneedles NEEDLE\n", None)
    workspace.write("b.txt", "needle", None)
    result = search(workspace, "needle", word=True, case=True, include=["*.py"])
    assert len(result["items"]) == 1
    assert result["items"][0]["column"] == 6
    assert result["items"][0]["endColumn"] == 12
    assert len(search(workspace, r"needl[eE]", regex=True, exclude=["*.txt"])["items"]) == 3
    with pytest.raises(WorkspaceError):
        search(workspace, "[", regex=True)


def test_fuzzy_filename_and_truncation(workspace):
    workspace.write("main_controller.py", "needle\n" * 600, None)
    assert search(workspace, "mcp", kind="files")["items"][0]["path"] == "main_controller.py"
    result = search(workspace, "needle")
    assert len(result["items"]) == 500 and result["truncated"]

