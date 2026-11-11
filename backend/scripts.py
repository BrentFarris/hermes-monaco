from __future__ import annotations

import json
import os
import shutil
import sys

from .errors import WorkspaceError
from .files import relative_path

CONFIG_PATH = ".hermes/scripts.json"
SHELLS = {"default", "pwsh", "powershell", "cmd", "sh", "bash"}
PLATFORMS = {"windows", "linux", "macos"}
FIELDS = {"command", "cwd", "shell", "env"}


def validate_fields(value, location):
    if not isinstance(value, dict) or set(value) - FIELDS:
        raise WorkspaceError("script_config", f"{location}: expected command, cwd, shell, and/or env.")
    for name in ("command", "cwd", "shell"):
        if name in value and (not isinstance(value[name], str) or not value[name].strip() or "\0" in value[name]):
            raise WorkspaceError("script_config", f"{location}.{name} must be a nonempty string.")
    if len(value.get("command", "")) > 32_768:
        raise WorkspaceError("script_config", f"{location}.command is too long.")
    if "cwd" in value:
        relative_path(value["cwd"], allow_root=True)
    if value.get("shell", "default") not in SHELLS:
        raise WorkspaceError("script_config", f"{location}.shell must be one of {', '.join(sorted(SHELLS))}.")
    env = value.get("env", {})
    if not isinstance(env, dict) or len(env) > 128 or any(
        not isinstance(k, str) or not k or "=" in k or "\0" in k or
        not isinstance(v, str) or "\0" in v for k, v in env.items()
    ):
        raise WorkspaceError("script_config", f"{location}.env must map environment variable names to string values.")


def validate_config(config):
    if not isinstance(config, dict) or config.get("version") != 1 or set(config) - {"version", "scripts", "$schema"}:
        raise WorkspaceError("script_config", "Expected a scripts configuration with version: 1.")
    scripts = config.get("scripts")
    if not isinstance(scripts, list) or len(scripts) > 100:
        raise WorkspaceError("script_config", "scripts must be an array of at most 100 entries.")
    ids = set()
    for i, script in enumerate(scripts):
        location = f"scripts[{i}]"
        if not isinstance(script, dict) or set(script) - (FIELDS | {"id", "name", "platforms"}):
            raise WorkspaceError("script_config", f"{location} has unsupported fields.")
        for field in ("id", "name", "command"):
            if not isinstance(script.get(field), str) or not script[field].strip() or "\0" in script[field]:
                raise WorkspaceError("script_config", f"{location}.{field} must be a nonempty string.")
        if script["id"] in ids:
            raise WorkspaceError("script_config", f"Script id '{script['id']}' is duplicated.")
        ids.add(script["id"])
        validate_fields({k: v for k, v in script.items() if k in FIELDS}, location)
        platforms = script.get("platforms", {})
        if not isinstance(platforms, dict) or set(platforms) - PLATFORMS:
            raise WorkspaceError("script_config", f"{location}.platforms supports windows, linux, and macos.")
        for platform, override in platforms.items():
            validate_fields(override, f"{location}.platforms.{platform}")
    return config


def load_config(workspace):
    try:
        snapshot = workspace.read(CONFIG_PATH)
    except FileNotFoundError:
        return {"config": {"version": 1, "scripts": []}, "revision": None}
    try:
        config = json.loads(snapshot["text"])
    except json.JSONDecodeError as error:
        raise WorkspaceError("script_config", f"{CONFIG_PATH}:{error.lineno}:{error.colno}: {error.msg}") from error
    return {"config": validate_config(config), "revision": snapshot["revision"]}


def save_config(workspace, config, expected_revision):
    validate_config(config)
    with workspace.lock:
        folder = workspace.path(".hermes", mutate=True)
        folder.mkdir(exist_ok=True)
        workspace.write(CONFIG_PATH, json.dumps(config, indent=2, ensure_ascii=False) + "\n", expected_revision)
        return load_config(workspace)


def effective_script(config, script_id, platform=None):
    platform = platform or ("windows" if sys.platform == "win32" else "macos" if sys.platform == "darwin" else "linux")
    script = next((s for s in config["scripts"] if s["id"] == script_id), None)
    if script is None:
        raise WorkspaceError("script_missing", "This script no longer exists. Refresh the script list.", 404)
    override = script.get("platforms", {}).get(platform, {})
    return {**script, **override, "env": {**script.get("env", {}), **override.get("env", {})}}


def shell_arguments(command, shell="default", *, windows=None):
    windows = os.name == "nt" if windows is None else windows
    if shell == "default":
        shell = ("pwsh" if shutil.which("pwsh") else "powershell") if windows else "sh"
    executable = shutil.which(shell)
    if executable is None:
        raise WorkspaceError("shell_missing", f"The '{shell}' shell is not installed or is not on PATH.")
    if shell in ("pwsh", "powershell"):
        # -Command otherwise maps every failed native command to exit code 1.
        # Preserve the application's code, while also surfacing PowerShell errors.
        wrapped = command + "\n$hermesMonacoSucceeded = $?\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $hermesMonacoSucceeded) { exit 1 }"
        return [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", wrapped]
    if shell == "cmd":
        return [executable, "/d", "/s", "/c", command]
    if shell == "bash":
        return [executable, "--noprofile", "--norc", "-c", command]
    return [executable, "-c", command]

