"use client";

/**
 * PresenceDots — small filled dots showing who is connected at a role
 * (checklist 10.10).
 *
 * Consumes the PresenceMap returned by `usePresence(quorumId)`.  Renders up
 * to `max` dots (default 3).  When more participants are present than `max`,
 * shows `max - 1` dots + a "+N" badge.
 *
 * Color palette matches AvatarPanel:
 *   - emerald : last heartbeat <  60s   (fresh / active)
 *   - amber   : last heartbeat 60-120s  (stale / idle)
 *   - red     : last heartbeat >120s    (offline — but those are filtered out
 *               by usePresence so this only renders if the consumer passes a
 *               PresenceMap directly without bucketing — defensive only)
 *
 * Empty state: renders `null`.  Per spec, "no one online" is noise.
 */

import { motion, AnimatePresence } from "framer-motion";
import type { PresenceBucket, PresenceMap } from "@/hooks/usePresence";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PresenceDotsProps {
  /** Role to render presence for. */
  roleId: string;
  /** Map from `usePresence(quorumId)`. */
  presence: PresenceMap;
  /** Maximum dots to render before collapsing to "+N".  Defaults to 3. */
  max?: number;
  /** Optional extra className for layout tweaks. */
  className?: string;
  /** Optional test id, useful when multiple instances share one parent. */
  "data-testid"?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUCKET_COLOR: Record<PresenceBucket, string> = {
  // Tailwind classes so dark mode + opacity scale cleanly.
  fresh: "bg-emerald-400",
  stale: "bg-amber-400",
  offline: "bg-red-400",
};

const BUCKET_LABEL: Record<PresenceBucket, string> = {
  fresh: "Connected",
  stale: "Idle",
  offline: "Offline",
};

function tooltipText(displayName: string, bucket: PresenceBucket, secs: number) {
  const status = BUCKET_LABEL[bucket];
  return `${displayName} — ${status} (last seen ${secs}s ago)`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PresenceDots({
  roleId,
  presence,
  max = 3,
  className,
  "data-testid": dataTestId,
}: PresenceDotsProps) {
  const info = presence.get(roleId);

  // Empty state — render nothing (per spec, "no one online" is noise).
  if (!info || info.participantCount === 0) return null;

  const total = info.participantCount;
  const overflow = total > max;
  // When overflowing we show (max - 1) dots + a "+N" badge to make room.
  const visibleCount = overflow ? Math.max(1, max - 1) : Math.min(total, max);
  const visible = info.participants.slice(0, visibleCount);
  const hiddenCount = total - visibleCount;

  return (
    <div
      className={`inline-flex items-center gap-1 ${className ?? ""}`.trim()}
      data-testid={dataTestId ?? `presence-dots-${roleId}`}
      data-presence-count={total}
      data-presence-bucket={info.bucket}
      aria-label={`${total} connected — newest ${info.lastSeenSeconds ?? 0}s ago`}
    >
      <AnimatePresence initial={false}>
        {visible.map((p) => (
          <motion.span
            key={p.id}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            data-testid={`presence-dot-${p.id}`}
            data-bucket={p.bucket}
            // The :hover ::after tooltip lives on this container — kept
            // dependency-free per spec ("light tooltips, no headless UI").
            className={`relative group inline-flex w-2 h-2 rounded-full ${BUCKET_COLOR[p.bucket]} ${
              p.bucket === "fresh" ? "shadow-[0_0_4px_rgba(52,211,153,0.6)]" : ""
            }`}
            title={tooltipText(p.displayName, p.bucket, p.lastSeenSeconds)}
          />
        ))}
      </AnimatePresence>
      {overflow && hiddenCount > 0 && (
        <span
          data-testid={`presence-overflow-${roleId}`}
          className="text-[10px] leading-none font-medium text-emerald-500 dark:text-emerald-300 bg-emerald-500/10 dark:bg-emerald-400/15 rounded-full px-1.5 py-0.5"
          title={`${hiddenCount} more connected`}
        >
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}

export default PresenceDots;
