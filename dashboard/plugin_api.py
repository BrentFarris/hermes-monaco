"""Hermes mounts this router at /api/plugins/hermes-monaco."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "hermes_monaco_bootstrap", Path(__file__).resolve().parents[1] / "bootstrap.py"
)
_bootstrap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bootstrap)
router = _bootstrap.load_backend().router

