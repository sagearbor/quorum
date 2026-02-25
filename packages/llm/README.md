# quorum-llm

Pluggable LLM provider package for Quorum. Implements the three-tier synthesis pipeline from CONTRACT.md.

## Architecture

```
Tier 1 (free)      — Deterministic keyword extraction + dedup (pure Python)
Tier 2 (cheap)     — GPT-4o-mini / Claude Haiku: conflict detection
Tier 3 (expensive) — GPT-4o / Claude Sonnet: final artifact synthesis (once per quorum)
```

## Providers

| Provider | Env Vars Required |
|----------|------------------|
| `azure` (default) | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT_T2`, `AZURE_OPENAI_DEPLOYMENT_T3` |
| `anthropic` | `ANTHROPIC_API_KEY` (optional: `ANTHROPIC_MODEL_T2`, `ANTHROPIC_MODEL_T3`) |

## Usage

```python
from quorum_llm import get_llm_provider, generate_artifact, LLMTier

# Get a provider
provider = get_llm_provider("azure")

# Direct completion
result = await provider.complete("Summarize this text...", LLMTier.CONFLICT)

# Full artifact generation pipeline
artifact = await generate_artifact(quorum, contributions, provider)
```

## Budget Handling

No upfront rate limiting. On API budget exhaustion, `BudgetExhaustedError` is raised. Use `BudgetGuard` to handle notification:

```python
from quorum_llm import BudgetGuard, guarded_complete

guard = BudgetGuard(notify=my_notify_function)
result = await guarded_complete(provider, prompt, tier, guard, event_id, fallback="")
```

## Install

```bash
pip install -e packages/llm
```

## Test

```bash
cd packages/llm
pytest
```
