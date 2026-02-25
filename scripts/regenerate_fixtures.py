#!/usr/bin/env python3
"""Regenerate golden test fixtures by running real LLM API calls.

Usage:
    # Requires AZURE_OPENAI_* or ANTHROPIC_API_KEY env vars set
    python scripts/regenerate_fixtures.py [--provider azure|anthropic]

    # Or with mock (useful for verifying fixture format without API costs)
    QUORUM_TEST_MODE=true python scripts/regenerate_fixtures.py

Outputs updated JSON files to tests/fixtures/.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Ensure packages are importable
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "llm"))

from quorum_llm import (
    Contribution,
    LLMTier,
    Quorum,
    Role,
    detect_conflicts,
    generate_artifact,
    get_llm_provider,
)

FIXTURES_DIR = ROOT / "tests" / "fixtures"


def _load_fixture(name: str) -> dict:
    path = FIXTURES_DIR / name
    with open(path) as f:
        return json.load(f)


def _save_fixture(name: str, data: dict) -> None:
    path = FIXTURES_DIR / name
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  Written: {path}")


async def regenerate_tier2(provider) -> None:
    print("\n--- Regenerating tier2_conflict.json ---")
    fixture = _load_fixture("tier2_conflict.json")
    inp = fixture["input"]

    roles = [Role(**r) for r in inp["roles"]]
    contribs = [Contribution(**c) for c in inp["contributions"]]

    conflicts = await detect_conflicts(contribs, roles, provider)

    if conflicts:
        c = conflicts[0]
        fixture["expected_output"] = {
            "has_conflict": True,
            "description": c.description,
            "severity": c.severity,
        }
    else:
        fixture["expected_output"] = {
            "has_conflict": False,
            "description": "No conflicts detected.",
            "severity": "low",
        }

    _save_fixture("tier2_conflict.json", fixture)


async def regenerate_tier3(provider) -> None:
    print("\n--- Regenerating tier3_artifact.json ---")
    fixture = _load_fixture("tier3_artifact.json")
    inp = fixture["input"]

    roles = [Role(**r) for r in inp["quorum"]["roles"]]
    contribs = [Contribution(**c) for c in inp["contributions"]]
    quorum = Quorum(
        id=inp["quorum"]["id"],
        title=inp["quorum"]["title"],
        description=inp["quorum"]["description"],
        roles=roles,
    )

    artifact = await generate_artifact(quorum, contribs, provider)

    fixture["expected_output"] = {
        "sections": [
            {"title": s.title, "content": s.content}
            for s in artifact.sections
        ]
    }

    _save_fixture("tier3_artifact.json", fixture)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Regenerate golden test fixtures")
    parser.add_argument(
        "--provider",
        default="azure",
        choices=["azure", "anthropic", "mock"],
        help="LLM provider to use (default: azure; QUORUM_TEST_MODE overrides)",
    )
    args = parser.parse_args()

    print(f"Provider: {args.provider}")
    provider = get_llm_provider(args.provider)
    print(f"Using: {type(provider).__name__}")

    await regenerate_tier2(provider)
    await regenerate_tier3(provider)

    print("\nDone. Review diffs before committing.")


if __name__ == "__main__":
    asyncio.run(main())
