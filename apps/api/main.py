"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .a2a.a2a_server import a2a_router
from .coordination.factory import get_backend_name
from .routes import router
from .seed_loader import load_seed_quorum

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load seed data into Supabase (idempotent)
    logger.info("COORDINATION_BACKEND=%s", get_backend_name())
    try:
        await load_seed_quorum()
    except Exception:
        logger.exception("Seed loader failed — continuing without seed data")
    yield


app = FastAPI(
    title="Quorum API",
    version="0.1.0",
    description="Multi-agent coordination platform — backend API",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(a2a_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
