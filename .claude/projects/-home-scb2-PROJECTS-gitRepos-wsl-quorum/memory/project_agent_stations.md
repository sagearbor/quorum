---
name: station-agent-design
description: Next session should discuss per-station AI agent design — memory, context, shared state, agentic facilitator
type: project
---

User wants to explore making each station an actual AI agent (not just a browser tab). Current state: stations are passive browser clients that submit contributions to a central FastAPI backend. LLM calls are stateless.

**Why:** User envisions per-station AI facilitators with conversational memory, context awareness, and shared documents between agents. This would be a significant new feature.

**How to apply:** Start next session by discussing agent architecture — per-station context/memory, shared state documents, whether agents coordinate peer-to-peer or through the backend, how this interacts with the existing 3-tier LLM pipeline and managed identity auth.
