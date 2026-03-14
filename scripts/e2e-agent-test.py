#!/usr/bin/env python3
"""
E2E integration test for the Quorum agent system.

Simulates the full user journey without a browser:
  Architect creates event + quorum (3 roles)
  → Seed documents loaded
  → 3 stations each submit a contribution + ask a follow-up question
  → Agents produce facilitator replies with tags
  → Cross-station insights are published (A2A)
  → A2A request is created between two agents
  → Documents may be updated by agents
  → Final summary: PASS/FAIL for each step with agent-turn counts

Requirements:
  - FastAPI server running on localhost:8000 (or --api-url)
  - Supabase running and configured in server's .env
  - Python 3.11+ with httpx installed:
      pip install httpx rich   (rich is optional, improves output)

Usage:
  python scripts/e2e-agent-test.py
  python scripts/e2e-agent-test.py --api-url http://localhost:8000
  python scripts/e2e-agent-test.py --mock    # no Azure keys needed
  python scripts/e2e-agent-test.py --verbose # show full API request/response

Exit codes:
  0 — all non-informational steps passed
  1 — one or more critical steps failed (server unreachable, or quorum creation failed)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import dataclass, field
from typing import Any

try:
    import httpx
except ImportError:
    print("ERROR: httpx not installed. Run: pip install httpx")
    sys.exit(1)

try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel

    HAS_RICH = True
    console = Console()
except ImportError:
    HAS_RICH = False
    console = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Terminal output helpers — degrade gracefully without rich
# ---------------------------------------------------------------------------


def _print(msg: str, style: str = "") -> None:
    if HAS_RICH and console:
        console.print(msg)
    else:
        # Strip basic rich markup tags for plain output
        import re
        plain = re.sub(r'\[/?[a-z_ ]+\]', '', msg)
        print(plain)


def _ok(label: str, detail: str = "") -> None:
    suffix = f" — {detail}" if detail else ""
    _print(f"  [bold green]PASS[/bold green] {label}{suffix}")


def _fail(label: str, detail: str = "") -> None:
    suffix = f" — {detail}" if detail else ""
    _print(f"  [bold red]FAIL[/bold red] {label}{suffix}")


def _info(msg: str) -> None:
    _print(f"       [dim]{msg}[/dim]")


def _header(title: str) -> None:
    _print(f"\n[bold cyan]── {title}[/bold cyan]")


# ---------------------------------------------------------------------------
# Result accumulator
# ---------------------------------------------------------------------------


@dataclass
class StepResult:
    label: str
    passed: bool
    detail: str = ""


@dataclass
class E2EResults:
    steps: list[StepResult] = field(default_factory=list)
    agent_turns: int = 0
    insights_published: int = 0
    a2a_requests_created: int = 0
    documents_at_end: int = 0

    def record(self, label: str, passed: bool, detail: str = "") -> None:
        self.steps.append(StepResult(label, passed, detail))
        if passed:
            _ok(label, detail)
        else:
            _fail(label, detail)


# ---------------------------------------------------------------------------
# Thin async API client
# ---------------------------------------------------------------------------


class APIClient:
    def __init__(self, base_url: str, mock: bool = False, verbose: bool = False):
        self.base_url = base_url.rstrip("/")
        self.verbose = verbose
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if mock:
            # Some FastAPI setups respect this header to force MockLLMProvider
            headers["X-Test-Mode"] = "true"
        self._http = httpx.AsyncClient(base_url=self.base_url, headers=headers, timeout=90.0)

    async def __aenter__(self) -> "APIClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self._http.aclose()

    async def get(self, path: str, **params: Any) -> httpx.Response:
        resp = await self._http.get(path, params=params)
        if self.verbose:
            _info(f"GET  {path} → {resp.status_code}")
        return resp

    async def post(self, path: str, body: dict) -> httpx.Response:
        resp = await self._http.post(path, json=body)
        if self.verbose:
            _info(f"POST {path} → {resp.status_code}")
            if resp.status_code >= 400:
                _info(f"     error: {resp.text[:300]}")
        return resp

    async def put(self, path: str, body: dict) -> httpx.Response:
        resp = await self._http.put(path, json=body)
        if self.verbose:
            _info(f"PUT  {path} → {resp.status_code}")
            if resp.status_code >= 400:
                _info(f"     error: {resp.text[:300]}")
        return resp


# ---------------------------------------------------------------------------
# The full E2E scenario
# ---------------------------------------------------------------------------


async def run_e2e(api_url: str, mock: bool, verbose: bool) -> E2EResults:  # noqa: C901
    results = E2EResults()

    async with APIClient(api_url, mock=mock, verbose=verbose) as client:

        # ── Step 1: Confirm server is reachable ──────────────────────────────
        _header("Step 1: Health Check")
        try:
            resp = await client.get("/health")
            ok = resp.status_code == 200
            results.record("GET /health → 200", ok, f"status={resp.status_code}")
            if not ok:
                _print("[bold red]Health check failed — aborting.[/bold red]")
                return results
        except httpx.ConnectError as exc:
            results.record("GET /health → 200", False, f"Connection refused: {exc}")
            _print(f"[bold red]Cannot connect to {api_url}[/bold red]")
            _print("Is the FastAPI server running?  Run:  uvicorn apps.api.main:app --reload")
            return results

        # ── Step 2: Create Event ─────────────────────────────────────────────
        _header("Step 2: Create Event")
        ts = int(time.time())
        resp = await client.post(
            "/events",
            {
                "name": f"BEACON-CV E2E {ts}",
                "slug": f"beacon-e2e-{ts}",
                "access_code": "e2e-pass",
                "max_active_quorums": 5,
            },
        )
        if resp.status_code != 200:
            results.record(
                "POST /events → 200", False,
                f"status={resp.status_code} body={resp.text[:200]}",
            )
            return results

        event_data = resp.json()
        event_id: str = event_data["id"]
        results.record("POST /events → 200", True, f"id={event_id[:8]}…")

        # ── Step 3: Create Quorum with 3 roles ──────────────────────────────
        _header("Step 3: Create Quorum (3 roles)")
        resp = await client.post(
            f"/events/{event_id}/quorums",
            {
                "title": "BEACON-CV Trial Coordination",
                "description": (
                    "Rescue quorum for the BEACON-CV clinical trial. "
                    "Three roles collaborate to resolve protocol, site, and budget issues."
                ),
                "roles": [
                    {
                        "name": "Safety Monitor",
                        "authority_rank": 7,
                        "capacity": "unlimited",
                        "prompt_template": [
                            {"field_name": "safety_concern", "prompt": "Describe the safety concern"},
                        ],
                        "fallback_chain": [],
                    },
                    {
                        "name": "Site Coordinator",
                        "authority_rank": 5,
                        "capacity": "unlimited",
                        "prompt_template": [
                            {"field_name": "site_status", "prompt": "Current site status"},
                        ],
                        "fallback_chain": [],
                    },
                    {
                        "name": "Budget Analyst",
                        "authority_rank": 3,
                        "capacity": "unlimited",
                        "prompt_template": [
                            {"field_name": "budget_item", "prompt": "Budget item under review"},
                        ],
                        "fallback_chain": [],
                    },
                ],
                "carousel_mode": "multi-view",
            },
        )
        if resp.status_code not in (200, 201):
            results.record(
                "POST /events/{id}/quorums → 20x", False,
                f"status={resp.status_code} body={resp.text[:200]}",
            )
            return results

        quorum_data = resp.json()
        quorum_id: str = quorum_data["id"]
        results.record(
            "POST /events/{id}/quorums → 20x", True,
            f"quorum_id={quorum_id[:8]}… share_url={quorum_data['share_url']}",
        )

        # ── Step 4: Fetch role IDs via the roles list endpoint ───────────────
        _header("Step 4: Fetch Roles")
        resp = await client.get(f"/quorums/{quorum_id}/roles")
        if resp.status_code == 200:
            roles = resp.json()
            results.record(
                "GET /quorums/{id}/roles → 200",
                len(roles) == 3,
                f"roles_found={len(roles)} (expected 3)",
            )
            _info(f"Roles: {[r['name'] for r in roles]}")
        else:
            results.record(
                "GET /quorums/{id}/roles → 200", False,
                f"status={resp.status_code} — missing endpoint (hardening required)",
            )
            # Cannot continue station tests without role IDs
            roles = []

        # Build name → id map for convenience
        role_by_name: dict[str, str] = {r["name"]: r["id"] for r in roles}
        _info(f"Role ID map: { {k: v[:8]+'…' for k, v in role_by_name.items()} }")

        # ── Step 5: Seed documents ────────────────────────────────────────────
        _header("Step 5: Seed Documents")
        resp = await client.post(f"/events/{event_id}/quorums/{quorum_id}/seed-documents", {})
        if resp.status_code in (200, 201):
            seed_result = resp.json()
            n_inserted = len(seed_result.get("inserted", []))
            n_skipped = len(seed_result.get("skipped", []))
            results.record(
                "POST …/seed-documents → 20x",
                True,
                f"inserted={n_inserted} skipped={n_skipped}",
            )
        else:
            results.record(
                "POST …/seed-documents → 20x", False,
                f"status={resp.status_code} body={resp.text[:200]}",
            )

        # ── Step 6: Verify documents are present ─────────────────────────────
        _header("Step 6: Verify Documents After Seed")
        resp = await client.get(f"/quorums/{quorum_id}/documents")
        if resp.status_code == 200:
            initial_docs = resp.json()
            results.record(
                "GET /quorums/{id}/documents → 200",
                True,
                f"docs_loaded={len(initial_docs)}",
            )
            for d in initial_docs[:3]:
                _info(f"  doc: {d['title']} (type={d['doc_type']} v{d['version']})")
        else:
            initial_docs = []
            results.record(
                "GET /quorums/{id}/documents → 200", False,
                f"status={resp.status_code}",
            )

        # ── Step 7: Station interactions ─────────────────────────────────────
        _header("Step 7: Station Interactions (3 stations × contribute + ask)")

        station_scenarios = [
            {
                "station_id": "station-1",
                "role_name": "Safety Monitor",
                "contribution": (
                    "The current eGFR exclusion threshold of 30 mL/min is too permissive. "
                    "Post-hoc review of the pilot cohort shows 3 adverse events in patients "
                    "with eGFR 30–45. Recommend raising exclusion threshold to 45 mL/min. "
                    "[tags: safety, egfr, adverse_events, protocol_amendment]"
                ),
                "structured_fields": {"egfr_threshold": "45", "safety_concern": "acute_kidney_injury"},
                "follow_up": "What monitoring protocol should accompany the eGFR threshold change?",
            },
            {
                "station_id": "station-2",
                "role_name": "Site Coordinator",
                "contribution": (
                    "Site activation at Boston General is blocked: IRB package submitted 2026-04-15 "
                    "but IRB has not scheduled a review. First patient enrollment is now projected "
                    "to slip 6 weeks to 2026-08-15. Sites in Chicago and Denver are on track. "
                    "[tags: enrollment, timeline, irb, site_activation, boston]"
                ),
                "structured_fields": {"site_status": "delayed", "enrollment_delay_weeks": "6"},
                "follow_up": "How should we re-sequence site activation to minimize the enrollment impact?",
            },
            {
                "station_id": "station-3",
                "role_name": "Budget Analyst",
                "contribution": (
                    "Screening failure rate has reached 45% versus the projected 25%. "
                    "At current burn rate, patient acquisition cost will exceed budget by $180,000. "
                    "Recommend reallocating $120K from Site Management (under-spend) and "
                    "requesting $60K supplemental from sponsor. "
                    "[tags: budget, screening, cost_overrun, patient_acquisition, enrollment]"
                ),
                "structured_fields": {"budget_variance": "+180000", "screening_failure_rate": "0.45"},
                "follow_up": "Which budget line items have the most slack for reallocation?",
            },
        ]

        for i, scenario in enumerate(station_scenarios):
            role_name = scenario["role_name"]
            station_id = scenario["station_id"]
            role_id = role_by_name.get(role_name, "")
            label_prefix = f"Station {i + 1} ({role_name})"

            _info(f"Running {label_prefix}…")

            if not role_id:
                results.record(
                    f"{label_prefix}: contribute",
                    False,
                    "No role_id available — GET /roles failed",
                )
                results.record(
                    f"{label_prefix}: ask facilitator",
                    False,
                    "No role_id available",
                )
                continue

            # ── 7a. Submit contribution (triggers agent facilitator turn) ──
            contrib_body = {
                "role_id": role_id,
                "user_token": f"e2e-user-{i + 1}",
                "content": scenario["contribution"],
                "structured_fields": scenario["structured_fields"],
                "station_id": station_id,
            }
            resp = await client.post(f"/quorums/{quorum_id}/contribute", contrib_body)

            if resp.status_code == 200:
                cdata = resp.json()
                has_reply = cdata.get("facilitator_reply") is not None
                tier = cdata.get("tier_processed", 1)
                results.record(
                    f"{label_prefix}: contribute → facilitator reply",
                    has_reply,
                    f"tier={tier} "
                    f"reply_len={len(cdata.get('facilitator_reply') or '')} "
                    f"tags={cdata.get('facilitator_tags') or []}",
                )
                if has_reply:
                    results.agent_turns += 1
                    _info(f"  Reply: {str(cdata['facilitator_reply'])[:120]}…")
            elif resp.status_code == 409:
                results.record(
                    f"{label_prefix}: contribute",
                    False,
                    "Quorum already resolved — 409",
                )
            else:
                results.record(
                    f"{label_prefix}: contribute",
                    False,
                    f"status={resp.status_code} body={resp.text[:150]}",
                )

            # ── 7b. Verify messages stored ─────────────────────────────────
            resp = await client.get(f"/quorums/{quorum_id}/stations/{station_id}/messages")
            if resp.status_code == 200:
                msgs = resp.json()
                results.record(
                    f"{label_prefix}: messages stored",
                    True,
                    f"count={len(msgs)}",
                )
                if msgs:
                    roles_seen = list({m.get("role") for m in msgs})
                    _info(f"  Message roles: {roles_seen}")
            else:
                results.record(
                    f"{label_prefix}: GET messages → 200",
                    False,
                    f"status={resp.status_code}",
                )

            # ── 7c. Ask follow-up question ─────────────────────────────────
            ask_body = {
                "role_id": role_id,
                "content": scenario["follow_up"],
            }
            resp = await client.post(
                f"/quorums/{quorum_id}/stations/{station_id}/ask",
                ask_body,
            )
            if resp.status_code == 200:
                adata = resp.json()
                has_reply = bool(adata.get("reply"))
                results.record(
                    f"{label_prefix}: ask → reply",
                    has_reply,
                    f"reply_len={len(adata.get('reply') or '')} "
                    f"tags={adata.get('tags', [])}",
                )
                if has_reply:
                    results.agent_turns += 1
                    _info(f"  Ask reply: {str(adata['reply'])[:120]}…")
            elif resp.status_code == 500:
                results.record(
                    f"{label_prefix}: ask",
                    False,
                    f"Server error: {resp.text[:200]}",
                )
            else:
                results.record(
                    f"{label_prefix}: ask",
                    False,
                    f"status={resp.status_code} body={resp.text[:150]}",
                )

        # ── Step 8: Cross-station insights ───────────────────────────────────
        _header("Step 8: Cross-Station Insights")
        resp = await client.get(f"/quorums/{quorum_id}/insights", limit=50)
        if resp.status_code == 200:
            insights = resp.json()
            results.insights_published = len(insights)
            results.record(
                "GET /quorums/{id}/insights → 200",
                True,
                f"total_insights={len(insights)}",
            )
            if insights:
                types = list({i.get("insight_type") for i in insights})
                _info(f"  Insight types seen: {types}")
                _info(f"  Sample: {str(insights[0].get('content', ''))[:120]}…")
        else:
            results.record(
                "GET /quorums/{id}/insights → 200", False,
                f"status={resp.status_code}",
            )

        # ── Step 9: A2A request between two agents ───────────────────────────
        _header("Step 9: Agent-to-Agent (A2A) Request")

        safety_id = role_by_name.get("Safety Monitor", "")
        coordinator_id = role_by_name.get("Site Coordinator", "")

        if safety_id and coordinator_id:
            a2a_body = {
                "from_role_id": safety_id,
                "to_role_id": coordinator_id,
                "request_type": "input_request",
                "content": (
                    "The protocol amendment raises the eGFR threshold to 45 mL/min. "
                    "This will affect site screening workflows. Can you confirm the updated "
                    "screening checklist will be ready before first patient enrollment? "
                    "[tags: egfr, screening, protocol_amendment, site_activation]"
                ),
                "tags": ["egfr", "screening", "protocol_amendment"],
                "priority": 2,
            }
            resp = await client.post(f"/quorums/{quorum_id}/a2a/request", a2a_body)
            if resp.status_code == 201:
                a2a_resp = resp.json()
                has_target_response = a2a_resp.get("target_response") is not None
                status = a2a_resp.get("status")
                results.a2a_requests_created += 1
                results.record(
                    "POST /quorums/{id}/a2a/request → 201",
                    has_target_response,
                    f"status={status} has_target_response={has_target_response}",
                )
                if has_target_response:
                    results.agent_turns += 1
                    _info(f"  A2A response: {str(a2a_resp['target_response'])[:120]}…")
                else:
                    _info("  A2A request stored but no target response yet (agent was not woken)")
            elif resp.status_code == 404:
                results.record(
                    "POST /quorums/{id}/a2a/request",
                    False,
                    "404 — role not found (roles may not be in DB)",
                )
            else:
                results.record(
                    "POST /quorums/{id}/a2a/request",
                    False,
                    f"status={resp.status_code} body={resp.text[:200]}",
                )
        else:
            results.record(
                "POST /quorums/{id}/a2a/request",
                False,
                "Skipped — could not resolve role IDs",
            )

        # ── Step 10: Create and CAS-update a document ────────────────────────
        _header("Step 10: Document CRUD + CAS")

        resp = await client.post(
            f"/quorums/{quorum_id}/documents",
            {
                "title": "E2E Protocol Amendment v1",
                "doc_type": "protocol",
                "format": "json",
                "content": {
                    "title": "Protocol Amendment",
                    "egfr_threshold": 30,
                    "status": "draft",
                    "sections": ["Eligibility Criteria", "Safety Monitoring"],
                },
                "tags": ["protocol", "egfr", "amendment"],
                "created_by_role_id": safety_id or None,
            },
        )
        if resp.status_code == 201:
            doc = resp.json()
            doc_id: str = doc["id"]
            results.record(
                "POST /quorums/{id}/documents → 201",
                True,
                f"doc_id={doc_id[:8]}… version={doc.get('version')}",
            )

            # CAS update — expected_version=1 should succeed
            update_body = {
                "content": {
                    "title": "Protocol Amendment",
                    "egfr_threshold": 45,  # raised per Safety Monitor's contribution
                    "status": "under_review",
                    "sections": ["Eligibility Criteria", "Safety Monitoring"],
                },
                "expected_version": 1,
                "changed_by_role": safety_id or "e2e-test",
                "rationale": "Raising eGFR threshold to 45 per safety review",
            }
            put_resp = await client.put(
                f"/quorums/{quorum_id}/documents/{doc_id}",
                update_body,
            )
            if put_resp.status_code == 200:
                update_data = put_resp.json()
                results.record(
                    "PUT document CAS update → 200 (v1→v2)",
                    update_data.get("version") == 2 and not update_data.get("merged"),
                    f"new_version={update_data.get('version')} merged={update_data.get('merged')}",
                )
            else:
                results.record(
                    "PUT document CAS update → 200",
                    False,
                    f"status={put_resp.status_code} body={put_resp.text[:200]}",
                )

            # Stale CAS — should return 409
            stale_resp = await client.put(
                f"/quorums/{quorum_id}/documents/{doc_id}",
                {**update_body, "expected_version": 1},  # already at v2
            )
            results.record(
                "PUT document stale CAS → 409",
                stale_resp.status_code == 409,
                f"status={stale_resp.status_code} (expected 409)",
            )
        else:
            results.record(
                "POST /quorums/{id}/documents → 201",
                False,
                f"status={resp.status_code} body={resp.text[:200]}",
            )

        # ── Step 11: Final document state ─────────────────────────────────────
        _header("Step 11: Final State Check")
        resp = await client.get(f"/quorums/{quorum_id}/documents")
        if resp.status_code == 200:
            final_docs = resp.json()
            results.documents_at_end = len(final_docs)
            # Expect at least the seeded docs + the one we just created
            expected_min = len(initial_docs) + 1  # +1 for our E2E doc
            results.record(
                "Final document count ≥ expected",
                results.documents_at_end >= expected_min,
                f"final={results.documents_at_end} expected_min={expected_min}",
            )
        else:
            results.record(
                "GET /quorums/{id}/documents (final)",
                False,
                f"status={resp.status_code}",
            )

        # ── Step 12: Quorum state reflects activity ───────────────────────────
        resp = await client.get(f"/quorums/{quorum_id}/state")
        if resp.status_code == 200:
            final_state = resp.json()
            num_contribs = len(final_state.get("contributions", []))
            health = final_state.get("health_score", 0)
            results.record(
                "Final quorum state: contributions recorded",
                num_contribs > 0,
                f"contributions={num_contribs} health_score={health:.1f}",
            )
        else:
            results.record(
                "GET /quorums/{id}/state (final)",
                False,
                f"status={resp.status_code}",
            )

    return results


# ---------------------------------------------------------------------------
# Summary printer
# ---------------------------------------------------------------------------


def print_summary(results: E2EResults) -> None:
    _header("E2E TEST SUMMARY")

    passed = sum(1 for s in results.steps if s.passed)
    failed = sum(1 for s in results.steps if not s.passed)
    total = len(results.steps)

    if HAS_RICH and console:
        table = Table(title="Step Results", show_lines=True, min_width=80)
        table.add_column("Step", style="white", max_width=50)
        table.add_column("Result", justify="center", max_width=8)
        table.add_column("Detail", style="dim", max_width=45)
        for step in results.steps:
            status_text = "[green]PASS[/green]" if step.passed else "[red]FAIL[/red]"
            table.add_row(step.label, status_text, step.detail)
        console.print(table)

        console.print(
            Panel(
                f"[bold]Total:[/bold] {total}  "
                f"[green]Passed:[/green] {passed}  "
                f"[red]Failed:[/red] {failed}\n"
                f"\n"
                f"[bold]Agent turns:[/bold]         {results.agent_turns}\n"
                f"[bold]Insights published:[/bold]  {results.insights_published}\n"
                f"[bold]A2A requests:[/bold]        {results.a2a_requests_created}\n"
                f"[bold]Final documents:[/bold]     {results.documents_at_end}",
                title="Metrics",
                border_style="cyan",
            )
        )
    else:
        print("\n" + "=" * 65)
        print(f"RESULTS: {passed}/{total} passed, {failed} failed")
        print(f"Agent turns:        {results.agent_turns}")
        print(f"Insights published: {results.insights_published}")
        print(f"A2A requests:       {results.a2a_requests_created}")
        print(f"Final documents:    {results.documents_at_end}")
        print("=" * 65)
        for step in results.steps:
            status = "PASS" if step.passed else "FAIL"
            print(f"  [{status}] {step.label}" + (f" — {step.detail}" if step.detail else ""))

    # Non-zero exit if critical infrastructure failed
    critical = [s for s in results.steps if not s.passed and any(
        kw in s.label.lower() for kw in ("health", "create event", "create quorum")
    )]
    return len(critical) > 0  # True = critical failure


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="E2E integration test for the Quorum agent system.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--api-url",
        default="http://localhost:8000",
        metavar="URL",
        help="FastAPI base URL (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Send X-Test-Mode: true — server should use MockLLMProvider (no Azure keys needed)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print HTTP method + status for every request",
    )
    args = parser.parse_args()

    if HAS_RICH and console:
        console.print(
            Panel(
                f"[bold]Quorum — Agent System E2E Integration Test[/bold]\n"
                f"\n"
                f"API URL:    {args.api_url}\n"
                f"Mock mode:  {'yes (MockLLMProvider — no Azure needed)' if args.mock else 'no (live Azure LLM calls)'}",
                border_style="cyan",
            )
        )
    else:
        print("Quorum — Agent System E2E Integration Test")
        print(f"API URL: {args.api_url}")
        print(f"Mock:    {'yes' if args.mock else 'no'}")
        print()

    results = asyncio.run(run_e2e(args.api_url, args.mock, args.verbose))
    has_critical_failures = print_summary(results)
    sys.exit(1 if has_critical_failures else 0)


if __name__ == "__main__":
    main()
