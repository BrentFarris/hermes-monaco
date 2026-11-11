"""Resolve runtime metadata with Hermes's universal lock, without installing anything."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--package", type=Path, help="Check a staged package instead of the working tree")
    parser.add_argument("--uv", default="uv", help="uv executable (CI uses 0.13.5)")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    plugin = args.package.resolve() if args.package else root
    plugin_name = tomllib.loads((plugin / "pyproject.toml").read_text(encoding="utf-8-sig"))["project"]["name"]
    hermes = args.hermes_source.resolve()
    core_text = (hermes / "pyproject.toml").read_text(encoding="utf-8-sig")
    core = tomllib.loads(core_text)
    policy = core.get("tool", {}).get("uv", {})
    if "workspace" in policy or "sources" in policy:
        parser.error("Hermes now declares workspace/sources; update this compatibility check before using it")
    build = root / ".build"
    build.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dependency-check-", dir=build) as directory:
        snapshot = Path(directory).resolve()
        if not snapshot.is_relative_to(build.resolve()):
            raise RuntimeError("Dependency snapshot must stay inside the build directory")
        # Like Hermes PM, trust the shipped lock instead of applying a moving
        # release-age cutoff. Keep ALL platform markers, extras and constraints:
        # a Windows-only check misses conflicts in the Android resolution fork.
        core_text = re.sub(r"(?m)^exclude-newer(?:-package)?\s*=.*\n", "", core_text)
        name = core["project"]["name"]
        core_text += f'\n[tool.uv.workspace]\nmembers = ["plugin"]\n[tool.uv.sources]\n"{name}" = {{ workspace = true }}\n'
        (snapshot / "pyproject.toml").write_text(core_text, encoding="utf-8")
        shutil.copyfile(hermes / "uv.lock", snapshot / "uv.lock")
        (snapshot / "plugin").mkdir()
        shutil.copyfile(plugin / "pyproject.toml", snapshot / "plugin" / "pyproject.toml")
        command = [args.uv, "lock", "--project", str(snapshot), "--python", sys.executable,
                   "--no-config", "--cache-dir", str(build / "uv-cache")]
        if args.offline:
            command.append("--offline")
        result = subprocess.run(command, cwd=root, timeout=300, check=False)
        if result.returncode == 0:
            lock = tomllib.loads((snapshot / "uv.lock").read_text(encoding="utf-8"))
            packages = lock["package"]
            if not any(p["name"] == plugin_name for p in packages):
                raise RuntimeError("Resolver did not include the plugin in the lock")
            print(f"Hermes + plugin runtime dependencies resolved across the host lock's platforms ({len(packages)} packages).", flush=True)
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
