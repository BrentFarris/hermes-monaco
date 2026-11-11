import os
from pathlib import Path
import threading

from .errors import WorkspaceError
from .files import Workspace
from .runner import Runner


class Services:
    def __init__(self):
        self.workspaces = {}
        self.lock = threading.RLock()
        self.search_slots = threading.BoundedSemaphore(3)
        self.runner = Runner()

    def bind(self, cwd):
        canonical = os.path.normcase(str(Path(cwd).expanduser().resolve()))
        with self.lock:
            for workspace in self.workspaces.values():
                if os.path.normcase(str(workspace.root)) == canonical:
                    workspace.check()
                    return workspace.describe()
            if len(self.workspaces) >= 256:
                raise WorkspaceError("workspace_limit", "Too many workspaces are open. Restart the backend to release unused workspaces.", 429)
            workspace = Workspace(cwd)
            self.workspaces[workspace.id] = workspace
            return workspace.describe()

    def workspace(self, workspace_id):
        with self.lock:
            workspace = self.workspaces.get(workspace_id)
        if workspace is None:
            raise WorkspaceError("workspace_missing", "The workspace binding expired. Reopen Code to reconnect.", 404)
        workspace.check()
        return workspace


_services = {}
_lock = threading.RLock()


def services_for(owner):
    with _lock:
        key = str(owner)
        if key not in _services:
            _services[key] = Services()
        return _services[key]


def current_services():
    # Resolve inside the request's Hermes profile scope, never at module import
    # or inside a later worker thread after that scope has ended.
    from hermes_constants import get_hermes_home
    return services_for(str(get_hermes_home().resolve()))


def shutdown(owner=None):
    with _lock:
        retired = list(_services.values()) if owner is None else [_services[owner]] if owner in _services else []
        if owner is None:
            _services.clear()
        else:
            _services.pop(owner, None)
    for service in retired:
        service.runner.shutdown()

