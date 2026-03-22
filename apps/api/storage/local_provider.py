"""Local filesystem storage provider — zero external dependencies."""

from __future__ import annotations

import os
from pathlib import Path

from provider import StorageProvider

# Default upload directory, relative to working directory
_DEFAULT_UPLOAD_DIR = os.path.join(".", "uploads")


class LocalStorageProvider(StorageProvider):
    """Stores files on the local filesystem under ``./uploads/{key}``.

    Files are served via a FastAPI ``StaticFiles`` mount at ``/static``.
    """

    def __init__(self, upload_dir: str | None = None) -> None:
        self._root = Path(upload_dir or _DEFAULT_UPLOAD_DIR)
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        # Prevent directory traversal
        safe = Path(key).name
        return self._root / safe

    async def upload(self, key: str, data: bytes, content_type: str) -> str:
        dest = self._path(key)
        dest.write_bytes(data)
        return self.get_url(key)

    async def download(self, key: str) -> bytes:
        dest = self._path(key)
        if not dest.exists():
            raise FileNotFoundError(f"No file stored under key: {key}")
        return dest.read_bytes()

    def get_url(self, key: str) -> str:
        safe = Path(key).name
        return f"/static/{safe}"

    async def delete(self, key: str) -> bool:
        dest = self._path(key)
        if dest.exists():
            dest.unlink()
            return True
        return False
