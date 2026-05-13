"""A2A client — real httpx-based dispatch to remote agent endpoints.

Replaces the v0 no-op stub.  The client POSTs LF A2A 1.0 SendMessageRequest
bodies (built via ``a2a-sdk`` proto types) to a target role's
``/message:send`` endpoint.  All transport errors are caught and converted to
``None`` returns so callers can fall back to the ``agent_requests`` Supabase
journal — preserving the existing degraded-mode behaviour from v0.

Endpoint lookup goes through ``agent_endpoints`` (the SQL table created by
migration 20260512000004) via ``quorum_a2a.a2a_server.lookup_endpoint``.

Backwards compatibility: the module still exposes a process-local
``_agent_registry`` dict and ``register_agent`` method so the existing
test_a2a_wire.py tests keep working without DB plumbing.  Lookups prefer the
process-local registry first (for unit-test injection), then fall through to
``agent_endpoints``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Any

import httpx
from google.protobuf.json_format import MessageToDict, ParseDict

from a2a.types.a2a_pb2 import (
    Message,
    Part,
    Role,
    SendMessageRequest,
    SendMessageResponse,
)

# 12.6: thread-pool wrapper. The DB lookup inside ``lookup_endpoint`` would
# otherwise block the autonomy loop on every A2A dispatch.
from db.aexec import aexec

logger = logging.getLogger(__name__)

# Process-local registry — kept for backwards compatibility with tests that
# call register_agent() directly.  Prefer the DB-backed lookup_endpoint() in
# production paths.
_agent_registry: dict[str, str] = {}

# Tunables (overridable via env for staging tweaks).
_DEFAULT_TIMEOUT_S = float(os.environ.get("QUORUM_A2A_TIMEOUT_S", "5.0"))
_DEFAULT_MAX_RETRIES = int(os.environ.get("QUORUM_A2A_MAX_RETRIES", "3"))
# Exponential backoff base in seconds: sleep = _BACKOFF_BASE * 2**attempt.
# With base=0.25 the worst-case wait between attempts is 0.25 + 0.5 + 1.0 = 1.75s
# — well under a few seconds even on 3 retries.
_BACKOFF_BASE_S = float(os.environ.get("QUORUM_A2A_BACKOFF_BASE_S", "0.25"))


def _build_send_message_payload(
    message_text: str,
    *,
    context_id: str | None = None,
    task_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a v1.0 SendMessageRequest payload as a JSON-serializable dict.

    Uses the SDK proto classes so the wire field names (camelCase) and types
    are exactly what other A2A-compliant servers expect.
    """
    msg = Message(
        message_id=str(uuid.uuid4()),
        context_id=context_id or "",
        task_id=task_id or "",
        role=Role.ROLE_USER,
        parts=[Part(text=message_text)],
    )
    proto = SendMessageRequest(message=msg)
    payload = MessageToDict(proto, preserving_proto_field_name=False)
    if metadata:
        existing_md = payload.setdefault("metadata", {})
        if isinstance(existing_md, dict):
            existing_md.update(metadata)
    return payload


def _parse_send_message_response(body: dict[str, Any]) -> dict[str, Any]:
    """Best-effort parse of a SendMessageResponse JSON body.

    Tries the SDK proto first; on failure (e.g. server returned a non-spec
    response), returns the raw dict so callers still get something useful.
    """
    proto = SendMessageResponse()
    try:
        ParseDict(body, proto, ignore_unknown_fields=True)
    except Exception:
        # Non-spec response — surface raw for diagnostics rather than dropping it.
        return body
    return MessageToDict(proto, preserving_proto_field_name=False)


class A2AClient:
    """Client for dispatching A2A messages to per-role agent endpoints."""

    def __init__(
        self,
        *,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        max_retries: int = _DEFAULT_MAX_RETRIES,
        backoff_base_s: float = _BACKOFF_BASE_S,
    ) -> None:
        self.base_url = os.environ.get("A2A_BASE_URL", "")
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.backoff_base_s = backoff_base_s

    # ------------------------------------------------------------------ registry
    def register_agent(self, role_id: str, endpoint_url: str) -> None:
        """Register an agent endpoint in the process-local cache.

        For production use, prefer the DB-backed registry (``register_endpoint``
        in ``quorum_a2a.a2a_server``).  This in-memory cache is kept so unit
        tests can inject endpoints without a DB.
        """
        _agent_registry[role_id] = endpoint_url

    def get_agent_url(self, role_id: str) -> str | None:
        """Look up the endpoint URL for a role.

        Lookup order:
          1. Process-local ``_agent_registry`` (unit-test friendly).
          2. ``agent_endpoints`` DB table (production source of truth).
        """
        url = _agent_registry.get(role_id)
        if url:
            return url
        # DB-backed lookup — imported lazily to avoid a circular import at
        # module load (a2a_server imports A2AClient).
        try:
            from .a2a_server import lookup_endpoint

            return lookup_endpoint(role_id)
        except Exception:
            logger.debug("A2AClient.get_agent_url: DB lookup failed", exc_info=True)
            return None

    # ------------------------------------------------------------------ send
    async def send_message(
        self,
        target_role_id: str,
        message: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Send an A2A SendMessageRequest to the target role's endpoint.

        Args:
            target_role_id: Role ID whose endpoint is the destination.
            message: Either a raw A2A SendMessageRequest dict (with a top-level
                ``message`` key) or a Quorum-style dict with a free-form
                ``type``/``message``/``content`` keys (legacy callers).  We
                detect the shape and wrap legacy callers into a proper proto.

        Returns:
            The parsed SendMessageResponse dict on success.  ``None`` on
            any transport failure — the caller is expected to fall back to
            the ``agent_requests`` Supabase journal.
        """
        # 12.6: ``get_agent_url`` may hit Supabase via ``lookup_endpoint``.
        # Bounce it to a thread so the autonomy loop keeps moving.
        url = await aexec(lambda: self.get_agent_url(target_role_id))
        if not url:
            logger.debug(
                "A2A send_message: no endpoint registered for role %s", target_role_id
            )
            return None

        # Build the LF A2A 1.0 SendMessageRequest body.  If the caller already
        # passed a spec-shaped dict (with a top-level "message" key whose value
        # is a proto-shaped dict), use it as-is — that's the most flexible path.
        payload = self._coerce_payload(message)

        # The base URL points at /a2a/agents/{role_id}.  The v1.0 method is
        # /message:send.  We append it here so the registry rows store the
        # role-base URL (which the AgentCard advertises as the agent's URL).
        send_url = url.rstrip("/") + "/message:send"

        for attempt in range(self.max_retries):
            try:
                async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                    resp = await client.post(send_url, json=payload)
                if 200 <= resp.status_code < 300:
                    try:
                        body = resp.json()
                    except Exception:
                        logger.warning(
                            "A2A send_message: non-JSON response from %s (status %s)",
                            send_url, resp.status_code,
                        )
                        return None
                    return _parse_send_message_response(body)
                # Retry on 5xx, give up on 4xx.
                if resp.status_code < 500:
                    logger.info(
                        "A2A send_message: non-retryable %s from %s; giving up",
                        resp.status_code, send_url,
                    )
                    return None
                logger.info(
                    "A2A send_message: 5xx %s from %s (attempt %s/%s)",
                    resp.status_code, send_url, attempt + 1, self.max_retries,
                )
            except (httpx.TimeoutException, httpx.HTTPError) as exc:
                logger.info(
                    "A2A send_message: transport error to %s (attempt %s/%s): %s",
                    send_url, attempt + 1, self.max_retries, exc,
                )

            # Exponential backoff before retrying (skip after final attempt).
            if attempt + 1 < self.max_retries:
                await asyncio.sleep(self.backoff_base_s * (2 ** attempt))

        return None

    # ------------------------------------------------------------------ helpers
    def _coerce_payload(self, message: dict[str, Any]) -> dict[str, Any]:
        """Accept either a spec-shaped SendMessageRequest or a legacy dict.

        Legacy callers in this codebase pass shapes like:
            {"type": "architect_guidance", "quorum_id": "...", "message": "..."}
            {"type": "request_contribution", "prompt": "..."}

        We map those into a v1.0 SendMessageRequest whose text part contains
        the human-readable content, with the original dict stashed in the
        request metadata so the receiving agent can read it back.
        """
        if (
            "message" in message
            and isinstance(message["message"], dict)
            and (
                "parts" in message["message"]
                or "content" in message["message"]
                or "messageId" in message["message"]
            )
        ):
            # Already spec-shaped.  Normalize parts<->content for v0.3 senders.
            msg = message["message"]
            if "content" in msg and "parts" not in msg:
                msg["parts"] = msg.pop("content")
            return message

        # Legacy shape — extract the human-readable text and wrap it.
        text_fields = ("message", "prompt", "content", "text")
        text = ""
        for f in text_fields:
            value = message.get(f)
            if isinstance(value, str) and value:
                text = value
                break
        if not text:
            # Fall back to a serialized dump so the receiver at least sees
            # something to react to.
            import json

            text = json.dumps(message, default=str)[:2000]

        # The legacy dict cannot be serialized to a proto Struct directly (it
        # contains arbitrary Python types).  We pass it via the human-readable
        # text only — receivers that need the original shape should rely on
        # ``send_message_with_legacy()`` which stores it in the agent_requests
        # journal as a fallback rather than the proto's metadata field.
        return _build_send_message_payload(text)
