"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuorumSummary {
  id: string;
  title: string;
  description: string;
  status: string;
  created_at: string;
  archived?: boolean;
}

interface EventWithQuorums {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  status?: string;
  quorums: QuorumSummary[];
  archived?: boolean;
}

type ArchiveTarget = { type: "event" | "quorum"; id: string; name: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function fetchEventsWithQuorums(): Promise<EventWithQuorums[]> {
  const eventsRes = await fetch(`${API_BASE}/events`);
  if (!eventsRes.ok) throw new Error(`Failed to fetch events: ${eventsRes.status}`);
  const events: EventWithQuorums[] = await eventsRes.json();

  // Fetch quorums for each event in parallel
  const withQuorums = await Promise.all(
    events.map(async (event) => {
      try {
        const qRes = await fetch(`${API_BASE}/events/${event.id}/quorums`);
        const quorums: QuorumSummary[] = qRes.ok ? await qRes.json() : [];
        return { ...event, quorums };
      } catch {
        return { ...event, quorums: [] };
      }
    })
  );

  return withQuorums;
}

// ---------------------------------------------------------------------------
// Admin page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const [events, setEvents] = useState<EventWithQuorums[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track which items have been archived this session (soft-deleted locally)
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());

  // Confirm dialog state: set when the user wants to permanently delete an
  // already-archived item.  The dialog requires an extra click to proceed.
  const [pendingDelete, setPendingDelete] = useState<ArchiveTarget | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEventsWithQuorums();
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error loading data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // --- Archive (soft-delete) ---
  const handleArchive = useCallback(
    async (type: "event" | "quorum", id: string, name: string) => {
      setActionBusy(true);
      setActionMessage(null);
      try {
        const path = type === "event" ? `/events/${id}/archive` : `/quorums/${id}/archive`;
        const res = await fetch(`${API_BASE}${path}`, { method: "PATCH" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail ?? `HTTP ${res.status}`);
        }
        setArchivedIds((prev) => new Set([...prev, id]));
        setActionMessage(`"${name}" archived.`);
      } catch (err) {
        setActionMessage(
          `Archive failed: ${err instanceof Error ? err.message : "Unknown error"}`
        );
      } finally {
        setActionBusy(false);
      }
    },
    []
  );

  // --- Permanent delete (only allowed after archive) ---
  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { type, id, name } = pendingDelete;

    setActionBusy(true);
    setActionMessage(null);
    try {
      const path = type === "event" ? `/events/${id}` : `/quorums/${id}`;
      const res = await fetch(`${API_BASE}${path}?confirm=true`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `HTTP ${res.status}`);
      }
      setActionMessage(`"${name}" permanently deleted.`);
      setPendingDelete(null);
      // Refresh list so the deleted item disappears
      await load();
    } catch (err) {
      setActionMessage(
        `Delete failed: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setActionBusy(false);
    }
  }, [pendingDelete, load]);

  const isArchived = (id: string) => archivedIds.has(id);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <header className="mb-8">
        <nav className="text-sm text-gray-400 mb-2">
          <Link href="/" className="hover:text-gray-600">
            Home
          </Link>
          <span className="mx-1">/</span>
          <span className="text-gray-700">Admin</span>
        </nav>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage events and quorums. Archive first, then permanently delete.
        </p>
      </header>

      {/* Status message banner */}
      {actionMessage && (
        <div
          className={`mb-4 rounded-lg px-4 py-3 text-sm font-medium ${
            actionMessage.startsWith("Archive failed") ||
            actionMessage.startsWith("Delete failed")
              ? "bg-red-50 text-red-700 border border-red-200"
              : "bg-green-50 text-green-700 border border-green-200"
          }`}
        >
          {actionMessage}
          <button
            type="button"
            className="ml-3 text-xs underline opacity-60 hover:opacity-100"
            onClick={() => setActionMessage(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="animate-pulse space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-40 bg-gray-100 rounded-xl" />
          ))}
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="text-center py-12 text-red-500">
          <p className="font-medium">{error}</p>
          <button
            type="button"
            className="mt-3 text-sm text-indigo-600 underline"
            onClick={load}
          >
            Retry
          </button>
        </div>
      )}

      {/* Event list */}
      {!loading && !error && (
        <div className="space-y-6">
          {events.length === 0 && (
            <div className="text-center py-16 text-gray-400">
              <p>No events found.</p>
            </div>
          )}

          {events.map((event) => {
            const eventArchived = isArchived(event.id) || event.status === "archived";
            return (
              <div
                key={event.id}
                className={`border rounded-xl overflow-hidden ${
                  eventArchived
                    ? "border-gray-200 bg-gray-50 opacity-70"
                    : "border-gray-200 bg-white"
                }`}
              >
                {/* Event header row */}
                <div className="p-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="font-semibold text-base truncate">{event.name}</h2>
                      {eventArchived && (
                        <span className="text-[10px] bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded font-medium uppercase tracking-wide">
                          archived
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400 flex-wrap">
                      <span className="font-mono">{event.slug}</span>
                      <span>{new Date(event.created_at).toLocaleDateString()}</span>
                      <span>{event.quorums.length} quorum{event.quorums.length !== 1 ? "s" : ""}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!eventArchived ? (
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => handleArchive("event", event.id, event.name)}
                        className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-50"
                      >
                        Archive
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() =>
                          setPendingDelete({ type: "event", id: event.id, name: event.name })
                        }
                        className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                      >
                        Delete permanently
                      </button>
                    )}
                  </div>
                </div>

                {/* Quorums sub-list */}
                {event.quorums.length > 0 && (
                  <div className="border-t border-gray-100 divide-y divide-gray-100">
                    {event.quorums.map((quorum) => {
                      const qArchived =
                        isArchived(quorum.id) || quorum.status === "archived";
                      return (
                        <div
                          key={quorum.id}
                          className={`px-4 py-3 flex items-center justify-between gap-3 pl-8 ${
                            qArchived ? "opacity-60" : ""
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium truncate">
                                {quorum.title}
                              </span>
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ${
                                  quorum.status === "resolved"
                                    ? "bg-green-100 text-green-700"
                                    : quorum.status === "archived"
                                    ? "bg-gray-200 text-gray-500"
                                    : "bg-blue-100 text-blue-600"
                                }`}
                              >
                                {qArchived ? "archived" : quorum.status}
                              </span>
                            </div>
                            <span className="text-xs text-gray-400">
                              {new Date(quorum.created_at).toLocaleDateString()}
                            </span>
                          </div>

                          <div className="flex-shrink-0">
                            {!qArchived ? (
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() =>
                                  handleArchive("quorum", quorum.id, quorum.title)
                                }
                                className="text-xs px-2.5 py-1 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-50"
                              >
                                Archive
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() =>
                                  setPendingDelete({
                                    type: "quorum",
                                    id: quorum.id,
                                    name: quorum.title,
                                  })
                                }
                                className="text-xs px-2.5 py-1 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                              >
                                Delete permanently
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Permanent delete confirmation modal */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-red-700 mb-2">Permanent deletion</h3>
            <p className="text-sm text-gray-600 mb-5">
              This will permanently delete{" "}
              <strong>&ldquo;{pendingDelete.name}&rdquo;</strong> and cannot be
              undone. Are you sure?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => setPendingDelete(null)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionBusy}
                onClick={handleDelete}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {actionBusy ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
