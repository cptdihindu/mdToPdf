"""Backend utilities for MD2PDF session workspaces.

This package intentionally keeps FastAPI route handlers thin:
- workspace lifecycle + TTL cleanup
- safe file serving / path handling
- ZIP import/export with Zip Slip protection

Security note:
Session IDs are treated as capability tokens (unguessable UUID4). Anyone with the
session id can access that workspace, so keep them high-entropy and never log
or expose filesystem paths in responses.
"""
