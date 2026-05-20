"use client";

/**
 * MovedRowsTable — "before vs after" by aspect, only surfacing the rows that
 * actually moved between the quorum's initial framing and its resolved state.
 * Self-contained: fetches /api/quorums/{id}/before-after + uses dataProvider
 * for contributions/roles so it can map drivers (contribution ids) to role
 * names + colors for the Δ-column pills. Tailwind + Framer Motion (`layout`).
 * Respects prefers-reduced-motion.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DashboardInfo } from "./DashboardInfo";
import { getContributions, getRoles } from "@/lib/dataProvider";

// --- Wire types ------------------------------------------------------------
export interface FieldChange {
  field: string;
  before: string;
  after: string;
  changed: boolean;
  drivers: string[]; // contribution ids
}
export interface PositionSnapshot {
  summary_sentences: string[];
  headline: string;
  key_aspects: FieldChange[];
  unresolved: string[];
}
export interface BeforeAfterPayload {
  initial: PositionSnapshot | null;
  final: PositionSnapshot | null;
  has_initial: boolean;
  has_final: boolean;
}
export interface MovedRowsTableProps {
  quorumId: string;
  staticData?: {
    payload: BeforeAfterPayload;
    contributions?: Array<{ id: string; role_id: string }>;
    roles?: Array<{ id: string; name: string; color?: string }>;
  };
}

// --- Constants -------------------------------------------------------------
const BLURB =
  "**Moved-Rows Table.** Only aspects that actually changed between the quorum's initial framing and its resolved state appear here. Driver pills show which role(s) drove each change. Unchanged aspects collapse to a single 'held firm' line.";
const PALETTE = ["#60a5fa", "#34d399", "#f87171", "#fbbf24", "#a78bfa", "#f472b6", "#22d3ee", "#fb923c"];

// --- Helpers ---------------------------------------------------------------
const getApiBase = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const humanize = (s: string) =>
  s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

interface DriverInfo { id: string; name: string; color: string; }

function resolveDrivers(
  ids: string[],
  contribById: Map<string, { role_id: string }>,
  roleById: Map<string, { name: string; color?: string }>,
  paletteIdx: Map<string, number>,
): DriverInfo[] {
  const seen = new Set<string>();
  const out: DriverInfo[] = [];
  for (const cid of ids) {
    const c = contribById.get(cid);
    if (!c) continue;
    const role = roleById.get(c.role_id);
    if (!role || seen.has(c.role_id)) continue;
    seen.add(c.role_id);
    const idx = paletteIdx.get(c.role_id) ?? 0;
    out.push({
      id: c.role_id,
      name: role.name,
      color: role.color || PALETTE[idx % PALETTE.length],
    });
    if (out.length >= 3) break;
  }
  return out;
}

// --- Sub-components --------------------------------------------------------
function DriverPills({ drivers, fieldId }: { drivers: DriverInfo[]; fieldId: string }) {
  if (drivers.length === 0) return <span className="text-xs text-white/30">—</span>;
  return (
    <div className="flex flex-wrap gap-1" data-testid={`moved-row-${fieldId}-drivers`}>
      {drivers.map((d) => (
        <span
          key={d.id}
          title={d.name}
          className="inline-flex max-w-[8rem] items-center gap-1 truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color: d.color, borderColor: `${d.color}66`, backgroundColor: `${d.color}1a` }}
        >
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
          <span className="truncate">{d.name}</span>
        </span>
      ))}
    </div>
  );
}

const ROW_CLS = "border-t border-white/5 align-top";

function MovedRow({ row, drivers, reduceMotion }: { row: FieldChange; drivers: DriverInfo[]; reduceMotion: boolean }) {
  const testId = `moved-row-${row.field}`;
  const cells = (
    <>
      <td className="px-3 py-2 text-xs font-semibold text-white/85">{humanize(row.field)}</td>
      <td className="px-3 py-2 text-xs text-white/55 line-through decoration-white/20">
        {row.before || <span className="italic text-white/30">—</span>}
      </td>
      <td className="px-3 py-2 text-xs text-emerald-200/90">
        {row.after || <span className="italic text-white/30">—</span>}
      </td>
      <td className="px-3 py-2"><DriverPills drivers={drivers} fieldId={row.field} /></td>
    </>
  );
  if (reduceMotion) return <tr data-testid={testId} className={ROW_CLS}>{cells}</tr>;
  return (
    <motion.tr
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      data-testid={testId}
      className={ROW_CLS}
    >
      {cells}
    </motion.tr>
  );
}

function HeldRow({ row, reduceMotion }: { row: FieldChange; reduceMotion: boolean }) {
  const testId = `held-row-${row.field}`;
  const cells = (
    <>
      <td className="px-3 py-2 text-xs font-medium text-white/60">{humanize(row.field)}</td>
      <td className="px-3 py-2 text-xs text-white/45" colSpan={2}>
        {row.before || row.after || <span className="italic text-white/25">—</span>}
      </td>
      <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-white/30">held</td>
    </>
  );
  if (reduceMotion) {
    return <tr data-testid={testId} className={`${ROW_CLS} opacity-60`}>{cells}</tr>;
  }
  return (
    <motion.tr
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.6 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      data-testid={testId}
      className={ROW_CLS}
    >
      {cells}
    </motion.tr>
  );
}

// --- Main component --------------------------------------------------------
export function MovedRowsTable({ quorumId, staticData }: MovedRowsTableProps) {
  const reduceMotion = useReducedMotion();
  const [payload, setPayload] = useState<BeforeAfterPayload | null>(staticData?.payload ?? null);
  const [contribs, setContribs] = useState<Array<{ id: string; role_id: string }>>(
    staticData?.contributions ?? [],
  );
  const [roles, setRoles] = useState<Array<{ id: string; name: string; color?: string }>>(
    staticData?.roles ?? [],
  );
  const [loading, setLoading] = useState<boolean>(!staticData);
  const [error, setError] = useState<string | null>(null);
  const [showHeld, setShowHeld] = useState(false);

  useEffect(() => {
    if (staticData) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const apiBase = getApiBase();
        const [resp, contribsRaw, rolesRaw] = await Promise.all([
          fetch(`${apiBase}/quorums/${quorumId}/before-after`),
          getContributions(quorumId).catch(() => []),
          getRoles(quorumId).catch(() => []),
        ]);
        if (cancelled) return;
        if (!resp.ok) {
          setPayload({ initial: null, final: null, has_initial: false, has_final: false });
        } else {
          setPayload((await resp.json()) as BeforeAfterPayload);
        }
        setContribs(
          (contribsRaw ?? []).map((c: unknown) => {
            const r = c as { id?: unknown; role_id?: unknown };
            return { id: String(r.id ?? ""), role_id: String(r.role_id ?? "") };
          }),
        );
        setRoles(
          (rolesRaw ?? []).map((r: unknown) => {
            const raw = r as { id?: unknown; name?: unknown; color?: unknown };
            return {
              id: String(raw.id ?? ""),
              name: String(raw.name ?? "Unnamed Role"),
              color: typeof raw.color === "string" ? raw.color : undefined,
            };
          }),
        );
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "load failed");
        setPayload({ initial: null, final: null, has_initial: false, has_final: false });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [quorumId, staticData]);

  const { contribById, roleById, paletteIdx } = useMemo(() => {
    const cMap = new Map<string, { role_id: string }>();
    for (const c of contribs) cMap.set(c.id, { role_id: c.role_id });
    const rMap = new Map<string, { name: string; color?: string }>();
    const pMap = new Map<string, number>();
    roles.forEach((r, i) => { rMap.set(r.id, { name: r.name, color: r.color }); pMap.set(r.id, i); });
    return { contribById: cMap, roleById: rMap, paletteIdx: pMap };
  }, [contribs, roles]);

  const { movedRows, heldRows } = useMemo(() => {
    const aspects = payload?.final?.key_aspects ?? [];
    const moved = aspects
      .filter((a) => a.changed)
      .slice()
      .sort((a, b) => (b.after?.length ?? 0) - (a.after?.length ?? 0));
    const held = aspects.filter((a) => !a.changed);
    return { movedRows: moved, heldRows: held };
  }, [payload]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="moved-rows-loading">
        <span className="text-sm text-white/40 animate-pulse">Loading before/after…</span>
      </div>
    );
  }

  if (!payload?.has_final) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-testid="moved-rows-empty">
        <p className="max-w-md text-sm text-white/50">
          No resolution yet — the quorum is still deliberating. Aspects that have moved will appear here as decisions land.
        </p>
        {error && <p className="text-[10px] text-red-400/70" data-testid="moved-rows-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto p-2" data-testid="moved-rows-table">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-white/90">Moved-Rows Table</h3>
          <DashboardInfo blurb={BLURB} />
        </div>
        <span className="text-[10px] uppercase tracking-wider text-white/40">
          {movedRows.length} moved · {heldRows.length} held firm
        </span>
      </div>

      <div className="overflow-hidden rounded-md border border-white/10">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-white/40">
            <tr>
              <th className="w-[20%] px-3 py-2 text-left font-medium">Aspect</th>
              <th className="w-[32%] px-3 py-2 text-left font-medium">Before</th>
              <th className="w-[32%] px-3 py-2 text-left font-medium">After</th>
              <th className="w-[16%] px-3 py-2 text-left font-medium">Δ</th>
            </tr>
          </thead>
          <tbody>
            {movedRows.length === 0 && (
              <tr data-testid="moved-rows-no-changes">
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-white/40">
                  No aspects moved between framing and resolution.
                </td>
              </tr>
            )}
            <AnimatePresence initial={false}>
              {movedRows.map((row) => (
                <MovedRow
                  key={`moved-${row.field}`}
                  row={row}
                  drivers={resolveDrivers(row.drivers ?? [], contribById, roleById, paletteIdx)}
                  reduceMotion={!!reduceMotion}
                />
              ))}
            </AnimatePresence>

            {heldRows.length > 0 && (
              <tr data-testid="moved-rows-held-toggle" className="border-t border-white/5">
                <td colSpan={4} className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setShowHeld((v) => !v)}
                    aria-expanded={showHeld}
                    className="inline-flex items-center gap-1.5 text-[11px] text-white/45 transition-colors hover:text-white/80"
                  >
                    <span aria-hidden className={`inline-block transition-transform ${showHeld ? "rotate-90" : ""}`}>▸</span>
                    {heldRows.length} aspect{heldRows.length === 1 ? "" : "s"} unchanged
                  </button>
                </td>
              </tr>
            )}

            <AnimatePresence initial={false}>
              {showHeld && heldRows.map((row) => (
                <HeldRow key={`held-${row.field}`} row={row} reduceMotion={!!reduceMotion} />
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {payload?.final?.headline && (
        <p className="px-1 text-[11px] italic text-white/45">
          Resolved framing: {payload.final.headline}
        </p>
      )}
    </div>
  );
}

export default MovedRowsTable;
