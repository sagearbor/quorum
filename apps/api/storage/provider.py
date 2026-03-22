"""Abstract storage provider interface."""

from __future__ import annotations

from abc import ABC, abstractmethod


class StorageProvider(ABC):
    """Pluggable file storage backend.

    Implementations: LocalStorageProvider, AzureBlobStorageProvider.
    """

    @abstractmethod
    async def upload(self, key: str, data: bytes, content_type: str) -> str:
        """Store data under *key*, return its public URL."""

    @abstractmethod
    async def download(self, key: str) -> bytes:
        """Retrieve raw bytes for *key*."""

    @abstractmethod
    def get_url(self, key: str) -> str:
        """Return the URL where *key* can be fetched."""

    @abstractmethod
    async def delete(self, key: str) -> bool:
        """Delete *key*. Return True if it existed."""
