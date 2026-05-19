"use client";

/**
 * RoleCoverageMap — heatmap of role × structured-field activity.
 *
 * Answers the audience question: "are all stakeholders covered, and where are
 * the gaps?"
 *
 *   Rows     = roles, sorted by authority_rank desc
 *   Columns  = union of every role.prompt_template[].field_name
 *   Cell     = activity for that (role, field) pair, derived from each
 *              contribution's structured_fields[field] payload
 *
 * Shading:
 *   - dark    -> no contribution on that field
 *   - mid     -> some content (<=100 chars)
 *   - bright  -> substantial content (>100 chars)
 *
 * Interactions:
 *   - hover -> native tooltip with role + field + character count
 *   - click -> small inline popover showing the contribution content
 *
 * Self-contained: fetches its own roles + contributions via dataProvider and
 * subscribes to realtime contribution inserts. Respects
 * prefers-reduced-motion.
 *
 * Tailwind + framer-motion only; no new deps. File budget: <=400 lines.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  getRoles,
  getContributions,
  subscribeToContributions,
} from "@/lib/dataProvider";
import { DashboardInfo } from "./DashboardInfo";

const COVERAGE_BLURB =
  "**Role Coverage Map.** Heatmap of role × structured field. Dark cells = unanswered. Bright cells = substantive contribution. Hover for character counts; click for the contribution itself. Gaps highlight which stakeholder × question pairs are missing.";

// Activity thresholds
const SUBSTANTIAL_CHARS = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PromptField {
  field_name: string;
  prompt?: string;
}

interface RoleEntry {
  id: string;
  name: string;
  authority_rank: number;
  color?: string;
  prompt_template?: PromptField[] | null;
}

interface ContributionEntry {
  id: string;
  role_id: string;
  content?: string;
  structured_fields?: Record<string, string> | null;
  created_at?: string;
}

interface CellState {
  /** Total length across all contributions for this (role, field). */
  chars: number;
  /** Most recent contribution content snippet for this cell. */
  latestContent: string;
  /** Contribution ids that touched this cell. */
  contribIds: string[];
}

type Grid = Record<string, Record<string, CellState>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/**
 * Pull the cell payload for (role, field) from a single contribution.
 * Uses structured_fields[field] when present; otherwise null (the raw
 * `content` is intentionally NOT used as a fallback, because a role could
 * have produced unstructured prose that doesn't actually address a given
 * field, and counting it as coverage would mislead the audience).
 */
function cellPayload(
  field: string,
  contrib: ContributionEntry,
): string | null {
  const sf = contrib.structured_fields;
  if (sf && typeof sf === "object" && typeof sf[field] === "string") {
    return sf[field];
  }
  return null;
}

function shadeFor(chars: number): {
  bg: string;
  ring: string;
  level: "empty" | "some" | "substantial";
} {
  if (chars <= 0) {
    return {
      bg: "rgba(255,255,255,0.04)",
      ring: "rgba(255,255,255,0.06)",
      level: "empty",
    };
  }
  if (chars <= SUBSTANTIAL_CHARS) {
    // Mid: warm amber
    return {
      bg: "rgba(245,158,11,0.45)",
      ring: "rgba(245,158,11,0.55)",
      level: "some",
    };
  }
  // Substantial: bright emerald
  return {
    bg: "rgba(16,185,129,0.85)",
    ring: "rgba(16,185,129,0.95)",
    level: "substantial",
  };
}

function dotColor(c: string | undefined): string {
  if (c && /^#?[0-9a-f]{3,8}$/i.test(c)) {
    return c.startsWith("#") ? c : `#${c}`;
  }
  return "#94a3b8";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RoleCoverageMapProps {
  quorumId: string;
  /** Override role list (for tests). When provided, skips initial fetch. */
  staticRoles?: RoleEntry[];
  /** Override contribution list (for tests). When provided, skips fetch. */
  staticContributions?: ContributionEntry[];
}

export function RoleCoverageMap({
  quorumId,
  staticRoles,
  staticContributions,
}: RoleCoverageMapProps) {
  const reducedMotion = usePrefersReducedMotion();

  const [roles, setRoles] = useState<RoleEntry[]>(staticRoles ?? []);
  const [contribs, setContribs] = useState<ContributionEntry[]>(
    staticContributions ?? [],
  );
  const [loading, setLoading] = useState(
    !(staticRoles && staticContributions),
  );
  const [popover, setPopover] = useState<{
    roleId: string;
    field: string;
    anchor: { x: number; y: number };
  } | null>(null);

  // -----------------------------------------------------------------------
  // Initial fetch (roles + contributions)
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (staticRoles && staticContributions) return;
    let cancelled = false;
    (async () => {
      try {
        const [r, c] = await Promise.all([
          staticRoles ? Promise.resolve(staticRoles) : getRoles(quorumId),
          staticContributions
            ? Promise.resolve(staticContributions)
            : getContributions(quorumId),
        ]);
        if (cancelled) return;
        setRoles((r ?? []) as unknown as RoleEntry[]);
        setContribs((c ?? []) as unknown as ContributionEntry[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quorumId, staticRoles, staticContributions]);

  // -----------------------------------------------------------------------
  // Realtime: append new contributions as they arrive
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (staticContributions) return;
    const unsub = subscribeToContributions(quorumId, (c) => {
      const incoming = c as unknown as ContributionEntry;
      if (!incoming || !incoming.id) return;
      setContribs((prev) => {
        if (prev.some((p) => p.id === incoming.id)) return prev;
        return [...prev, incoming];
      });
    });
    return () => unsub();
  }, [quorumId, staticContributions]);

  // -----------------------------------------------------------------------
  // Derived: column list (union of field names across role prompt_templates)
  // and the role × field grid.
  // -----------------------------------------------------------------------
  const fields = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const r of roles) {
      const tpl = Array.isArray(r.prompt_template) ? r.prompt_template : [];
      for (const f of tpl) {
        if (f && typeof f.field_name === "string" && !seen.has(f.field_name)) {
          seen.add(f.field_name);
          order.push(f.field_name);
        }
      }
    }
    return order;
  }, [roles]);

  const sortedRoles = useMemo<RoleEntry[]>(() => {
    return [...roles].sort((a, b) => {
      const d = (b.authority_rank ?? 0) - (a.authority_rank ?? 0);
      if (d !== 0) return d;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [roles]);

  const grid = useMemo<Grid>(() => {
    const g: Grid = {};
    for (const r of sortedRoles) {
      g[r.id] = {};
      for (const f of fields) {
        g[r.id][f] = { chars: 0, latestContent: "", contribIds: [] };
      }
    }
    // Most-recent-last so latestContent ends up actually latest.
    for (const c of contribs) {
      if (!c.role_id || !g[c.role_id]) continue;
      for (const f of fields) {
        const payload = cellPayload(f, c);
        if (payload == null) continue;
        const cell = g[c.role_id][f];
        cell.chars += payload.length;
        cell.latestContent = payload;
        cell.contribIds.push(c.id);
      }
    }
    return g;
  }, [sortedRoles, fields, contribs]);

  // Per-column coverage counter "X / N"
  const columnCoverage = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const f of fields) {
      let covered = 0;
      for (const r of sortedRoles) {
        if ((grid[r.id]?.[f]?.chars ?? 0) > 0) covered++;
      }
      out[f] = covered;
    }
    return out;
  }, [fields, sortedRoles, grid]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="role-coverage-loading"
      >
        <span className="text-sm text-white/40 animate-pulse">
          Connecting to quorum...
        </span>
      </div>
    );
  }

  const headerRow = (
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-white/90">Role Coverage Map</h3>
        <DashboardInfo blurb={COVERAGE_BLURB} />
      </div>
      <div className="flex items-center gap-3 text-[10px] text-white/40">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-4 rounded"
            style={{ background: shadeFor(0).bg }}
          />
          empty
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-4 rounded"
            style={{ background: shadeFor(50).bg }}
          />
          some
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-4 rounded"
            style={{ background: shadeFor(200).bg }}
          />
          substantial
        </span>
      </div>
    </div>
  );

  if (sortedRoles.length === 0 || fields.length === 0) {
    return (
      <div
        className="flex h-full w-full flex-col gap-3 rounded-md bg-white/[0.03] p-3 text-white"
        data-testid="role-coverage-map"
      >
        {headerRow}
        <div
          className="flex flex-1 items-center justify-center text-center"
          data-testid="role-coverage-empty"
        >
          <p className="max-w-sm text-sm text-white/40">
            No contributions yet — roles will fill this grid as they commit
            positions.
          </p>
        </div>
      </div>
    );
  }

  const N = sortedRoles.length;
  // Cell sizing: scale modestly with row count so the grid fits panels.
  const cellH = Math.max(28, Math.min(44, Math.floor(280 / Math.max(N, 4))));
  const cellW = Math.max(60, Math.min(120, Math.floor(560 / Math.max(fields.length, 4))));

  return (
    <div
      className="flex h-full w-full flex-col gap-3 rounded-md bg-white/[0.03] p-3 text-white"
      data-testid="role-coverage-map"
    >
      {headerRow}

      <div className="overflow-auto">
        <div
          className="inline-grid"
          style={{
            gridTemplateColumns: `minmax(160px, max-content) repeat(${fields.length}, ${cellW}px)`,
            gap: 2,
          }}
        >
          {/* Corner */}
          <div />
          {/* Column headers */}
          {fields.map((f) => {
            const covered = columnCoverage[f] ?? 0;
            return (
              <div
                key={`col-${f}`}
                className="flex flex-col items-center justify-end gap-0.5 px-1 pb-1 text-[10px] text-white/70"
                style={{ width: cellW }}
                title={f}
              >
                <span
                  className="truncate text-center leading-tight"
                  style={{ maxWidth: cellW }}
                >
                  {f}
                </span>
                <span className="font-mono text-[9px] text-white/40">
                  {covered}/{N}
                </span>
              </div>
            );
          })}

          {/* Rows */}
          {sortedRoles.map((role) => (
            <RoleRow
              key={`row-${role.id}`}
              role={role}
              fields={fields}
              cells={grid[role.id] ?? {}}
              cellH={cellH}
              cellW={cellW}
              reducedMotion={reducedMotion}
              onCellClick={(field, e) => {
                const rect = (
                  e.currentTarget as HTMLElement
                ).getBoundingClientRect();
                setPopover({
                  roleId: role.id,
                  field,
                  anchor: { x: rect.left + rect.width / 2, y: rect.bottom },
                });
              }}
            />
          ))}
        </div>
      </div>

      {popover && (
        <CellPopover
          anchor={popover.anchor}
          title={`${sortedRoles.find((r) => r.id === popover.roleId)?.name ?? "role"} · ${popover.field}`}
          content={
            grid[popover.roleId]?.[popover.field]?.latestContent ||
            "(no contribution recorded)"
          }
          charCount={grid[popover.roleId]?.[popover.field]?.chars ?? 0}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row sub-component
// ---------------------------------------------------------------------------

interface RoleRowProps {
  role: RoleEntry;
  fields: string[];
  cells: Record<string, CellState>;
  cellH: number;
  cellW: number;
  reducedMotion: boolean;
  onCellClick: (field: string, e: React.MouseEvent) => void;
}

function RoleRow({
  role,
  fields,
  cells,
  cellH,
  cellW,
  reducedMotion,
  onCellClick,
}: RoleRowProps) {
  return (
    <>
      <div
        className="flex items-center gap-2 pr-2 text-[11px] text-white/80"
        style={{ minWidth: 160, height: cellH }}
        title={role.name}
      >
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: dotColor(role.color) }}
        />
        <span className="truncate">{role.name}</span>
        <span className="ml-auto shrink-0 rounded bg-white/10 px-1 py-[1px] font-mono text-[9px] text-white/60">
          r{role.authority_rank}
        </span>
      </div>
      {fields.map((f) => {
        const cell = cells[f] ?? { chars: 0, latestContent: "", contribIds: [] };
        const shade = shadeFor(cell.chars);
        const interactive = cell.chars > 0;
        return (
          <motion.button
            type="button"
            key={`cell-${role.id}-${f}`}
            data-testid={`cell-${role.id}-${f}`}
            data-level={shade.level}
            onClick={(e) => onCellClick(f, e)}
            whileHover={reducedMotion ? undefined : { scale: 1.04 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="relative overflow-hidden rounded text-left focus:outline-none focus:ring-1 focus:ring-white/40"
            style={{
              width: cellW,
              height: cellH,
              background: shade.bg,
              boxShadow: `inset 0 0 0 1px ${shade.ring}`,
              cursor: interactive ? "pointer" : "default",
            }}
            title={`${role.name} · ${f} · ${cell.chars} chars`}
            aria-label={`${role.name} ${f}: ${cell.chars} characters`}
          >
            {cell.chars > 0 && (
              <span className="absolute left-1.5 top-1 font-mono text-[9px] leading-none text-white/85">
                {cell.chars}
              </span>
            )}
          </motion.button>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline cell popover (Chart-style)
// ---------------------------------------------------------------------------

interface CellPopoverProps {
  anchor: { x: number; y: number };
  title: string;
  content: string;
  charCount: number;
  onClose: () => void;
}

function CellPopover({
  anchor,
  title,
  content,
  charCount,
  onClose,
}: CellPopoverProps) {
  const [mounted, setMounted] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    function reposition() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(340, vw - 16);
      let top = anchor.y + 8;
      const estHeight = 180;
      if (top + estHeight > vh - 8) {
        top = Math.max(8, anchor.y - estHeight - 12);
      }
      let left = anchor.x - width / 2;
      if (left < 8) left = 8;
      if (left + width > vw - 8) left = Math.max(8, vw - 8 - width);
      setRect({ top, left, width });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  if (!mounted || !rect) return null;

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      data-testid="role-coverage-popover"
      style={{
        position: "fixed",
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
      }}
      className="z-[1000] max-h-[40vh] overflow-auto rounded-md border border-white/10 bg-black/95 p-3 text-xs leading-relaxed text-white/85 shadow-xl backdrop-blur-md"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] font-semibold text-white/90">
          {title}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-white/50">
          {charCount} chars
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-white/80">{content}</p>
    </div>,
    document.body,
  );
}
