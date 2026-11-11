"""Agent half: own the backend's lifetime without adding model tools."""


def register(ctx):
    from .bootstrap import load_backend
    from hermes_constants import get_hermes_home

    backend = load_backend()
    owner = str(get_hermes_home().resolve())
    ctx.on_unload(lambda: backend.shutdown(owner))

