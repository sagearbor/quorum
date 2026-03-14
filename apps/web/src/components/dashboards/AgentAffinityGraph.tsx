"use client";

/**
 * AgentAffinityGraph — force-directed graph showing agent-to-agent tag
 * affinity relationships.
 *
 * Node properties:
 *   - Size     → activityCount (messages + document edits produced)
 *   - Colour   → role color from role definition
 *   - Pulse    → active (agent is currently processing an LLM turn)
 *
 * Edge properties:
 *   - Thickness → weight (Jaccard similarity of tag sets, 0.0–1.0)
 *   - Colour    → interactionType:
 *                   green  = collaborative  (co-editing docs without conflict)
 *                   red    = conflicting    (negotiation or conflict_flag A2A)
 *                   blue   = requesting     (input_request or review_request)
 *                   grey   = none           (no recent interaction)
 *
 * Implementation note:
 *   The full D3 force-directed layout requires a browser environment and
 *   significant bundle weight.  This initial implementation uses a static
 *   SVG layout based on node count as a rendering placeholder.  The full
 *   D3 implementation is Track H work (Phase 4).  The component API and
 *   data contract are stable — Track H only changes the layout engine, not
 *   the props interface.
 */

import { useMemo } from "react";
import type { AffinityNode, AffinityEdge } from "@quorum/types/src/dashboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute (x, y) for each node in a circle layout. */
function circleLayout(
  nodes: AffinityNode[],
  cx: number,
  cy: number,
  radius: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const total = nodes.length;
  nodes.forEach((node, i) => {
    const angle = (i / total) * 2 * Math.PI - Math.PI / 2;
    positions.set(node.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });
  return positions;
}

function interactionColor(type: AffinityEdge["interactionType"]): string {
  switch (type) {
    case "collaborative":
      return "#34d399"; // emerald
    case "conflicting":
      return "#f87171"; // red
    case "requesting":
      return "#60a5fa"; // blue
    default:
      return "rgba(255,255,255,0.12)";
  }
}

/** Map edge weight (0–1) to stroke-width (0.5–4). */
function edgeWidth(weight: number): number {
  return 0.5 + weight * 3.5;
}

/** Map activity count to node radius (min 10, max 28). */
function nodeRadius(count: number): number {
  return Math.min(28, Math.max(10, 10 + count * 1.5));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AgentAffinityGraphProps {
  nodes: AffinityNode[];
  edges: AffinityEdge[];
  /** SVG viewport width (defaults to 480). */
  width?: number;
  /** SVG viewport height (defaults to 320). */
  height?: number;
}

/**
 * AgentAffinityGraph
 *
 * Renders a force-directed (currently circle-layout) graph of agent affinity
 * relationships. Nodes represent agents/roles; edges represent tag-overlap
 * strength and recent interaction type.
 *
 * The graph is purely visual — no interaction in v1.  Track H will add D3
 * force simulation for dynamic node placement.
 */
export function AgentAffinityGraph({
  nodes,
  edges,
  width = 480,
  height = 320,
}: AgentAffinityGraphProps) {
  const cx = width / 2;
  const cy = height / 2;
  // Reserve ~30 px margin for node labels that overflow the circle
  const radius = Math.min(cx, cy) - 50;

  const positions = useMemo(
    () => circleLayout(nodes, cx, cy, radius),
    [nodes, cx, cy, radius],
  );

  if (nodes.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="agent-affinity-graph-empty"
      >
        <p className="text-sm text-white/40">
          No agent configuration data available yet.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      data-testid="agent-affinity-graph"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 pb-2">
        <h3 className="text-sm font-semibold text-white/90">Agent Affinity</h3>
        <div className="flex items-center gap-3 text-[10px] text-white/40">
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-4 rounded"
              style={{ background: "#34d399" }}
            />
            collaborative
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-4 rounded"
              style={{ background: "#f87171" }}
            />
            conflicting
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-4 rounded"
              style={{ background: "#60a5fa" }}
            />
            requesting
          </span>
        </div>
      </div>

      {/* SVG canvas */}
      <div className="relative flex-1 min-h-0">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-full w-full"
          aria-label="Agent affinity graph"
        >
          {/* Edges (render below nodes) */}
          {edges.map((edge, i) => {
            const src = positions.get(edge.source);
            const tgt = positions.get(edge.target);
            if (!src || !tgt) return null;
            // Only render edges with meaningful weight
            if (edge.weight < 0.1) return null;

            return (
              <line
                key={i}
                x1={src.x}
                y1={src.y}
                x2={tgt.x}
                y2={tgt.y}
                stroke={interactionColor(edge.interactionType)}
                strokeWidth={edgeWidth(edge.weight)}
                strokeOpacity={0.5}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const r = nodeRadius(node.activityCount);

            return (
              <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
                {/* Pulse ring for active agents */}
                {node.active && (
                  <circle
                    r={r + 6}
                    fill="none"
                    stroke={node.color}
                    strokeWidth={1.5}
                    strokeOpacity={0.4}
                    className="animate-ping"
                  />
                )}

                {/* Node circle */}
                <circle
                  r={r}
                  fill={node.color}
                  fillOpacity={0.25}
                  stroke={node.color}
                  strokeWidth={1.5}
                  strokeOpacity={0.8}
                />

                {/* Activity count inside node */}
                {node.activityCount > 0 && (
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={10}
                    fill="rgba(255,255,255,0.7)"
                    fontWeight="600"
                  >
                    {node.activityCount}
                  </text>
                )}

                {/* Label below node */}
                <text
                  y={r + 12}
                  textAnchor="middle"
                  fontSize={10}
                  fill="rgba(255,255,255,0.6)"
                  className="pointer-events-none select-none"
                >
                  {node.label.length > 14
                    ? node.label.slice(0, 13) + "…"
                    : node.label}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Placeholder overlay — removed once D3 force layout is wired */}
        <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/50 px-2 py-1 text-[10px] text-white/30">
          static layout — D3 force in Track H
        </div>
      </div>
    </div>
  );
}
