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

from quorum_a2a.a2a_server import a2a_router
from coordination.factory import get_backend_name
from routes import router
from seed_loader import load_seed_quorum
from voice_routes import router as voice_router

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Logfire observability — Pydantic's native AI observability layer.
#
# Activation model: send_to_logfire='if-token-present' means Logfire only
# ships spans to the cloud when LOGFIRE_TOKEN is set.  Without the token,
# configure() / instrument_*() are no-ops — they neither raise nor emit
# network traffic.  This keeps the import path live (so manual ``logfire.span``
# calls elsewhere in the codebase don't have to guard themselves) while
# treating the cloud sink as opt-in.
#
# Service identity:
#   service_name    — LOGFIRE_SERVICE_NAME or 'quorum-api' (set BEFORE
#                     ``logfire.configure()`` runs by environment, so we
#                     read it here for the explicit-arg path).
#   service_version — QUORUM_VERSION (defaults to 'dev').
#
# All instrumentation is wrapped in try/except — observability MUST NOT
# break the application boot path.  If the logfire package isn't installed
# (e.g. minimal CI image), the whole block silently degrades.
# ---------------------------------------------------------------------------
def _configure_logfire(app: FastAPI) -> bool:
    """Initialise Logfire + auto-instrument FastAPI + Pydantic AI.

    Returns True when Logfire was configured (regardless of whether a token
    was present), False when the logfire package is unavailable.  Errors are
    swallowed and logged at WARNING — observability never breaks the API.
    """
    try:
        import logfire  # type: ignore[import-not-found]
    except ImportError:
        logger.info("logfire package not installed — observability disabled")
        return False

    try:
        logfire.configure(
            service_name=os.environ.get("LOGFIRE_SERVICE_NAME", "quorum-api"),
            service_version=os.environ.get("QUORUM_VERSION", "dev"),
            # No-op (no network) when LOGFIRE_TOKEN is unset.  Spans are still
            # emitted into the local OpenTelemetry pipeline so ``logfire.span``
            # context managers stay functional for in-process debugging.
            send_to_logfire="if-token-present",
        )
    except Exception:  # noqa: BLE001 — observability must never fail boot
        logger.warning("logfire.configure() raised — observability disabled", exc_info=True)
        return False

    # Auto-instrument the FastAPI app — captures every route as a span with
    # method/path/status_code attributes.  Pulled in via the logfire[fastapi]
    # extra (opentelemetry-instrumentation-fastapi).
    try:
        logfire.instrument_fastapi(app)
    except Exception:  # noqa: BLE001
        logger.warning("logfire.instrument_fastapi failed", exc_info=True)

    # Auto-instrument Pydantic AI — captures every Agent.run() as a span with
    # model, token usage, and tool-call details.  Pydantic AI ships the hook
    # natively, so this is a single call (no agent-by-agent wiring).
    try:
        logfire.instrument_pydantic_ai()
    except Exception:  # noqa: BLE001
        logger.warning("logfire.instrument_pydantic_ai failed", exc_info=True)

    if os.environ.get("LOGFIRE_TOKEN"):
        logger.info(
            "Logfire observability enabled (service=%s version=%s)",
            os.environ.get("LOGFIRE_SERVICE_NAME", "quorum-api"),
            os.environ.get("QUORUM_VERSION", "dev"),
        )
    else:
        logger.debug(
            "LOGFIRE_TOKEN not set — Logfire configured in no-send mode "
            "(local spans only; set LOGFIRE_TOKEN to ship to cloud)"
        )
    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load seed data into Supabase (idempotent)
    logger.info("COORDINATION_BACKEND=%s", get_backend_name())
    try:
        await load_seed_quorum()
    except Exception:
        logger.exception("Seed loader failed — continuing without seed data")

    # Opt-in: reclaim autonomy loops that were running when the previous
    # process died (heartbeat older than 60s). Off by default — operators
    # set AUTONOMY_LOOP_RECLAIM_ORPHANS=true in single-worker deployments
    # where they're confident no other worker still owns the lease.
    # See migration 20260513000004_autonomy_loops.sql.
    if os.environ.get("AUTONOMY_LOOP_RECLAIM_ORPHANS", "false").lower() in (
        "true",
        "1",
        "yes",
    ):
        try:
            from autonomy_loop import reclaim_orphaned_autonomy_loops

            reclaimed = await reclaim_orphaned_autonomy_loops()
            if reclaimed:
                logger.info(
                    "Reclaimed %d orphaned autonomy loop(s): %s",
                    len(reclaimed),
                    reclaimed,
                )
        except Exception:
            logger.exception(
                "Autonomy-loop reclaim failed — running quorums may need manual restart"
            )
    yield


app = FastAPI(
    title="Quorum API",
    version="0.1.0",
    description="Multi-agent coordination platform — backend API",
    lifespan=lifespan,
)

# Wire Logfire BEFORE middleware / routers so instrument_fastapi can hook
# every route.  Returns False (and logs) if logfire isn't installed — never
# raises into the boot path.
_configure_logfire(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(a2a_router)
app.include_router(voice_router)

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


@app.get("/")
async def root():
    return {"name": "Quorum API", "status": "ok", "docs": "/docs", "version": "2.0"}

@app.get("/health")
async def health():
    return {"status": "ok"}
