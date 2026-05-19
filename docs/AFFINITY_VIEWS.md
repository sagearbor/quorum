# AffinityGraphPanel — Design Brainstorm Results

Three independent frontend designers (A, B, C) were each asked to brainstorm 4 visual approaches for a new `AgentAffinityGraphPanel` that fetches its own data given a `quorumId` and visualizes the agent network as DYNAMIC and showing CHANGES OVER TIME for the `/display` carousel. They wrote their ideas before seeing Sophie's spring-physics proposal, then evaluated it.

This file consolidates their 12 ideas into 5 distinct concept families and tracks designer support per family. Use as the menu when building additional views later.

## Concept families (collapsed across designers)

| # | Concept | Liked by | Top mechanic | "Over time" element | Cost | Picked for expo? |
|---|---------|---------|--------------|---------------------|------|---|
| 1 | **Constellation Drift** — starfield where roles drift on a 2D plane based on similarity; comet trails on a2a events | **3/3** (A, B, C — invented independently with same name) | Polar lerp / Verlet smoothing on a similarity matrix | Stars drift smoothly over rolling 60s window; comet streaks fire on realtime a2a events | M | None picked it as #1 for expo (too risky); all three picked it as #2 / "showstopper if more time" |
| 2 | **Heatmap / Time Grid** — piano-roll OR N×N role-vs-role matrix where cells pulse/color by activity, with spectral re-sort animating coalitions | **2/3** (B's piano-roll + C's matrix re-sort) | Aggregated activity per minute, cell colors interpolate, optional matrix re-sort animation | X-axis IS time (auto-scrolling) OR re-sort animates coalitions | S | B and C **both picked it as their #1 expo bet** — smallest cost, hardest to break, instantly legible |
| 3 | **River / Sankey** — horizontal flowing ribbons (one per role) that braid together on tag agreement, split on conflict | **3/3** (A's Affinity River, B's Topic Tide River, C's Conversation River) | SVG path interpolation per tick, ribbons re-braid | X-axis is real time (rolling 5min window); ribbons weave vertically | M-L | **None picked it** — all three rejected as "too fragile for live data," "hard to interpret in 4 seconds," "custom SVG paths under deadline" |
| 4 | **Authority Heat-Orbit / Gravity Wells** — concentric rings or wells where authority_rank determines orbit, a2a-target gets inward tug, trails show influence accumulator | **3/3** (A3 Heat-Orbit, B4 Gravity Wells, C4 Gravity Wells) | Polar orbit math, simple per-target inward pulses | Dot trails over last 60s; capture-into-well animations on tag matches | S-M | A picked it as #1 expo; B and C ranked it as #2 |
| 5 | **Tag Cluster Magnets** — tag chips float as magnets, role avatars snap toward most-recently-used tag | **1/3** (only A) | Per-role target = weighted average of tag positions, Framer Motion `animate` | Each new contribution re-magnetizes that role toward its tag; visible "camp switching" | S | Outlier — only one designer surfaced it |

## Sophie's proposal: spring-physics sim + cluster-tightness plot below

All three designers rated it **"complementary"** to their own ideas, not strictly better or worse. Common ground:

**Critique convergence (all 3 designers independently):**
- Spring sims settle to a static blob within ~10s if there's no constant new input — visitor sees frozen layout
- "Similarity of decisions" is undefined; needs a concrete metric source (Jaccard on `[tags: ...]` blocks is the obvious deterministic candidate)
- The bottom line plot ("cluster tightness over time") is the weak link — visitors will only watch the bouncy sim and ignore the chart
- Spring physics in React without d3-force means DIY Verlet or fight Framer Motion's transform system

**Strength convergence (all 3 designers independently):**
- Spring metaphor is uniquely intuitive — "things that agree pull together" is preschool-legible
- Dual-panel layout (live sim + historical trace) is genuinely better than any single-view idea for carousel rotation
- Encodes *agency* and *causal feeling* in a way lerps/heatmaps don't

**Combined synthesis** (all 3 designers ended up proposing a hybrid where the spring sim stays, the bottom panel changes):

| Designer | Their hybrid spec |
|---|---|
| A | Constellation Drift on top (dual-panel layout) + stacked sparkline of a2a-pair volume below + hover-cross-link between panels |
| B | Sophie's spring sim unchanged + 60s heatmap timeline strip below + authority-as-mass damping to prevent jitter |
| C | Constrained spring using Framer's built-in `spring` transition (no physics engine), targeting recomputed centroid every 2s + N×N heatmap with spectral re-sort as secondary panel |

## Recommended v1 synthesis

For the first implementation, do **B + C combined**:

- Framer Motion's built-in `spring` transitions (no physics engine, no new deps)
- Targets recomputed every 2s via Jaccard similarity on the last N agents' `[tags: ...]` blocks
- Authority-as-mass: higher `authority_rank` resists motion, anchors lower-rank agents
- 60s heatmap timeline strip below (piano-roll, role × time-bucket, cell color = activity)
- Comet pulses on realtime `a2a_request` and `facilitator_reply` WebSocket events
- localStorage-persisted view toggle so user can switch between this and future views

Buildable by one agent in ~60-90 min.

## Future v2 candidates

Defer to after expo:
- **Heat-Tile Time-Lapse** (C's #1 pick) — N×N matrix with spectral re-sort, animation of coalition blocks
- **Constellation Drift** standalone (all 3 designers' #2 pick) — needs the showstopper time investment
- **River / Sankey** — only ship if data quality is reliably good; fragile under sparse data
