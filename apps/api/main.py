"""FastAPI application entry point."""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from postgrest.exceptions import APIError as PostgrestAPIError
    _HAS_POSTGREST_EXC = True
except ImportError:
    _HAS_POSTGREST_EXC = False

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

# Serve local uploads when STORAGE_PROVIDER=local (default)
if os.environ.get("STORAGE_PROVIDER", "local").lower() == "local":
    _uploads = Path("uploads")
    _uploads.mkdir(exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(_uploads)), name="static")


# ---------------------------------------------------------------------------
# Global handler: convert postgrest APIError → clean JSON HTTP response.
# Without this, any DB error (bad UUID, missing table, constraint violation)
# surfaces as a raw 500 "Internal Server Error" with no JSON body.
# ---------------------------------------------------------------------------
if _HAS_POSTGREST_EXC:
    @app.exception_handler(PostgrestAPIError)
    async def postgrest_error_handler(request: Request, exc: PostgrestAPIError) -> JSONResponse:
        code = exc.code if hasattr(exc, "code") else (exc.args[0].get("code") if exc.args else None)
        message = exc.message if hasattr(exc, "message") else str(exc)
        # Map known Postgres error codes to appropriate HTTP statuses
        _PG_STATUS_MAP = {
            "22P02": 422,  # invalid_text_representation (e.g. bad UUID)
            "23503": 409,  # foreign_key_violation
            "23505": 409,  # unique_violation
            "42P01": 500,  # undefined_table — migration not applied
        }
        http_status = _PG_STATUS_MAP.get(str(code), 500)
        logger.error(
            "postgrest APIError %s on %s %s: %s",
            code, request.method, request.url.path, message,
        )
        return JSONResponse(
            status_code=http_status,
            content={"detail": message, "pg_code": code},
        )


@app.get("/health")
async def health():
    return {"status": "ok"}
