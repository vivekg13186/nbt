"""REST + WebSocket API for NBT, used by the Vite web UI (webui/).

Wraps the existing nbt.core (Database, Engine, NodeRegistry, FlowListener)
so a separate single-page app can drive the same engine the NiceGUI UI uses.
"""

from .server import create_app

__all__ = ["create_app"]
