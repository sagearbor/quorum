"use client";

/**
 * usePresence — heartbeat / presence dots consumer (checklist 10.10).
 *
 * Subscribes to the ``participants`` table for a quorum, computes which
 * participants are "online" by comparing ``last_heartbeat_at`` against now,
 * and re-buckets every 15s so dots decay even when no realtime event arrives.
 *
 * Bucketing (matches the emerald / amber / red palette used by AvatarPanel):
 *   - fresh    : last heartbeat <  60s   → emerald (active)
 *   - stale    : last heartbeat 60-120s  → amber   (idle, may be away)
 *   - offline  : last heartbeat >120s    → counted out
 *
 * Returns a Map<role_id, PresenceInfo> so role-card components only need to
 * look up their own role.  Participants with role_id=null (eg fresh QR scans
 * before they've selected a role) are tracked under the empty-string key so
 * the hook never crashes on missing data, but no card should render them.
 */

import { useEffect, useRef, useState } from "react";
import {
  getParticipants,
  subscribeToParticipants,
  type Participant,
} from "@/lib/dataProvider";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Heartbeat younger than this counts as a green/active dot. */
export const PRESENCE_FRESH_MS = 60_000;
/** Heartbeat younger than this (but older than FRESH) counts as amber/stale. */
export const PRESENCE_STALE_MS = 120_000;
/** Re-evaluate the buckets on this cadence (decay without events). */
export const PRESENCE_TICK_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresenceBucket = "fresh" | "stale" | "offline";

export interface PresenceInfo {
  /** Number of online participants (fresh OR stale) for this role. */
  participantCount: number;
  /** Most recent heartbeat across all participants of this role. */
  lastSeen: Date | null;
  /** Seconds since the most recent heartbeat (rounded down). */
  lastSeenSeconds: number | null;
  /** Bucket for the *freshest* participant of this role. */
  bucket: PresenceBucket;
  /**
   * Per-participant breakdown for tooltip rendering.  Sorted newest-first.
   * Offline participants are excluded.
   */
  participants: Array<{
    id: string;
    displayName: string;
    bucket: PresenceBucket;
    lastSeenSeconds: number;
  }>;
}

export type PresenceMap = Map<string, PresenceInfo>;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function bucketFor(deltaMs: number): PresenceBucket {
  if (deltaMs < PRESENCE_FRESH_MS) return "fresh";
  if (deltaMs < PRESENCE_STALE_MS) return "stale";
  return "offline";
}

interface ParticipantMeta {
  id: string;
  displayName: string;
  bucket: PresenceBucket;
  deltaMs: number;
  lastSeenSeconds: number;
  tsMs: number | null;
}

function computePresence(
  participants: Participant[] | Iterable<Participant>,
  now: number,
): PresenceMap {
  // Normalize to array so we can use Array iteration helpers (TS target =
  // ES2017, so Map/Set iteration requires downlevelIteration).
  const all: Participant[] = Array.isArray(participants)
    ? participants
    : Array.from(participants);

  const byRole = new Map<string, Participant[]>();
  all.forEach((p) => {
    const key = p.role_id ?? "";
    const bucket = byRole.get(key) ?? [];
    bucket.push(p);
    byRole.set(key, bucket);
  });

  const out: PresenceMap = new Map();
  byRole.forEach((rows, roleId) => {
    // Compute per-participant metadata, drop offline.
    const meta: ParticipantMeta[] = rows
      .map((p: Participant): ParticipantMeta => {
        const ts = p.last_heartbeat_at
          ? Date.parse(p.last_heartbeat_at)
          : NaN;
        const delta = Number.isFinite(ts) ? now - ts : Number.POSITIVE_INFINITY;
        return {
          id: p.id,
          displayName: p.display_name,
          bucket: bucketFor(delta),
          deltaMs: delta,
          lastSeenSeconds: Math.max(0, Math.floor(delta / 1000)),
          tsMs: Number.isFinite(ts) ? ts : null,
        };
      })
      .filter((m: ParticipantMeta) => m.bucket !== "offline")
      .sort((a: ParticipantMeta, b: ParticipantMeta) => a.deltaMs - b.deltaMs);

    if (meta.length === 0) {
      // No one online for this role — skip emit so .size reflects the count of
      // roles with at least one online participant.
      return;
    }

    const freshest = meta[0];
    out.set(roleId, {
      participantCount: meta.length,
      lastSeen: freshest.tsMs ? new Date(freshest.tsMs) : null,
      lastSeenSeconds: freshest.lastSeenSeconds,
      bucket: freshest.bucket,
      participants: meta.map((m: ParticipantMeta) => ({
        id: m.id,
        displayName: m.displayName,
        bucket: m.bucket,
        lastSeenSeconds: m.lastSeenSeconds,
      })),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to presence for a quorum.  Empty ``quorumId`` is a safe no-op.
 *
 * Returns a stable PresenceMap reference per render — keyed by role_id.
 * Roles with zero online participants are omitted from the map so consumers
 * can render nothing for them (matches the "no noise" rule from the spec).
 */
export function usePresence(quorumId: string): PresenceMap {
  // Raw participants keyed by participant.id.  We keep them in a ref so the
  // 15s tick can recompute without re-running the subscribe effect.
  const rowsRef = useRef<Map<string, Participant>>(new Map());

  const [presence, setPresence] = useState<PresenceMap>(() => new Map());

  // Recompute & publish the bucketed map from rowsRef.
  const recompute = () => {
    setPresence(
      computePresence(Array.from(rowsRef.current.values()), Date.now()),
    );
  };

  // (Re-)subscribe whenever quorumId changes.
  useEffect(() => {
    if (!quorumId) {
      rowsRef.current = new Map();
      setPresence(new Map());
      return;
    }

    let cancelled = false;
    rowsRef.current = new Map();
    setPresence(new Map());

    // Seed with initial snapshot.
    getParticipants(quorumId)
      .then((rows) => {
        if (cancelled) return;
        const next = new Map<string, Participant>();
        for (const p of rows) next.set(p.id, p);
        rowsRef.current = next;
        recompute();
      })
      .catch(() => {
        // Supabase unavailable — keep empty map, the 15s tick will retry
        // implicitly via no-op recompute.
      });

    // Realtime subscription.
    const unsub = subscribeToParticipants(quorumId, (evt) => {
      if (cancelled) return;
      if (evt.type === "DELETE") {
        if (evt.deletedId) {
          rowsRef.current.delete(evt.deletedId);
          recompute();
        }
        return;
      }
      if (evt.participant) {
        rowsRef.current.set(evt.participant.id, evt.participant);
        recompute();
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
    // recompute is stable (defined in closure, no deps) — intentionally omitted
    // from the dep list so re-subscribe only fires on quorum change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quorumId]);

  // Decay tick — re-bucket every PRESENCE_TICK_MS so dots fade out without
  // needing a realtime event.
  useEffect(() => {
    if (!quorumId) return;
    const handle = setInterval(recompute, PRESENCE_TICK_MS);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quorumId]);

  return presence;
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

/** @internal — exposed for unit tests. */
export const __test = { computePresence, bucketFor };
