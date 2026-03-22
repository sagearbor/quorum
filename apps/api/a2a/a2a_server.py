"""A2A server — FastAPI router for incoming A2A protocol requests."""

from __future__ import annotations

import logging

from fastapi import APIRouter

logger = logging.getLogger(__name__)

a2a_router = APIRouter(prefix="/a2a", tags=["a2a"])


@a2a_router.get("/")
async def a2a_root():
    """A2A discovery endpoint."""
    return {
        "protocol": "a2a",
        "version": "0.1.0",
        "name": "quorum-a2a",
        "description": "Quorum multi-agent coordination — A2A endpoint",
    }
