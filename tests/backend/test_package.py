import importlib.util
from pathlib import Path
import sys
import types

from backend.process_tree import ProcessTree


def load(name, path, package=False):
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[str(path.parent)] if package else None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_agent_and_dashboard_share_backend_and_profile_cleanup(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    agent = load('test_monaco_agent', root / '__init__.py', package=True)
    api = load('test_monaco_dashboard', root / 'dashboard' / 'plugin_api.py')
    fake_constants = types.ModuleType('hermes_constants')
    fake_constants.get_hermes_home = lambda: tmp_path
    monkeypatch.setitem(sys.modules, 'hermes_constants', fake_constants)
    disposers = []
    agent.register(types.SimpleNamespace(on_unload=disposers.append))
    backend = api._bootstrap.load_backend()
    assert sys.modules['test_monaco_agent.bootstrap'].load_backend() is backend
    runtime = sys.modules[backend.__name__ + '.runtime']
    mine = runtime.services_for(str(tmp_path.resolve()))
    other = runtime.services_for('another-profile')
    disposers[0]()
    assert mine.runner.closed and not other.runner.closed
    runtime.shutdown()


def test_closed_process_tree_can_be_stopped_again():
    tree = ProcessTree()
    tree.close()
    tree.stop(grace=0)
    tree.close()
