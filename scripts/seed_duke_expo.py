#!/usr/bin/env python3
"""Seed a fresh "Duke Tech Expo 2026" event with 3 fully-populated quorums.

Run this once before the expo so the projection shows visible activity from
minute zero — pre-generated roles, seeded contributions (with a real conflict),
and a few chat turns per station.  No code changes; pure API orchestration.

Usage:
    python3 scripts/seed_duke_expo.py
    RAILWAY_API_BASE_URL=https://staging... python3 scripts/seed_duke_expo.py

Idempotent: if "duke-tech-expo-2026" already exists, the script skips event
creation and exits 0.  Individual API failures are logged and the seed
continues — never aborts on a single 4xx/5xx.
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import ssl
import urllib.error
import urllib.request


# Build a robust SSL context.  On macOS the bundled Python interpreter ships
# without an OS-level CA root, so urllib.request fails with
# CERTIFICATE_VERIFY_FAILED against any HTTPS endpoint.  We try `certifi`
# first (Mozilla CA bundle), then fall back to ssl.create_default_context().
def _build_ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


_SSL_CTX = _build_ssl_context()


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

API_BASE = os.environ.get(
    "RAILWAY_API_BASE_URL",
    "https://quorum-api-production.up.railway.app",
).rstrip("/")

EVENT_NAME = "Duke Tech Expo 2026"
EVENT_SLUG = "duke-tech-expo-2026"

# Pause between non-trivial writes so the heat_score recompute + realtime
# broadcasts have time to flush before the next event ID lands on top.
PAUSE_SHORT = 1.0
PAUSE_LONG = 2.0


# ---------------------------------------------------------------------------
# Minimal HTTP helper — stdlib only so the script runs from a fresh checkout
# without needing pip install in front of it.
# ---------------------------------------------------------------------------


@dataclass
class HttpResult:
    ok: bool
    status: int
    data: Any = None
    error: str | None = None


def http_request(
    method: str,
    path: str,
    body: dict | None = None,
    timeout: float = 60.0,
    retries: int = 2,
) -> HttpResult:
    """HTTP wrapper with simple retry-on-network-error.  4xx/5xx returns
    immediately (those are real API errors we want to surface).  Network
    timeouts / connection refused get retried up to `retries` times — Railway
    cold starts and transient DNS hiccups otherwise abort a 5-minute seed run.
    """
    url = f"{API_BASE}{path}"
    payload = None
    headers = {"Accept": "application/json"}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    last_err: str | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
                raw = resp.read().decode("utf-8")
                status = resp.status
                try:
                    data = json.loads(raw) if raw else None
                except json.JSONDecodeError:
                    data = raw
                return HttpResult(ok=200 <= status < 300, status=status, data=data)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8") if e.fp else ""
            try:
                data = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                data = raw
            # 5xx is transient; 4xx is a real client error — return immediately.
            if 500 <= e.code < 600 and attempt < retries:
                last_err = f"HTTP {e.code} on attempt {attempt + 1}: {raw[:200]}"
                time.sleep(2.0 * (attempt + 1))
                continue
            return HttpResult(ok=False, status=e.code, data=data, error=raw)
        except (urllib.error.URLError, TimeoutError, ConnectionResetError) as e:
            last_err = f"network error on attempt {attempt + 1}: {e}"
            if attempt < retries:
                time.sleep(2.0 * (attempt + 1))
                continue
            return HttpResult(ok=False, status=0, error=last_err)

    return HttpResult(ok=False, status=0, error=last_err or "exhausted retries")


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Seed data — realistic, Duke-specific.  300-500 chars each, references real
# concerns (IRB, HIPAA, FERPA, tenure, clinical workflow, equity).
# ---------------------------------------------------------------------------


@dataclass
class QuorumSpec:
    title: str
    problem: str
    autonomy_level: float
    # Each contribution: {role_match: str (substring of role name to match),
    #                     content: str, structured_fields: dict}
    contributions: list[dict] = field(default_factory=list)
    # Each chat: {role_match, question, station_label}
    chats: list[dict] = field(default_factory=list)


QUORUMS: list[QuorumSpec] = [
    QuorumSpec(
        title="AI Ethics Training Mandate",
        problem=(
            "Should Duke require AI ethics training for all faculty and clinicians? "
            "The Provost's office is weighing a universal mandate (all faculty, clinical staff, "
            "and graduate students complete an 8-hour AI ethics module annually) versus an "
            "opt-in model with role-targeted modules. Stakeholders disagree on scope, "
            "enforcement, and whether tenure review should factor in completion."
        ),
        autonomy_level=0.5,
        contributions=[
            {
                "role_match": "ethic",
                "content": (
                    "Any responsible deployment of AI in clinical and academic settings at Duke "
                    "REQUIRES universal, mandatory ethics training. Anything less leaves us "
                    "exposed on bias, informed consent, and IRB review of model-driven studies. "
                    "I propose: 8 hours/year, mandatory, tracked in Duke@Work, with non-completion "
                    "blocking tenure review and clinical privileging renewal. Voluntary modules "
                    "have failed at every peer institution that tried them — Stanford, Penn, and "
                    "Hopkins all saw <30% uptake. We cannot afford the same outcome here."
                ),
                "structured_fields": {
                    "position": "Mandatory universal training, tied to tenure & privileging",
                    "scope": "All faculty, clinicians, grad students",
                    "enforcement": "Block tenure review and clinical privileging on non-completion",
                },
            },
            {
                "role_match": "facult",
                "content": (
                    "Tying ethics training completion to tenure review is a serious overreach "
                    "of administrative authority and will be challenged by the Faculty Senate. "
                    "I support OPT-IN modules with role-specific content — a radiologist using "
                    "AI image triage has different concerns than a humanities professor weighing "
                    "ChatGPT in undergraduate writing courses. A blanket 8-hour requirement is "
                    "punitive busywork for senior faculty who already navigate IRB and FERPA "
                    "daily. Let departments tailor the requirement to their actual AI exposure."
                ),
                "structured_fields": {
                    "position": "Opt-in, role-targeted modules — no tenure linkage",
                    "scope": "Department-discretion, AI-exposed roles only",
                    "enforcement": "None; departmental encouragement",
                },
            },
            {
                "role_match": "clinic",
                "content": (
                    "Clinical workflow context matters here. Duke Health already mandates "
                    "annual HIPAA, infection control, and EHR security training — adding another "
                    "8 hours/year on top is realistic ONLY if it counts toward existing CME "
                    "credit and is delivered in 15-minute micro-modules during clinical downtime. "
                    "We cannot pull a hospitalist off-shift for a half-day course. Recommend "
                    "asynchronous, CME-bearing, integrated into existing compliance pathways."
                ),
                "structured_fields": {
                    "position": "Mandatory but CME-bearing and async-delivered",
                    "scope": "All clinical staff (already mandatory for HIPAA etc.)",
                    "enforcement": "Same as HIPAA: blocks credentialing, not tenure",
                },
            },
        ],
        chats=[
            {
                "role_match": "ethic",
                "station": "station-a-1",
                "question": "What's the strongest peer-institution precedent for tying AI ethics training to tenure review specifically?",
            },
            {
                "role_match": "facult",
                "station": "station-a-2",
                "question": "If we go opt-in, how do we ensure humanities and social-science faculty aren't blindsided when generative AI starts impacting their syllabi?",
            },
            {
                "role_match": "clinic",
                "station": "station-a-3",
                "question": "Could the AI ethics module piggyback on the existing annual HIPAA refresh so we're not double-burdening clinical staff?",
            },
            {
                "role_match": "ethic",
                "station": "station-a-1",
                "question": "What is the IRB's current position on retrospective audits of clinician AI use, and would mandatory training change that posture?",
            },
            {
                "role_match": "facult",
                "station": "station-a-2",
                "question": "Has the Faculty Senate weighed in formally on the tenure-linkage proposal, or is this still pre-resolution?",
            },
            {
                "role_match": "clinic",
                "station": "station-a-3",
                "question": "Would a 15-minute monthly micro-module pattern get better engagement than one 8-hour annual block?",
            },
        ],
    ),
    QuorumSpec(
        title="AI Scribes in Patient Encounters",
        problem=(
            "Should Duke Health deploy AI scribes (ambient listening + LLM note generation) "
            "during outpatient visits? Pilot data from primary care shows a 1.2 hour/day "
            "reduction in pajama-time documentation, but raises questions about consent "
            "language, HIPAA BAA scope, accuracy in specialty visits, and equity of access "
            "across patient demographics."
        ),
        autonomy_level=0.0,
        contributions=[
            {
                "role_match": "patient",
                "content": (
                    "Any AI scribe deployment requires explicit, opt-in patient consent at every "
                    "visit — not a blanket clinic-entry sign. Duke's patient advisory council "
                    "has flagged concerns about: (1) recordings stored in vendor cloud, (2) "
                    "transcripts of mental-health discussions, (3) the patient's right to see "
                    "and correct the generated note before it enters the chart. HIPAA BAA "
                    "coverage alone isn't enough — we need explicit Duke Health policy on "
                    "scribe data retention, deletion on request, and patient access to logs."
                ),
                "structured_fields": {
                    "position": "Deploy with explicit per-visit opt-in consent only",
                    "concern": "Mental health visits, vendor cloud storage, retention policy",
                },
            },
            {
                "role_match": "clinic",
                "content": (
                    "The pilot data is compelling — 1.2 hours/day reclaimed is the difference "
                    "between burnout and sustainability for primary care physicians at Duke. "
                    "But the accuracy drop in specialty visits (cardiology saw 12% medication "
                    "name errors in pilot) is unacceptable for high-acuity care. Recommend "
                    "phased rollout: primary care first with mandatory same-day physician "
                    "review of every note, then expand to specialties only after we hit "
                    "<2% error rate. No fully-autonomous AI notes signed without review."
                ),
                "structured_fields": {
                    "position": "Phased rollout, primary care first, MD review required",
                    "concern": "Specialty accuracy, physician sign-off, training time",
                },
            },
        ],
        chats=[
            {
                "role_match": "patient",
                "station": "station-b-1",
                "question": "How do other AMCs handle scribe consent — is verbal opt-in at the front desk standard, or is signed paperwork required?",
            },
            {
                "role_match": "clinic",
                "station": "station-b-2",
                "question": "What's the realistic timeline to bring cardiology medication-name accuracy below 2%? Is it a training-data fix or a fundamental model limit?",
            },
            {
                "role_match": "patient",
                "station": "station-b-1",
                "question": "Does the patient advisory council have a position on whether mental-health visits should be entirely excluded from AI scribe coverage?",
            },
            {
                "role_match": "clinic",
                "station": "station-b-2",
                "question": "If we require same-day MD review of every scribe-generated note, do we still net the 1.2 hour/day savings?",
            },
        ],
    ),
    QuorumSpec(
        title="Faculty Retraining for AI-Augmented Roles",
        problem=(
            "How should Duke retrain faculty whose roles are partially replaced or augmented "
            "by AI? Examples already emerging at Duke: pathology residents using AI image "
            "pre-reads, librarians retooling to teach prompt literacy, and lecturers in "
            "intro courses competing with student ChatGPT use. Issues include retraining "
            "budget, tenure-protection for retraining periods, equity across schools, and "
            "whether retraining is voluntary or required."
        ),
        autonomy_level=1.0,
        contributions=[
            {
                "role_match": "facult",
                "content": (
                    "Duke must establish a centrally-funded AI-Augmented Role (AAR) Retraining "
                    "Fellowship, modeled on the existing Bass Society but for mid-career "
                    "faculty whose work is being reshaped by AI. Fellowships should be 6-12 "
                    "months, fully-paid, tenure-clock-paused, and OPEN to all schools — not "
                    "just Trinity. Without protected time and salary, retraining becomes "
                    "another unpaid expectation layered on faculty already managing burnout."
                ),
                "structured_fields": {
                    "position": "Establish centrally-funded AAR Retraining Fellowship",
                    "scope": "Mid-career faculty, all schools, 6-12 months protected",
                    "funding": "Central provost office, not departmental budgets",
                },
            },
            {
                "role_match": "admin",
                "content": (
                    "Budget reality check: a fully-funded fellowship at Duke median faculty "
                    "salary plus benefits runs ~$180K per slot. Even 30 fellows/year is "
                    "$5.4M against the operating budget. We need to be honest about scale — "
                    "either a smaller flagship program (5-10 fellows, highly selective) or a "
                    "broader, lighter-touch model (stipends + course-release for 50-100 "
                    "faculty/year). I lean toward the latter for equity reasons; the former "
                    "concentrates resources on faculty already best-positioned to adapt."
                ),
                "structured_fields": {
                    "position": "Broad lighter-touch program over selective flagship",
                    "scope": "50-100 faculty/year, stipends + course-release",
                    "funding": "$2-3M from central, matched by school contributions",
                },
            },
        ],
        chats=[
            {
                "role_match": "facult",
                "station": "station-c-1",
                "question": "How do we structure the fellowship so faculty in clinical departments — who can't easily step away from patient duties — can still participate?",
            },
            {
                "role_match": "admin",
                "station": "station-c-2",
                "question": "What's the realistic central-office appetite for a $5M annual line item versus the broader $2-3M model?",
            },
        ],
    ),
]


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def find_role(roles: list[dict], match: str) -> dict | None:
    """Find the first role whose name contains `match` (case-insensitive).
    Falls back to the first role if no match — never returns None when roles
    is non-empty, so seed calls always have a valid role_id.
    """
    m = match.lower()
    for r in roles:
        if m in (r.get("name") or "").lower():
            return r
    return roles[0] if roles else None


def find_or_create_event() -> dict | None:
    """Return event dict if it exists; create + return otherwise.  Returns
    None on hard failure (network / 5xx)."""
    listing = http_request("GET", "/events?include_archived=true", timeout=30.0)
    if listing.ok and isinstance(listing.data, list):
        for ev in listing.data:
            if ev.get("slug") == EVENT_SLUG:
                log(f"[event] Found existing event id={ev.get('id')} slug={ev.get('slug')} — reusing")
                return ev

    log(f"[event] Creating '{EVENT_NAME}' (slug={EVENT_SLUG})")
    create = http_request("POST", "/events", {
        "name": EVENT_NAME,
        "slug": EVENT_SLUG,
        "max_active_quorums": 5,
    }, timeout=60.0)
    if not create.ok:
        log(f"[event] FAILED to create event: status={create.status} data={create.data}")
        return None
    log(f"[event] Created event id={create.data.get('id')}")
    return create.data


def seed_quorum(event_id: str, spec: QuorumSpec, existing_titles: set[str]) -> dict:
    """Generate roles, ai-start, then seed contributions + chats.  Returns a
    summary dict with counts (always present even on partial failure).

    Idempotency: if a quorum with `spec.title` already exists for this event,
    skip the entire seed.  Prevents duplicate quorums when the script is run
    multiple times against the same event (e.g. parallel agent invocations).
    """
    summary = {
        "title": spec.title,
        "quorum_id": None,
        "roles_generated": 0,
        "contributions_seeded": 0,
        "chats_seeded": 0,
        "errors": [],
        "skipped": False,
    }

    if spec.title in existing_titles:
        log(f"\n[quorum:{spec.title}] already exists for this event — skipping")
        summary["skipped"] = True
        return summary

    log(f"\n[quorum:{spec.title}] generate-roles…")
    gen = http_request(
        "POST",
        f"/events/{event_id}/architect/generate-roles",
        {"problem": spec.problem},
        timeout=120.0,
    )
    if not gen.ok or not isinstance(gen.data, dict):
        msg = f"generate-roles failed status={gen.status} body={gen.data}"
        log(f"[quorum:{spec.title}] {msg} — skipping this quorum")
        summary["errors"].append(msg)
        return summary

    suggested_roles = gen.data.get("roles") or []
    short_title = gen.data.get("short_title") or spec.title
    summary["roles_generated"] = len(suggested_roles)
    log(f"[quorum:{spec.title}] generate-roles OK — {len(suggested_roles)} roles, short_title='{short_title}'")

    time.sleep(PAUSE_SHORT)

    log(f"[quorum:{spec.title}] ai-start (autonomy={spec.autonomy_level})…")
    start = http_request(
        "POST",
        f"/events/{event_id}/architect/ai-start",
        {
            "problem": spec.problem,
            "roles": suggested_roles,
            "mode": "auto",
            "quorum_title": spec.title,
            "autonomy_level": spec.autonomy_level,
        },
        timeout=120.0,
    )
    if not start.ok or not isinstance(start.data, dict):
        msg = f"ai-start failed status={start.status} body={start.data}"
        log(f"[quorum:{spec.title}] {msg} — skipping seeding")
        summary["errors"].append(msg)
        return summary

    quorum_id = start.data.get("quorum_id")
    summary["quorum_id"] = quorum_id
    log(f"[quorum:{spec.title}] ai-start OK — quorum_id={quorum_id}")

    time.sleep(PAUSE_LONG)

    # Re-fetch actual role IDs from the quorum (ai-start creates fresh UUIDs)
    roles_resp = http_request("GET", f"/quorums/{quorum_id}/roles")
    if not roles_resp.ok or not isinstance(roles_resp.data, list):
        msg = f"GET roles failed status={roles_resp.status} body={roles_resp.data}"
        log(f"[quorum:{spec.title}] {msg} — cannot seed without role_ids")
        summary["errors"].append(msg)
        return summary
    quorum_roles = roles_resp.data
    log(f"[quorum:{spec.title}] fetched {len(quorum_roles)} actual roles")

    # Seed contributions
    for i, c in enumerate(spec.contributions):
        role = find_role(quorum_roles, c["role_match"])
        if not role:
            summary["errors"].append(f"contribution {i}: no role matched '{c['role_match']}'")
            continue
        body = {
            "role_id": role["id"],
            "user_token": f"seed-user-{uuid.uuid4().hex[:8]}",
            "content": c["content"],
            "structured_fields": c.get("structured_fields", {}),
            "station_id": f"seed-station-{i + 1}",
        }
        r = http_request("POST", f"/quorums/{quorum_id}/contribute", body, timeout=120.0)
        if r.ok:
            summary["contributions_seeded"] += 1
            log(f"[quorum:{spec.title}] contribution {i + 1}/{len(spec.contributions)} OK (role={role.get('name')})")
        else:
            err = f"contribute {i}: status={r.status} body={r.data}"
            log(f"[quorum:{spec.title}] {err}")
            summary["errors"].append(err)
        time.sleep(PAUSE_SHORT)

    # Seed chats
    for i, ch in enumerate(spec.chats):
        role = find_role(quorum_roles, ch["role_match"])
        if not role:
            summary["errors"].append(f"chat {i}: no role matched '{ch['role_match']}'")
            continue
        body = {
            "role_id": role["id"],
            "content": ch["question"],
        }
        r = http_request(
            "POST",
            f"/quorums/{quorum_id}/stations/{ch['station']}/ask",
            body,
            timeout=120.0,
        )
        if r.ok:
            summary["chats_seeded"] += 1
            log(f"[quorum:{spec.title}] chat {i + 1}/{len(spec.chats)} OK (station={ch['station']})")
        else:
            err = f"ask {i}: status={r.status} body={r.data}"
            log(f"[quorum:{spec.title}] {err}")
            summary["errors"].append(err)
        time.sleep(PAUSE_SHORT)

    # If autonomy is high, give the loop a moment to tick a few times so the
    # chart has visible movement when Sophie opens the projection.
    if spec.autonomy_level >= 0.75:
        log(f"[quorum:{spec.title}] autonomy={spec.autonomy_level} — pausing 15s for loop ticks")
        time.sleep(15)

    return summary


def main() -> int:
    log(f"=== Duke Tech Expo 2026 seed ===")
    log(f"API base: {API_BASE}")
    log(f"Event:    {EVENT_NAME} ({EVENT_SLUG})")
    log(f"Quorums:  {len(QUORUMS)}")
    log("")

    event = find_or_create_event()
    if not event:
        log("ABORT: could not create or find event")
        return 1

    event_id = event["id"]
    event_slug = event.get("slug") or EVENT_SLUG

    # Look up existing quorum titles for this event so a re-run skips quorums
    # already created on a prior pass (parallel-agent safety).
    existing_titles: set[str] = set()
    q_ids_resp = http_request("GET", f"/events/{event_slug}/quorum-ids", timeout=30.0)
    if q_ids_resp.ok and isinstance(q_ids_resp.data, list):
        for qid in q_ids_resp.data:
            state = http_request("GET", f"/quorums/{qid}/state", timeout=30.0)
            if state.ok and isinstance(state.data, dict):
                t = (state.data.get("quorum") or {}).get("title")
                if t:
                    existing_titles.add(t)
    if existing_titles:
        log(f"[event] Existing quorum titles on this event: {sorted(existing_titles)}")

    summaries = []
    for spec in QUORUMS:
        s = seed_quorum(event_id, spec, existing_titles)
        summaries.append(s)
        time.sleep(PAUSE_LONG)

    # ----- final summary -----
    log("\n" + "=" * 72)
    log("SEED SUMMARY")
    log("=" * 72)
    log(f"Event:  {EVENT_NAME}")
    log(f"Slug:   {event_slug}")
    log(f"ID:     {event_id}")
    log("")
    for s in summaries:
        log(f"  Quorum: {s['title']}")
        if s.get("skipped"):
            log(f"    [skipped — already existed on this event]")
            continue
        log(f"    quorum_id:           {s['quorum_id']}")
        log(f"    roles_generated:     {s['roles_generated']}")
        log(f"    contributions_seeded: {s['contributions_seeded']}")
        log(f"    chats_seeded:        {s['chats_seeded']}")
        if s["errors"]:
            log(f"    errors ({len(s['errors'])}):")
            for e in s["errors"]:
                log(f"      - {e}")
        log("")

    log("Quorum URLs (prod web):")
    for s in summaries:
        if s["quorum_id"]:
            log(f"  https://quorum-web.vercel.app/event/{event_slug}/quorum/{s['quorum_id']}")
    log("")
    log(f"Display URL: https://quorum-web.vercel.app/display/{event_slug}")
    log("=" * 72)

    return 0


if __name__ == "__main__":
    sys.exit(main())
