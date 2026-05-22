"use client";

/**
 * HeadlineRewrite — newspaper-style before/after framing dashboard.
 *
 * Renders a faux front-page where the quorum's original framing (its title)
 * morphs into the resolved framing (the `final_position.headline` from the
 * before/after snapshot, when available). A discrete WAS / NOW toggle lets the
 * audience flip between the original framing and the resolved one — only one
 * is shown at a time so the text stays readable in screenshots and on a
 * projector.
 *
 * Empty state: when no `final_position` yet, shows the original problem
 * statement with caption "Awaiting resolution — quorum is still deliberating."
 * The WAS / NOW toggle is hidden until resolution exists.
 *
 * Self-contained: fetches its own /quorums/{id}/before-after + falls back to
 * `getQuorum(quorumId).title` when the endpoint is missing/404.
 *
 * Tailwind + framer-motion only — no new deps.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { DashboardInfo } from "./DashboardInfo";
import { getQuorum } from "@/lib/dataProvider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleLike {
  id: string;
  name: string;
  color?: string;
}

export interface FinalPosition {
  headline?: string;
  summary_sentences?: string[];
}

export interface BeforeAfterSnapshot {
  original_question?: string;
  final_position?: FinalPosition | null;
  roles?: RoleLike[];
}

export interface HeadlineRewriteProps {
  quorumId: string;
  /** Optional static override used by tests. */
  staticData?: {
    snapshot?: BeforeAfterSnapshot | null;
    quorumTitle?: string;
    quorumRoles?: RoleLike[];
  };
}

const HEADLINE_BLURB =
  "**Headline Rewrite.** Shows how the quorum's question evolved from the original framing to the resolved one. Use the WAS / NOW toggle to flip between them. Updates when the quorum is resolved.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiBase(): string | null {
  return process.env.NEXT_PUBLIC_API_URL ?? null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Try to cut on a word boundary near the limit.
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[.,;:!?-]+$/, "") + "…";
}

/** Pretty-formatted "MAY 20, 2026" style dateline. */
function formatDateline(d = new Date()): string {
  const month = d
    .toLocaleString("en-US", { month: "long" })
    .toUpperCase();
  return `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Typewriter retype animation
// ---------------------------------------------------------------------------

function useTypewriter(text: string, durationMs: number, enabled: boolean) {
  const [shown, setShown] = useState(text);
  const targetRef = useRef(text);

  useEffect(() => {
    targetRef.current = text;
    if (!enabled) {
      setShown(text);
      return;
    }
    // Phase 1: erase current text. Phase 2: type new text.
    let raf = 0;
    const start = performance.now();
    const halfway = durationMs / 2;
    const initial = shown;
    function tick(now: number) {
      const elapsed = now - start;
      if (elapsed < halfway) {
        const k = 1 - elapsed / halfway;
        const len = Math.max(0, Math.floor(initial.length * k));
        setShown(initial.slice(0, len));
      } else if (elapsed < durationMs) {
        const k = (elapsed - halfway) / halfway;
        const len = Math.min(text.length, Math.floor(text.length * k));
        setShown(text.slice(0, len));
      } else {
        setShown(text);
        return;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, enabled]);

  return shown;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HeadlineRewrite({ quorumId, staticData }: HeadlineRewriteProps) {
  const reduceMotion = useReducedMotion();

  const [snapshot, setSnapshot] = useState<BeforeAfterSnapshot | null>(
    staticData?.snapshot ?? null,
  );
  const [fallbackTitle, setFallbackTitle] = useState<string | null>(
    staticData?.quorumTitle ?? null,
  );
  const [fallbackRoles, setFallbackRoles] = useState<RoleLike[]>(
    staticData?.quorumRoles ?? [],
  );
  const [loading, setLoading] = useState<boolean>(!staticData);
  // Toggle: which framing is currently displayed. Default to "now" (resolved).
  // Replaces the previous hover-overlay pattern where OLD ghosted over NEW —
  // that stacked two strings on top of each other and was unreadable.
  const [view, setView] = useState<"was" | "now">("now");

  // -------------------------------------------------------------------------
  // Data fetch (skipped when staticData is set)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (staticData) return;
    let cancelled = false;

    async function load() {
      const apiBase = getApiBase();
      let snap: BeforeAfterSnapshot | null = null;
      if (apiBase) {
        try {
          const res = await fetch(`${apiBase}/quorums/${quorumId}/before-after`);
          if (res.ok) {
            // API returns {initial, final, has_initial, has_final} — remap to
            // the shape this component expects (final_position).  The API
            // schema and the component were written in different sessions
            // with different field naming; reconcile here rather than
            // changing both sides.
            const raw = (await res.json()) as {
              initial?: FinalPosition | null;
              final?: FinalPosition | null;
              has_initial?: boolean;
              has_final?: boolean;
            };
            snap = {
              final_position: raw.final ?? null,
              // original_question: the quorum's pre-deliberation framing.
              // We don't have a dedicated server field, so fall back to the
              // initial snapshot's headline (the framing as it was when the
              // quorum first stabilized) — close enough for the demo.
              original_question: raw.initial?.headline ?? undefined,
            };
          }
        } catch {
          snap = null;
        }
      }
      if (cancelled) return;
      setSnapshot(snap);

      // Always load the quorum so we have title + roles for fallback / byline.
      try {
        const q = await getQuorum(quorumId);
        if (cancelled) return;
        if (q) {
          setFallbackTitle(q.title ?? null);
          const mappedRoles: RoleLike[] = (q.roles ?? []).map((r) => {
            const raw = r as unknown as Record<string, unknown>;
            return {
              id: String(raw.id ?? ""),
              name: String(raw.name ?? "Unnamed Role"),
              color: typeof raw.color === "string" ? raw.color : undefined,
            };
          });
          setFallbackRoles(mappedRoles);
        }
      } catch {
        // ignore — we'll render whatever we have
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [quorumId, staticData]);

  // -------------------------------------------------------------------------
  // Derive OLD + NEW headlines
  // -------------------------------------------------------------------------
  const oldHeadline = useMemo(() => {
    return (
      snapshot?.original_question?.trim() ||
      fallbackTitle?.trim() ||
      "Awaiting question…"
    );
  }, [snapshot, fallbackTitle]);

  const newHeadlineRaw = snapshot?.final_position?.headline?.trim();
  const hasResolution = Boolean(newHeadlineRaw);
  const newHeadline = hasResolution ? newHeadlineRaw! : oldHeadline;

  const dek = useMemo(() => {
    if (!hasResolution) return null;
    const s = snapshot?.final_position?.summary_sentences?.[0]?.trim();
    if (!s) return null;
    return truncate(s, 150);
  }, [snapshot, hasResolution]);

  const roles = useMemo<RoleLike[]>(() => {
    const fromSnap = snapshot?.roles ?? [];
    return fromSnap.length > 0 ? fromSnap : fallbackRoles;
  }, [snapshot, fallbackRoles]);

  // -------------------------------------------------------------------------
  // Typewriter animation: retype between WAS <-> NOW as the user toggles.
  // -------------------------------------------------------------------------
  // We animate whenever there's a genuine rewrite (OLD != NEW) and the user
  // hasn't opted out of motion. On first paint with a resolution we also
  // animate the OLD -> NOW transition once.
  const canAnimate =
    hasResolution &&
    !reduceMotion &&
    oldHeadline !== newHeadline;
  // The displayed headline is driven by `view`: "now" -> resolved, "was" ->
  // original. Without a resolution, both reduce to oldHeadline.
  const currentHeadline = view === "was" ? oldHeadline : newHeadline;
  // The hook reads the current "target" headline; we change the target and
  // let the typewriter erase the previous string then type the new one.
  const [target, setTarget] = useState(hasResolution ? oldHeadline : newHeadline);
  const firstResolveRef = useRef(false);
  useEffect(() => {
    if (!hasResolution) {
      setTarget(newHeadline);
      return;
    }
    // First time we see a resolution, start at OLD and animate to NOW so the
    // audience gets the OLD-then-NEW reveal once.
    if (!firstResolveRef.current && view === "now") {
      firstResolveRef.current = true;
      if (canAnimate) {
        setTarget(oldHeadline);
        const t = window.setTimeout(() => setTarget(newHeadline), 600);
        return () => window.clearTimeout(t);
      }
      setTarget(newHeadline);
      return;
    }
    // Subsequent toggles: animate straight to whichever the user picked.
    setTarget(currentHeadline);
  }, [hasResolution, view, currentHeadline, oldHeadline, newHeadline, canAnimate]);
  const displayed = useTypewriter(target, 1200, canAnimate);

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="headline-rewrite-loading"
      >
        <span className="text-sm text-white/40 animate-pulse">
          Loading headline…
        </span>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div
      className="relative flex h-full w-full flex-col gap-3 overflow-y-auto bg-black p-4 text-white"
      data-testid="headline-rewrite"
    >
      {/* Top bar: title + info popover */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold text-white/80">
            Headline Rewrite
          </h3>
          <DashboardInfo blurb={HEADLINE_BLURB} />
        </div>
        <span
          className="text-[10px] uppercase tracking-[0.2em] text-white/40"
          data-testid="headline-rewrite-status"
        >
          {hasResolution ? "Resolved" : "Deliberating"}
        </span>
      </div>

      {/* Newspaper masthead */}
      <div className="border-t border-b border-white/15 py-1.5">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/60">
          <span className="font-serif italic tracking-normal text-base text-white/80">
            The Quorum Tribune
          </span>
          <span className="font-mono">{formatDateline()}</span>
        </div>
      </div>

      {/* WAS / NOW toggle — only meaningful once we have a resolution. */}
      {hasResolution && (
        <div
          className="mt-2 inline-flex items-center gap-1 self-start rounded-sm border border-white/15 bg-white/[0.04] p-0.5 text-[10px] font-semibold uppercase tracking-[0.2em]"
          data-testid="headline-rewrite-was-now-toggle"
          role="group"
          aria-label="Toggle between original and resolved framing"
        >
          <button
            type="button"
            onClick={() => setView("was")}
            aria-pressed={view === "was"}
            className={
              "rounded-[2px] px-2 py-1 transition-colors " +
              (view === "was"
                ? "bg-amber-400/20 text-amber-300"
                : "text-white/55 hover:text-white/80")
            }
          >
            Was
          </button>
          <button
            type="button"
            onClick={() => setView("now")}
            aria-pressed={view === "now"}
            className={
              "rounded-[2px] px-2 py-1 transition-colors " +
              (view === "now"
                ? "bg-white/15 text-white"
                : "text-white/55 hover:text-white/80")
            }
          >
            Now
          </button>
        </div>
      )}

      {/* Headline — large serif, single source of truth driven by toggle. */}
      <div
        className="relative mt-1 select-none"
        data-testid="headline-rewrite-headline"
      >
        <h1
          className={
            "font-serif text-3xl leading-[1.08] tracking-tight sm:text-4xl md:text-5xl " +
            (view === "was" && hasResolution
              ? "text-white/85 underline decoration-amber-400/70 decoration-[2px] underline-offset-[6px]"
              : "text-white")
          }
          data-testid="headline-rewrite-current"
        >
          {displayed}
          {canAnimate && displayed.length < target.length && (
            <span className="ml-0.5 inline-block h-[0.8em] w-[3px] -translate-y-[0.1em] bg-amber-400 align-middle" />
          )}
        </h1>
        {view === "was" && hasResolution && (
          <div
            className="mt-2 inline-flex items-center gap-2 rounded-sm bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-300"
            data-testid="headline-rewrite-was-caption"
          >
            Was <span className="text-amber-400">→</span> Now
          </div>
        )}
      </div>

      {/* Dek (subhead) */}
      {dek ? (
        <p
          className="mt-1 max-w-3xl font-serif text-base leading-snug text-white/75 italic"
          data-testid="headline-rewrite-dek"
        >
          {dek}
        </p>
      ) : !hasResolution ? (
        <p
          className="mt-1 max-w-3xl font-serif text-sm italic text-white/50"
          data-testid="headline-rewrite-awaiting"
        >
          Awaiting resolution — quorum is still deliberating.
        </p>
      ) : null}

      {/* Byline */}
      {roles.length > 0 && (
        <div
          className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55"
          data-testid="headline-rewrite-byline"
        >
          <span className="text-white/70">
            By the {roles.length} {roles.length === 1 ? "persona" : "personas"} in this quorum
          </span>
          <span className="text-white/25">·</span>
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {roles.map((r) => (
              <li
                key={r.id || r.name}
                className="inline-flex items-center gap-1.5"
                data-testid={`headline-rewrite-byline-role-${r.id || r.name}`}
              >
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: r.color || "#a78bfa" }}
                />
                <span className="text-white/65">{r.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default HeadlineRewrite;
