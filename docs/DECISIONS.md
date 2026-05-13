# DECISIONS.md — Append-Only Decision Log

> Format: [date] | decision | why | alternatives rejected

---

[2026-02-25] | Repo name: `quorum` under `sagearbor` | Clean, memorable, brand is Quorum not ArborQuorum | ArborQuorum (too long), quorum (not unique enough on its own without org context)

[2026-02-25] | Terminals are role-first, not scenario-first | Roles are stable (IRB, Patient); scenarios change on the fly. Tent card printed QR only needs station number. | Scenario-first terminals (brittle — requires reprinting QR per scenario)

[2026-02-25] | No forced time-flow or hierarchy in UI navigation | Many problems have no natural sequence or flat authority. Imposing structure misleads users. | Time-flow layout (rejected — doesn't generalize), authority-sorted layout (rejected — same reason)

[2026-02-25] | Single URL per station with `?station=N` param | Dumb boxes, no install, no per-scenario reprinting. Station default is a preference not a lock. | Per-scenario QR codes (brittle to on-the-fly quorum creation)

[2026-02-25] | Azure OpenAI as default LLM provider | DCRI has BAA for HIPAA compliance. Cost covered by institutional account. | Anthropic (no BAA at DCRI), OpenAI (same issue)

[2026-02-25] | LLM provider behind pluggable interface | Allow swap to Anthropic / OpenAI / local without app changes | Hardcoding Azure (limits non-DCRI deployment)

[2026-02-25] | Three-tier LLM synthesis (keyword → conflict → artifact) | Controls cost. ~3 LLM calls per quorum regardless of input count. | Per-input LLM calls (cost explosion at scale)

[2026-02-25] | API cost: graceful catch only, no upfront rate limiting | Low friction. Cost abuse unlikely in controlled event settings. Alert owner on exhaustion. | Upfront rate limiting (rejected — adds friction to normal use)

[2026-02-25] | Camera/presence detection is post-MVP | Product works as remote URL tool. Expo kiosk mode is a nice-to-have, not core value. | Camera as core feature (rejected — brittle in loud/bright expo environments)

[2026-02-25] | Role capacity: 1 (single) or unlimited (committee) | CEO needs single claim; IRB is a committee. Architect sets at quorum creation. | All roles unlimited (rejected — loses governance fidelity)

[2026-02-25] | Quorum max cap per event (configurable) | Prevents 50-idea fragmentation at expo. Creates natural "hot topic" dynamics. | No cap (rejected — fragments attention, dilutes engagement)

[2026-02-25] | Projection display as separate read-only `/display` route | Projector just loads a URL. No interaction surface. Carousel auto-rotates. | Dedicated display app (overkill), sharing architect view (exposes controls)

[2026-02-25] | Dashboard carousel: dual-panel, slides right, two modes | Always in motion. Multi-view (dashboards per quorum) or multi-quorum (same dashboard, different quorums). | Single dashboard (static, boring), manual switching (requires operator)

[2026-02-25] | Quorum Health Chart as default dashboard for every quorum | Line going up = good. Unambiguous progress signal. Drives participation via visible feedback loop. | Contribution matrix with color (rejected — red/green ambiguous without direction)

[2026-02-25] | Seed quorum: pre-built clinical trial scenario | Ensures expo has a live, polished demo even if participation is low. Rises on heat metrics by default. | No seed (cold start risk at expo)

[2026-02-25] | Proxy escalation for absent roles | Absent high-authority role shouldn't stall quorum. Fallback chain + async email approve/reject (signed JWT, no login). | Block on absence (rejected — breaks partial adoption promise)

[2026-02-25] | CONTRACT.md as machine-readable spec | Any AI agent can onboard and build a client from CONTRACT.md alone. No prose needed. | Only ARCHITECTURE.md (rejected — too narrative for AI consumption)

[2026-02-25] | `dashboard_types text[]` column on quorums table | API route accepts `dashboard_types: DashboardType[]` and ARCHITECTURE shows DashboardConfig as child of quorum. Storing as `text[]` on the quorums table is simplest — no junction table needed for a small, bounded enum set. Default `['quorum_health_chart']`. | Separate dashboard_config junction table (rejected — over-normalized for an array of enum strings), jsonb column (rejected — text[] is more queryable and type-safe for string arrays)

[2026-02-25] | DemoEngine uses plain EventEmitter pattern, not Supabase mock | Simpler, zero dependencies, no network. Components subscribe via same interface through dataProvider abstraction. | Mock Supabase client (rejected — complex to maintain, couples demo to Supabase internals), MSW/service worker (rejected — overkill for demo, adds build complexity)

[2026-02-25] | dataProvider as unified interface, components never import supabase directly | Single switching point for demo vs live mode. isDemoMode() checks env var or missing Supabase URL. Lazy-imports supabase module in live mode to avoid crashes when env vars are missing. | Direct Supabase imports with conditional checks everywhere (rejected — scattered, error-prone), context provider wrapping entire app (rejected — adds unnecessary React coupling for what's a data access pattern)

[2026-02-25] | Seed JSON at repo root `seed/clinical-trial.json` shared by frontend DemoEngine and backend seed_loader | Single source of truth. Frontend imports JSON directly; backend reads file on startup. Avoids drift between demo data and DB seed. | Separate frontend fixtures and backend SQL (rejected — data drift), API endpoint to dump fixtures (rejected — requires live backend for demo)

[2026-02-25] | Seed roles renamed to match task spec: Site Coordinator, IRB Officer, Patient Advocate, Safety Monitor, Sponsor | Task spec requires these 5 role names. Mapped from seed.sql roles (PI→Sponsor, IRB Chair→IRB Officer, Sponsor Medical Monitor→Safety Monitor). Keeps demo consistent with expo branding. | Keep seed.sql names as-is (rejected — task spec is explicit about role names)

[2026-03-14] | Responses API not used — agent conversations route through existing LLMProvider.chat() | The existing provider interface (complete + embed) is extended with chat() which accepts a message history array. Azure provider overrides chat() to use native messages parameter and get prefix caching. Avoids a separate Responses API dependency and keeps the provider swap clean. | Separate Responses API client (rejected — adds second LLM abstraction layer), direct Azure SDK calls in routes.py (rejected — bypasses provider interface)

[2026-03-14] | Agent definition format is file-based slug, not DB-FK | agent_configs.agent_slug references a filename in agents/definitions/ (e.g., "irb_officer"). This separates static archetype behaviour (prompt templates, personality) from runtime config (domain_tags, temperature). Slug can be null for ad-hoc agents without a definition file. | Fully DB-driven agent definitions (rejected — harder to version-control and diff), hardcoded prompts in system (rejected — limits architect customisation)

[2026-03-14] | Tag affinity uses two-tier scoring: Jaccard tag overlap (fast) + cosine embedding similarity (accurate) | Tag overlap is O(n) and free; runs on every message. Embedding similarity is O(1) per pair but costs API money; runs only when Jaccard score is in the 0.3–0.7 ambiguous zone. Combined score = 0.4*jaccard + 0.6*cosine. Fallback to tag-only if AZURE_OPENAI_DEPLOYMENT_T5 is unset. | Pure embedding similarity (rejected — expensive at 60-agent scale), pure keyword matching (rejected — misses semantic equivalences like "eGFR" ↔ "renal function")

[2026-03-14] | Seed documents stored as clinical-trial-documents.json separate from clinical-trial.json | clinical-trial.json is the human contributions seed (used by DemoEngine). clinical-trial-documents.json is the agent document seed (used by scripts/seed-agent-documents.py and the /seed-documents endpoint). Separating them keeps each file focused and avoids merging two very different data shapes. | Single merged seed file (rejected — JSON shape conflict, harder to maintain), documents inline in clinical-trial.json as a top-level "documents" key (rejected — DemoEngine would need to ignore them)

[2026-03-14] | Seed document problems embedded in content.metadata.problems array, not a separate table | Problems are seed data that agents are meant to discover and resolve. Storing them in the document itself means agents see the problems in their document context. A separate "known_issues" table would be invisible to agents unless explicitly queried. | Separate known_issues table (rejected — invisible to agents), no problem annotations (rejected — cold-start problem: agents have nothing to resolve)

[2026-03-14] | AgentAffinityGraph uses static circle layout in v1 (D3 force layout deferred to Track H) | The component API, props interface, and SVG rendering skeleton are stable. Only the layout engine changes in Track H. This avoids blocking Track G on a D3 bundle dependency while still delivering a testable, renderable graph. | Block Track G until D3 force layout is implemented (rejected — Track H is a separate phase), iframe/canvas approach (rejected — harder to test and style-match)

[2026-03-14] | seed-documents endpoint uses event_id + quorum_id in URL (not quorum-only) | Consistent with the existing API pattern: quorums are always accessed under their event. Prevents seeding a quorum that belongs to a different event. | Quorum-only URL /quorums/{quorum_id}/seed-documents (rejected — breaks URL convention and loses event ownership check)

[2026-05-12] | Pydantic AI as the provider implementation layer (all four providers — Azure, OpenAI, Anthropic, local/Ollama — wrapped as Pydantic AI Agents behind LLMProvider) | The hand-rolled provider code had GPT-5 vs reasoning-model branching, a broken Anthropic embed() path, and was diverging from upstream every quarter. Pydantic AI handles the per-model parameter differences (no temperature on reasoning models, Responses API for GPT-5, Anthropic system-message separation) so our business logic stays uniform. Typed agent outputs also give us structured tool-call results without bespoke parsing. | LangChain (rejected — too heavy and opinionated, drags in chain-abstractions we don't use), LiteLLM (rejected — pure routing layer, no typed agents), Vercel AI SDK (rejected — TS-only, can't run in the FastAPI backend)

[2026-05-12] | A2A protocol via Linux Foundation `a2a-sdk` 1.0.x — per-role `.well-known/agent-card.json` + `/message:send` endpoints on the same FastAPI host, with `agent_endpoints` rows pointing at the same host today | We need agent-to-agent communication for the expo demo and want to truthfully claim "A2A 1.0" on the booth signage. The official SDK gives us SendMessageRequest/Response, AgentCard, and Task protobuf types with the correct camelCase JSON wire format. One host now, multi-host later — switching only requires updating URLs in the `agent_endpoints` registry rows. `tasks/send` is kept as an alias for clients pinned to the pre-1.0 draft. | Hand-roll our own JSON envelope (rejected — won't be standards-compliant, can't claim A2A 1.0), use Azure AI Agents SDK (rejected — vendor lock-in, doesn't speak A2A), embed inside the existing `/contribute` route (rejected — conflates the human and agent dispatch paths)

[2026-05-12] | Magentic-One-style `OrchestratorAgent` (Pydantic AI typed output) replaces `random.choice` speaker election | Random speaker election produced two failure modes — topic drift (the next speaker had nothing to say about what was just said) and monopolies (the same role got picked 3 times in a row). The orchestrator scores candidates by relevance + anti-monopoly and returns `{next_role_id, narration, reason}`; the narration is the one-sentence rationale the avatar speaks while the role-agent thinks. Fallback to `antimonopoly_random_pick()` when the LLM is down so the loop never stalls. | Round-robin (rejected — ignores topic relevance entirely; the safety monitor speaks on a budget topic), pure unstructured LLM pick (rejected — no anti-monopoly guarantee, easy for the LLM to fixate)

[2026-05-12] | `agent_endpoints` registry as a DB-backed routing table (one row per `role_id` with a `url` column) replaces the process-local `_agent_registry` dict | The old in-memory dict lost state on every uvicorn restart and couldn't be queried from any process other than the FastAPI worker that created the role. Today all rows point at the same FastAPI host, but the contract is "change one row to split agents across hosts tomorrow" — the A2A client already reads URLs from this table, so multi-host is a config change, not a code change. `realtime` is enabled so dashboards can surface live agent presence. | Static config file (rejected — needs a redeploy to change), DNS / Consul / k8s service discovery (rejected — overkill for a single-host demo and adds operational complexity), keep the in-memory dict (rejected — already proven to break across workers)

[2026-05-13] | Pydantic Logfire as the observability layer (FastAPI + Pydantic AI auto-instrument, manual spans on `autonomy_round` / `process_agent_turn` / `process_a2a_request`) | Logfire is Pydantic's own product — purpose-built for Pydantic AI Agents, with native one-call instrumentation that captures model, prompts, token usage, and tool calls. We already standardised on Pydantic AI for the provider layer (see the 2026-05-12 decision), so observability comes for free. Activation is opt-in via `LOGFIRE_TOKEN`: `send_to_logfire='if-token-present'` makes the SDK a no-op without the token, and a thin `_obs.span()` shim makes the manual spans a no-op if the `logfire` package itself is missing. Free Personal tier (10M spans/month, 1 seat, 3 projects) covers the expo demo with significant headroom. | OpenTelemetry directly (rejected — would require wiring our own collector + Jaeger/Tempo backend; Logfire IS OTel-based but ships a managed UI), LangSmith (rejected — LangChain-centric, doesn't natively trace Pydantic AI), Helicone (rejected — proxy-based, captures only OpenAI/Anthropic HTTP calls and misses our autonomy loop / A2A spans), build-our-own metrics dashboard (rejected — solves the wrong problem; we need trace context across orchestrator → agent → LLM, not aggregate counters)
