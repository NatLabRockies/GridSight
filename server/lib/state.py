"""Shared server state initialized at import time.

Holds module-level singletons (currently just `storage`) so that
route modules can import them without circular dependency on app.py.
"""
from lib.storage import create_storage_handler

storage = create_storage_handler()
