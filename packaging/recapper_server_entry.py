"""PyInstaller entry point for the `recapper-server` sidecar.

Runs the package's own ``recapper/__main__.py`` (same as ``python -m recapper``),
so the frozen binary accepts exactly the CLI of the backend, e.g.
``recapper-server serve --host 127.0.0.1 --port 8765 --token ...``.
"""

import multiprocessing
import runpy

if __name__ == "__main__":
    multiprocessing.freeze_support()  # no-op unless something spawns worker processes
    runpy.run_module("recapper", run_name="__main__", alter_sys=True)
