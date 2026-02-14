"""
Koyeb deployment entrypoint.
Imports the FastAPI app from server.py so uvicorn can find it as main:app
"""

from server import app

__all__ = ["app"]
