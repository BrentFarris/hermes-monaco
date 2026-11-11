"""Load this package's backend once across Hermes's two plugin import doors."""
import _imp
import hashlib
import importlib.util
from pathlib import Path
import sys


def load_backend():
    root = Path(__file__).resolve().parent
    name = "hermes_monaco_backend_" + hashlib.sha256(str(root).encode()).hexdigest()[:16]
    # Hermes imports the agent entry and dashboard API with different synthetic
    # names. A package-owned name shares services without changing sys.path.
    _imp.acquire_lock()
    try:
        if name in sys.modules:
            return sys.modules[name]
        spec = importlib.util.spec_from_file_location(
            name, root / "backend" / "__init__.py",
            submodule_search_locations=[str(root / "backend")],
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(name, None)
            raise
        return module
    finally:
        _imp.release_lock()

