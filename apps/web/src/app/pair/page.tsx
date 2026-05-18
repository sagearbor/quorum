"use client";

/**
 * /pair — QR-landing page.
 *
 * The station QR codes point here (?qr=<quorum_id>&st=<station_label>&ev=<event_slug>).
 * On mount we POST /sessions/participant to mint a phone participant_id,
 * stash it in sessionStorage as `quorum.participant`, then redirect to the
 * full avatar quorum route at `/event/<slug>/quorum/<id>?station=N`.
 * Older QR codes (printed before ev= was added) omit ev — those fall back to
 * the text-only `/agent/<role_id>?ds=<participant_id>` mobile route.
 *
 * Role selection: the QR code does NOT carry a role_id, and the
 * `/sessions/participant` endpoint does not yet echo one back.  As a stop-gap
 * we look up the quorum's roles and pick by station index (1-based) — e.g.
 * `?st=station-1` → roles[0], `?st=station-2` → roles[1].  Falls back to
 * `roles[0]` when the index can't be parsed.  See the follow-up note in the
 * 10.5 report: a future API change should return the role_id with the
 * participant.
 *
 * No JWT, no token exchange — just a UUID.  See checklist 10.4 + 10.5 in
 * docs/audit/2026-05-12-overnight-plan.html.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type PairStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; displayName: string };

interface CreateParticipantResponse {
  participant_id: string;
  display_name: string;
}

interface MinimalRole {
  id: string;
  authority_rank?: number;
}

/**
 * Pick the role_id this station should bind to.  Stations are 1-indexed in
 * `station_label` ("station-1", "station-2", …); roles are returned in
 * authority_rank-descending order by `getRoles`.  When the index is missing
 * or out of range we pick the highest-rank role so the visitor always lands
 * on *something*.
 */
function pickRoleId(
  roles: MinimalRole[],
  stationLabel: string | null,
): string | null {
  if (roles.length === 0) return null;
  const match = stationLabel?.match(/(\d+)/);
  const idx = match ? parseInt(match[1], 10) - 1 : 0;
  if (Number.isNaN(idx) || idx < 0 || idx >= roles.length) {
    return roles[0].id;
  }
  return roles[idx].id;
}

async function fetchQuorumRoles(quorumId: string): Promise<MinimalRole[]> {
  try {
    const res = await fetch(`${API_BASE}/quorums/${quorumId}/roles`);
    if (!res.ok) return [];
    const data = (await res.json()) as MinimalRole[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function PairPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const quorumId = searchParams.get("qr");
  const stationLabel = searchParams.get("st") ?? null;
  const eventSlug = searchParams.get("ev") ?? null;

  const [status, setStatus] = useState<PairStatus>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function pair() {
      if (!quorumId) {
        setStatus({
          kind: "error",
          message: "Missing quorum ID. Re-scan the station QR code.",
        });
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/sessions/participant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quorum_id: quorumId,
            station_label: stationLabel,
            device_kind: "phone",
          }),
        });

        if (res.status === 404) {
          if (!cancelled) {
            setStatus({
              kind: "error",
              message: "Quorum not found. Ask the host to re-share the QR.",
            });
          }
          return;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = (await res.json()) as CreateParticipantResponse;
        if (cancelled) return;

        // Resolve role_id by listing the quorum's roles and picking by
        // station index.  Done AFTER the mint so we can still surface a
        // pairing-failed UI if the quorum has no roles configured.
        const roles = await fetchQuorumRoles(quorumId);
        const roleId = pickRoleId(roles, stationLabel);
        if (!roleId) {
          if (!cancelled) {
            setStatus({
              kind: "error",
              message:
                "No roles are set up on this quorum yet. Ask the host.",
            });
          }
          return;
        }

        const participant = {
          participant_id: data.participant_id,
          display_name: data.display_name,
          quorum_id: quorumId,
          station_label: stationLabel,
          role_id: roleId,
          device_kind: "phone" as const,
        };
        try {
          window.sessionStorage.setItem(
            "quorum.participant",
            JSON.stringify(participant),
          );
        } catch {
          /* sessionStorage may be unavailable (private mode); non-fatal */
        }

        setStatus({ kind: "ok", displayName: data.display_name });

        // Prefer the full avatar route when ev=<slug> is in the QR.  Older
        // printed QR codes don't include ev — those keep the legacy /agent
        // text-only redirect so existing handouts still work.
        if (eventSlug) {
          const stationNum = stationLabel?.match(/(\d+)/)?.[1];
          const stationQuery = stationNum ? `?station=${stationNum}` : "";
          router.replace(
            `/event/${encodeURIComponent(
              eventSlug,
            )}/quorum/${encodeURIComponent(quorumId)}${stationQuery}`,
          );
        } else {
          router.replace(
            `/agent/${encodeURIComponent(roleId)}?ds=${encodeURIComponent(
              data.participant_id,
            )}`,
          );
        }
      } catch {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message:
              "Could not reach the server. Check your connection and try again.",
          });
        }
      }
    }

    pair();
    return () => {
      cancelled = true;
    };
    // router is stable across renders in Next.js 14 — omit from deps to avoid
    // refiring the mint on each render in tests where the mock returns a new
    // object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quorumId, stationLabel, eventSlug]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-6">
      <div className="max-w-sm w-full bg-white dark:bg-slate-800 rounded-2xl shadow-md p-6 text-center">
        {status.kind === "loading" && (
          <>
            <div className="animate-pulse text-slate-500 dark:text-slate-400 mb-3">
              Pairing your device...
            </div>
            <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full w-1/3 bg-indigo-500 animate-[pulse_1.2s_ease-in-out_infinite]" />
            </div>
          </>
        )}
        {status.kind === "ok" && (
          <>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-white mb-1">
              Welcome, {status.displayName}
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Redirecting to the agent...
            </p>
          </>
        )}
        {status.kind === "error" && (
          <>
            <h1 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">
              Pairing failed
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {status.message}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// useSearchParams() requires a Suspense boundary during static prerender —
// otherwise Next.js bails out of static export with a CSR-bailout error.
export default function PairPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-6">
          <div className="text-slate-500 dark:text-slate-400">Loading…</div>
        </div>
      }
    >
      <PairPageInner />
    </Suspense>
  );
}
