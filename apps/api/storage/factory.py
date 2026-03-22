"""Storage provider factory — STORAGE_PROVIDER env var selects backend."""

from __future__ import annotations

import os

from .provider import StorageProvider

_provider: StorageProvider | None = None


def get_storage_provider() -> StorageProvider:
    """Return the configured StorageProvider singleton.

    Set ``STORAGE_PROVIDER`` env var: ``local`` (default) or ``azure_blob``.
    """
    global _provider
    if _provider is not None:
        return _provider

    backend = os.environ.get("STORAGE_PROVIDER", "local").lower()

    if backend == "local":
        from .local_provider import LocalStorageProvider
        _provider = LocalStorageProvider()
    elif backend == "azure_blob":
        from .azure_blob_provider import AzureBlobStorageProvider
        _provider = AzureBlobStorageProvider()
    else:
        raise ValueError(
            f"Unknown STORAGE_PROVIDER '{backend}'. Choose: local, azure_blob"
        )
    return _provider
