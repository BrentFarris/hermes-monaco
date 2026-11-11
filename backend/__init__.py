import atexit

from .api import router
from .runtime import shutdown

atexit.register(shutdown)

