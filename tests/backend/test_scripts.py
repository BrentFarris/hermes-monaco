import json
import os
import shlex
import sys
import time

import psutil
import pytest

from backend.errors import WorkspaceError
from backend.runner import ACTIVE, OUTPUT_LIMIT, Run, Runner
from backend.scripts import effective_script, load_config, save_config, validate_config


def command(script):
    executable = sys.executable
    if os.name == "nt":
        return f'& "{executable}" "{script}"'
    return f"{shlex.quote(executable)} {shlex.quote(script)}"


def wait_done(runner, run_id):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = runner.get(run_id)
        if run.status not in ACTIVE:
            return run
        time.sleep(0.025)
    raise AssertionError("Run did not finish")


def config_for(*commands):
    return {"version": 1, "scripts": [{"id": str(i), "name": f"Script {i}", "command": cmd, "cwd": ".", "env": {"HM_TEST": "hello"}} for i, cmd in enumerate(commands)]}


def test_config_roundtrip_override_and_revision(workspace):
    assert load_config(workspace)["revision"] is None
    config = config_for("base")
    config["scripts"][0]["platforms"] = {"windows": {"command": "win", "env": {"EXTRA": "yes"}}}
    saved = save_config(workspace, config, None)
    assert saved["config"] == config
    effective = effective_script(config, "0", "windows")
    assert effective["command"] == "win" and effective["env"] == {"HM_TEST": "hello", "EXTRA": "yes"}
    with pytest.raises(WorkspaceError):
        save_config(workspace, config_for("other"), None)
    assert load_config(workspace) == saved


@pytest.mark.parametrize("config", [{}, {"version": 2, "scripts": []}, config_for("a", "b") | {"scripts": [{"id": "x", "name": "x", "command": "a"}, {"id": "x", "name": "y", "command": "b"}]},
    {"version": 1, "scripts": [{"id": "x", "name": "x", "command": "a", "cwd": "../escape"}]},
    {"version": 1, "scripts": [{"id": "x", "name": "x", "command": "a", "shell": "magic"}]}])
def test_invalid_configs(config):
    with pytest.raises(WorkspaceError):
        validate_config(config)


def test_run_environment_cwd_output_and_exit(workspace, service):
    workspace.write("fixture.py", "import os, sys\nprint(os.getcwd())\nprint(os.environ['HM_TEST'])\nprint('error stream', file=sys.stderr)\nsys.exit(7)\n", None)
    saved = save_config(workspace, config_for(command("fixture.py")), None)
    result = service.runner.start(workspace, "0", saved["revision"])
    run = wait_done(service.runner, result["id"])
    assert run.exit_code == 7, run.output()
    chunks = run.output()["chunks"]
    assert "hello" in "".join(c["text"] for c in chunks)
    assert str(workspace.root) in "".join(c["text"] for c in chunks)
    assert any(c["stream"] == "stderr" and "error stream" in c["text"] for c in chunks)
    assert run.output(run.cursor)["chunks"] == []


def test_duplicate_concurrent_stop_and_children(workspace, service):
    workspace.write("child.py", "import time\ntime.sleep(60)\n", None)
    workspace.write("fixture.py", "import subprocess,sys,time\np=subprocess.Popen([sys.executable,'child.py'])\nprint(p.pid,flush=True)\ntime.sleep(60)\n", None)
    saved = save_config(workspace, config_for(command("fixture.py"), command("child.py")), None)
    result = service.runner.start(workspace, "0", saved["revision"])
    with pytest.raises(WorkspaceError) as error:
        service.runner.start(workspace, "0", saved["revision"])
    assert error.value.code == "already_running"
    second = service.runner.start(workspace, "1", saved["revision"])
    run = service.runner.get(result["id"])
    deadline = time.monotonic() + 5
    while not run.output()["chunks"] and time.monotonic() < deadline:
        time.sleep(.03)
    child_pid = int("".join(c["text"] for c in run.output()["chunks"]).strip())
    run.stop()
    assert wait_done(service.runner, run.id).status == "stopped"
    assert not psutil.pid_exists(child_pid) or psutil.Process(child_pid).status() == psutil.STATUS_ZOMBIE
    service.runner.shutdown()
    assert wait_done(service.runner, second["id"]).status == "stopped"


def test_bad_shell_and_changed_config(workspace, service):
    config = config_for("echo test")
    saved = save_config(workspace, config, None)
    with pytest.raises(WorkspaceError) as error:
        service.runner.start(workspace, "0", "old")
    assert error.value.code == "script_changed"
    config["scripts"][0]["cwd"] = "missing"
    saved = save_config(workspace, config, saved["revision"])
    run = service.runner.start(workspace, "0", saved["revision"])
    assert run["status"] == "failed" and "directory" in run["error"]


def test_output_is_bounded(workspace):
    run = Run(workspace, {"id": "x", "name": "x", "command": "x"})
    for _ in range(400):
        run.append("stdout", "x" * 4096)
    result = run.output()
    assert result["truncated"]
    assert sum(len(chunk["text"]) for chunk in result["chunks"]) <= OUTPUT_LIMIT

