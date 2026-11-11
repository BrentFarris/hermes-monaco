"""Run the real Hermes install scanner, without forcing or changing its policy."""

import argparse
from collections import Counter
from dataclasses import asdict
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True, help="Hermes source checkout containing tools/plugin_guard.py")
    parser.add_argument("--package", type=Path, help="Scan a staged package instead of the repository's distributable Git files")
    parser.add_argument("--report", type=Path, help="Save all findings as JSON")
    args = parser.parse_args()
    hermes = args.hermes_source.resolve()
    if not (hermes / "tools" / "plugin_guard.py").is_file():
        parser.error("--hermes-source must contain tools/plugin_guard.py")
    sys.path.insert(0, str(hermes))
    from tools.plugin_guard import PLUGIN_SCANNER_VERSION, scan_plugin, should_allow_plugin_install

    root = Path(__file__).resolve().parents[1]
    build = root / ".build"
    build.mkdir(exist_ok=True)
    # Git install scans a fresh checkout, without ignored development artifacts.
    # Include new, uncommitted source files too, so this works before a release.
    with tempfile.TemporaryDirectory(prefix="install-scan-", dir=build) as directory:
        snapshot = Path(directory).resolve()
        if not snapshot.is_relative_to(build.resolve()):
            raise RuntimeError("Scan snapshot must stay inside the build directory")
        if args.package:
            tree = args.package.resolve()
        else:
            tree = snapshot
            files = subprocess.check_output(
                ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root,
            ).decode("utf-8").split("\0")
            for name in sorted(set(files) - {""}):
                source, target = root / name, tree / name
                if not source.exists() and not source.is_symlink():
                    continue  # A tracked file deleted in the working tree.
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target, follow_symlinks=False)
        if not (tree / "plugin.yaml").is_file() or not (tree / "desktop" / "plugin.js").is_file():
            parser.error("Build the complete plugin before scanning")
        result = scan_plugin(tree, source="https://github.com/BrentFarris/hermes-monaco")
        allowed, reason = should_allow_plugin_install(result, force=False)
        print(f"{PLUGIN_SCANNER_VERSION}: {result.verdict}; {len(result.findings)} findings")
        print("Severities:", dict(Counter(f.severity for f in result.findings)))
        print("Install decision:", reason)
        for finding in result.findings:
            if finding.severity in {"high", "critical"}:
                print(f"{finding.severity}: {finding.file}:{finding.line}: {finding.pattern_id}: {finding.description}")
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(asdict(result), indent=2), encoding="utf-8")
        return 0 if allowed is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
