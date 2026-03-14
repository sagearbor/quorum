"use client";

/**
 * AgentDocumentDashboard — renders all active agent_documents for a quorum.
 *
 * Supports three logical formats determined by doc_type:
 *   - "timeline"  → horizontal Gantt bar chart via Recharts BarChart
 *   - "budget"    → tabular view with colour-coded variance column
 *   - "protocol"  → structured tree view of amendment records
 *   - (fallback)  → generic JSON tree
 *
 * Problems embedded in each document's metadata are highlighted in amber/red
 * below each rendered document to give agents and humans immediate visibility.
 *
 * Real-time updates are handled by the useAgentDocuments hook — the parent
 * should pass documents down, but the component also fetches its own state
 * when quorumId is provided without pre-loaded documents.
 */

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { AgentDocumentDashboardProps } from "@quorum/types/src/dashboard";
import { useAgentDocuments } from "@/hooks/useAgentDocuments";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GanttTask {
  id: string;
  name: string;
  start: string;
  end: string;
  depends_on: string[];
  owner_role?: string;
  status?: string;
}

interface BudgetLineItem {
  category: string;
  planned: number;
  actual: number;
  variance: number;
  notes?: string;
  owner_role?: string;
  status?: string;
}

interface Amendment {
  id: string;
  title: string;
  status: string;
  submitted: string | null;
  impacts: string[];
  description: string;
  owner_role?: string;
  budget_impact?: number;
  timeline_impact_days?: number;
  consent_revised?: boolean;
  sites_notified?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDate(iso: string): number {
  return new Date(iso).getTime();
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d
    .getDate()
    .toString()
    .padStart(2, "0")}`;
}

function statusColor(status: string | undefined): string {
  switch (status) {
    case "in_progress":
      return "#60a5fa"; // blue
    case "completed":
      return "#34d399"; // green
    case "at_risk":
      return "#fbbf24"; // amber
    case "blocked":
    case "critical":
      return "#f87171"; // red
    default:
      return "#94a3b8"; // slate
  }
}

function varianceColor(variance: number): string {
  if (variance > 0) return "#34d399";   // under budget — good
  if (variance >= -10000) return "#fbbf24"; // slight overrun — amber
  return "#f87171"; // significant overrun — red
}

function amendmentStatusColor(status: string): string {
  switch (status) {
    case "approved":
      return "#34d399";
    case "pending_irb":
      return "#fbbf24";
    case "draft":
      return "#94a3b8";
    case "rejected":
      return "#f87171";
    default:
      return "#94a3b8";
  }
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

// ---------------------------------------------------------------------------
// Problem list
// ---------------------------------------------------------------------------

function ProblemList({ problems }: { problems: string[] }) {
  if (!problems || problems.length === 0) return null;

  return (
    <div
      className="mt-3 rounded-md border border-amber-500/30 bg-amber-900/20 px-3 py-2"
      data-testid="problem-list"
    >
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
        Known Problems ({problems.length})
      </p>
      <ul className="space-y-1">
        {problems.map((p, i) => {
          // Problems that contain "CONFLICT", "IMPOSSIBLE", "VIOLATION" are critical
          const isCritical =
            /CONFLICT|IMPOSSIBLE|VIOLATION|CRITICAL/i.test(p);
          return (
            <li
              key={i}
              className={`text-xs leading-relaxed ${
                isCritical ? "text-red-300" : "text-amber-300/90"
              }`}
            >
              {isCritical ? "!! " : "* "}
              {p}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gantt renderer
// ---------------------------------------------------------------------------

function GanttView({ tasks }: { tasks: GanttTask[] }) {
  // Convert ISO dates to "days from earliest start" for chart positioning.
  // We use a stacked bar trick: invisible bar for offset, visible bar for duration.
  const minDate = useMemo(() => {
    const starts = tasks.map((t) => parseDate(t.start));
    return Math.min(...starts);
  }, [tasks]);

  const data = useMemo(
    () =>
      tasks.map((t) => {
        const startMs = parseDate(t.start);
        const endMs = parseDate(t.end === t.start ? t.start : t.end);
        const offsetDays = Math.round((startMs - minDate) / 86400000);
        // Milestone tasks (start === end) get 1 day duration for visibility
        const durationDays = Math.max(
          1,
          Math.round((endMs - startMs) / 86400000),
        );
        return {
          name: t.name,
          offset: offsetDays,
          duration: durationDays,
          status: t.status,
          startLabel: formatDateShort(t.start),
          endLabel: formatDateShort(t.end),
        };
      }),
    [tasks, minDate],
  );

  return (
    <div data-testid="gantt-view">
      <ResponsiveContainer width="100%" height={tasks.length * 34 + 40}>
        <BarChart
          layout="vertical"
          data={data}
          margin={{ top: 4, right: 24, bottom: 4, left: 160 }}
        >
          <CartesianGrid
            horizontal={false}
            stroke="rgba(255,255,255,0.05)"
          />
          <XAxis
            type="number"
            tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
            axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
            tickLine={false}
            tickFormatter={(v) => `d+${v}`}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={155}
            tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 11 }}
            axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.03)" }}
            contentStyle={{
              background: "rgba(15,15,25,0.95)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              fontSize: 11,
              color: "#fff",
            }}
            formatter={(_value, _name, props) => {
              const { startLabel, endLabel, duration } = props.payload;
              return [`${startLabel} → ${endLabel} (${duration}d)`, ""];
            }}
          />
          {/* Invisible offset bar — sets starting position */}
          <Bar dataKey="offset" stackId="gantt" fill="transparent" />
          {/* Visible duration bar — coloured by status */}
          <Bar dataKey="duration" stackId="gantt" radius={[2, 2, 2, 2]}>
            {data.map((entry, index) => (
              <Cell
                key={index}
                fill={statusColor(entry.status)}
                fillOpacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget table renderer
// ---------------------------------------------------------------------------

function BudgetView({ lineItems }: { lineItems: BudgetLineItem[] }) {
  const totalPlanned = lineItems.reduce((s, r) => s + (r.planned ?? 0), 0);
  const totalActual = lineItems.reduce((s, r) => s + (r.actual ?? 0), 0);
  const totalVariance = lineItems.reduce((s, r) => s + (r.variance ?? 0), 0);

  return (
    <div className="overflow-x-auto" data-testid="budget-view">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/10 text-left">
            <th className="pb-2 pr-3 font-semibold text-white/50">Category</th>
            <th className="pb-2 pr-3 text-right font-semibold text-white/50">
              Planned
            </th>
            <th className="pb-2 pr-3 text-right font-semibold text-white/50">
              Actual
            </th>
            <th className="pb-2 pr-3 text-right font-semibold text-white/50">
              Variance
            </th>
            <th className="pb-2 font-semibold text-white/50">Notes</th>
          </tr>
        </thead>
        <tbody>
          {lineItems.map((row, i) => (
            <tr
              key={i}
              className="border-b border-white/5 transition-colors hover:bg-white/3"
            >
              <td className="py-1.5 pr-3 text-white/80">{row.category}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-white/60">
                {formatCurrency(row.planned)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-white/80">
                {formatCurrency(row.actual)}
              </td>
              <td
                className="py-1.5 pr-3 text-right tabular-nums font-medium"
                style={{ color: varianceColor(row.variance) }}
              >
                {row.variance > 0 ? "+" : ""}
                {formatCurrency(row.variance)}
              </td>
              <td className="py-1.5 text-white/40">{row.notes || ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-white/20 font-semibold">
            <td className="py-2 pr-3 text-white/70">TOTAL</td>
            <td className="py-2 pr-3 text-right tabular-nums text-white/70">
              {formatCurrency(totalPlanned)}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums text-white/90">
              {formatCurrency(totalActual)}
            </td>
            <td
              className="py-2 pr-3 text-right tabular-nums"
              style={{ color: varianceColor(totalVariance) }}
            >
              {totalVariance > 0 ? "+" : ""}
              {formatCurrency(totalVariance)}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Protocol amendments renderer
// ---------------------------------------------------------------------------

function ProtocolView({ amendments }: { amendments: Amendment[] }) {
  return (
    <div className="space-y-3" data-testid="protocol-view">
      {amendments.map((am) => (
        <div
          key={am.id}
          className="rounded-md border border-white/10 bg-white/4 px-3 py-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-white/40">{am.id}</span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{
                    background: amendmentStatusColor(am.status) + "30",
                    color: amendmentStatusColor(am.status),
                  }}
                >
                  {am.status.replace(/_/g, " ")}
                </span>
              </div>
              <p className="mt-0.5 text-sm font-medium text-white/90">
                {am.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-white/55">
                {am.description}
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-white/40">
            {am.submitted && (
              <span>Submitted: {am.submitted}</span>
            )}
            {am.budget_impact !== undefined && am.budget_impact !== 0 && (
              <span
                style={{
                  color: am.budget_impact > 0 ? "#f87171" : "#34d399",
                }}
              >
                Budget impact: {am.budget_impact > 0 ? "+" : ""}
                {formatCurrency(am.budget_impact)}
              </span>
            )}
            {am.timeline_impact_days !== undefined &&
              am.timeline_impact_days !== 0 && (
                <span className="text-amber-400">
                  Timeline: +{am.timeline_impact_days}d
                </span>
              )}
            {am.consent_revised === false && (
              <span className="text-red-400">Consent not revised</span>
            )}
            {am.sites_notified === false && (
              <span className="text-amber-400">Sites not notified</span>
            )}
          </div>
          {am.impacts.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {am.impacts.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300"
                >
                  {tag.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic JSON fallback renderer
// ---------------------------------------------------------------------------

function JsonView({ content }: { content: Record<string, unknown> }) {
  // Render a shallow key/value list for the top-level sections.
  const sections = content.sections as Record<string, unknown> | undefined;

  if (!sections) {
    return (
      <pre
        className="overflow-auto rounded bg-black/30 p-2 text-[10px] text-white/60"
        data-testid="json-view"
      >
        {JSON.stringify(content, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-2" data-testid="json-view">
      {Object.entries(sections).map(([key, value]) => (
        <div key={key}>
          <p className="mb-1 text-xs font-semibold text-white/50 uppercase tracking-wide">
            {key.replace(/_/g, " ")}
          </p>
          <pre className="overflow-auto rounded bg-black/30 p-2 text-[10px] text-white/60">
            {JSON.stringify(value, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-document card
// ---------------------------------------------------------------------------

function DocumentCard({ doc }: { doc: import("@quorum/types").AgentDocument }) {
  const content = doc.content as Record<string, unknown>;
  const sections = content.sections as Record<string, unknown> | undefined;
  const metadata = content.metadata as
    | { problems?: string[]; conflict_zones?: string[] }
    | undefined;
  const problems = metadata?.problems ?? [];

  function renderBody() {
    switch (doc.doc_type) {
      case "timeline": {
        const tasks =
          (sections?.tasks as GanttTask[] | undefined) ?? [];
        if (tasks.length === 0)
          return <p className="text-xs text-white/40">No tasks defined.</p>;
        return <GanttView tasks={tasks} />;
      }
      case "budget": {
        const lineItems =
          (sections?.line_items as BudgetLineItem[] | undefined) ?? [];
        if (lineItems.length === 0)
          return <p className="text-xs text-white/40">No line items defined.</p>;
        return <BudgetView lineItems={lineItems} />;
      }
      case "protocol": {
        const amendments =
          (sections?.amendments as Amendment[] | undefined) ?? [];
        if (amendments.length === 0)
          return (
            <p className="text-xs text-white/40">No amendments defined.</p>
          );
        return <ProtocolView amendments={amendments} />;
      }
      default:
        return <JsonView content={content} />;
    }
  }

  return (
    <div
      className="rounded-lg border border-white/10 bg-white/5 p-4"
      data-testid={`document-card-${doc.id}`}
    >
      {/* Card header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold text-white/90">
            {doc.title}
          </h4>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] font-mono text-slate-300">
              {doc.doc_type}
            </span>
            <span className="text-[10px] text-white/30">v{doc.version}</span>
            {problems.length > 0 && (
              <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">
                {problems.length} problem{problems.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        {/* Tag pills */}
        <div className="flex flex-shrink-0 flex-wrap gap-1">
          {(doc.tags ?? []).slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[10px] text-indigo-300"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Document body rendered according to doc_type */}
      {renderBody()}

      {/* Problem annotations */}
      <ProblemList problems={problems} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard component
// ---------------------------------------------------------------------------

export interface AgentDocumentDashboardOwnProps {
  quorumId: string;
  /** Pre-loaded documents (optional — bypasses the internal hook for tests). */
  staticDocuments?: import("@quorum/types").AgentDocument[];
}

/**
 * AgentDocumentDashboard
 *
 * Renders all active agent documents for a quorum, grouped by doc_type.
 * Subscribes to real-time updates via useAgentDocuments so edits made by
 * agents appear without a page reload.
 *
 * Pass `staticDocuments` to bypass the hook (useful for tests and Storybook).
 */
export function AgentDocumentDashboard({
  quorumId,
  staticDocuments,
}: AgentDocumentDashboardOwnProps) {
  const { documents: liveDocuments, loading } = useAgentDocuments(quorumId);
  const documents = staticDocuments ?? liveDocuments;

  const activeDocuments = useMemo(
    () => documents.filter((d) => d.status === "active"),
    [documents],
  );

  if (loading && !staticDocuments) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="agent-document-dashboard-loading"
      >
        <span className="text-sm text-white/40 animate-pulse">
          Loading documents…
        </span>
      </div>
    );
  }

  if (activeDocuments.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="agent-document-dashboard-empty"
      >
        <p className="text-sm text-white/40">
          No agent documents seeded yet.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col gap-4 overflow-y-auto p-1"
      data-testid="agent-document-dashboard"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-semibold text-white/90">
          Agent Documents
        </h3>
        <span className="text-xs text-white/40">
          {activeDocuments.length} active
        </span>
      </div>

      {/* Document cards */}
      {activeDocuments.map((doc) => (
        <DocumentCard key={doc.id} doc={doc} />
      ))}
    </div>
  );
}
