"""Azure Blob Storage provider.

Auth (checked in order):
    1. DefaultAzureCredential (managed identity / ``az login``)
    2. AZURE_STORAGE_CONNECTION_STRING (fallback for local dev against Azurite)

Requires: ``pip install azure-storage-blob`` (in requirements-azure.txt).
"""

from __future__ import annotations

import os

from provider import StorageProvider

_DEFAULT_CONTAINER = "quorum-files"


class AzureBlobStorageProvider(StorageProvider):
    """Azure Blob Storage backend."""

    def __init__(
        self,
        account_name: str | None = None,
        container_name: str | None = None,
        connection_string: str | None = None,
    ) -> None:
        try:
            from azure.storage.blob.aio import BlobServiceClient
        except ImportError as exc:
            raise ImportError(
                "azure-storage-blob is required for Azure Blob storage. "
                "Run: pip install azure-storage-blob"
            ) from exc

        self._container = container_name or os.environ.get(
            "AZURE_STORAGE_CONTAINER", _DEFAULT_CONTAINER
        )

        conn_str = connection_string or os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
        if conn_str:
            self._service = BlobServiceClient.from_connection_string(conn_str)
        else:
            account = account_name or os.environ["AZURE_STORAGE_ACCOUNT"]
            account_url = f"https://{account}.blob.core.windows.net"
            try:
                from azure.identity.aio import DefaultAzureCredential
            except ImportError as exc:
                raise ImportError(
                    "azure-identity is required for DefaultAzureCredential auth. "
                    "Run: pip install azure-identity"
                ) from exc
            self._service = BlobServiceClient(account_url, credential=DefaultAzureCredential())

        self._account_url = getattr(self._service, "url", "")

    def _blob(self, key: str):
        return self._service.get_blob_client(container=self._container, blob=key)

    async def upload(self, key: str, data: bytes, content_type: str) -> str:
        blob = self._blob(key)
        await blob.upload_blob(
            data,
            overwrite=True,
            content_settings={"content_type": content_type},
        )
        return self.get_url(key)

    async def download(self, key: str) -> bytes:
        blob = self._blob(key)
        stream = await blob.download_blob()
        return await stream.readall()

    def get_url(self, key: str) -> str:
        return f"{self._account_url}/{self._container}/{key}"

    async def delete(self, key: str) -> bool:
        blob = self._blob(key)
        try:
            await blob.delete_blob()
            return True
        except Exception:
            return False
