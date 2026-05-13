"use client";

/**
 * /pair — QR-landing page.
 *
 * The station QR codes point here (?qr=<quorum_id>&st=<station_label>).
 * On mount we POST /sessions/participant to mint a phone participant_id,
 * stash it in sessionStorage as `quorum.participant`, then redirect to the
 * station URL (10.5 will introduce /agent/<role_id>; until then we fall back
 * to the existing station page with `?participant=<id>`).
 *
 * No JWT, no token exchange — just a UUID.  See checklist 10.4 + the audit
 * plan at docs/audit/2026-05-12-overnight-plan.html.
 */

import { useEffect, useState } from "react";
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

interface QuorumLookup {
  id: string;
  event_slug: string;
}

/**
 * Look up the event slug for a given quorum_id so we can build the station
 * fallback URL.  We hit GET /events and walk the results until we find the
 * matching quorum.  This is good enough for the small expo demo — a future
 * dedicated endpoint can replace it.
 */
async function resolveQuorumSlug(quorumId: string): Promise<string | null> {
  try {
    const eventsRes = await fetch(`${API_BASE}/events`);
    if (!eventsRes.ok) return null;
    const events: Array<{ slug: string }> = await eventsRes.json();
    for (const event of events) {
      const ids = await fetch(
        `${API_BASE}/events/${event.slug}/quorum-ids`,
      ).then((r) => (r.ok ? r.json() : []));
      if (Array.isArray(ids) && ids.includes(quorumId)) {
        return event.slug;
      }
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

export default function PairPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const quorumId = searchParams.get("qr");
  const stationLabel = searchParams.get("st") ?? null;

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

        const participant = {
          participant_id: data.participant_id,
          display_name: data.display_name,
          quorum_id: quorumId,
          station_label: stationLabel,
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

        // 10.5 will introduce /agent/<role_id>; until then fall back to the
        // station page with ?participant=<id>.
        const slug = await resolveQuorumSlug(quorumId);
        const stationParam = stationLabel
          ? `&station=${encodeURIComponent(
              stationLabel.replace(/^station-/, ""),
            )}`
          : "";
        const target = slug
          ? `/event/${slug}/quorum/${quorumId}?participant=${data.participant_id}${stationParam}`
          : `/event?participant=${data.participant_id}`;
        router.replace(target);
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
  }, [quorumId, stationLabel, router]);

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
              Redirecting to the station...
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
