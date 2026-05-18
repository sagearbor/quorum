"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getEvents, type EventSummary } from "@/lib/dataProvider";
import { EventActionButtons } from "@/components/events/EventActionButtons";

export default function EventsPage() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  const reload = useCallback(async () => {
    const list = await getEvents(showArchived);
    setEvents(list);
  }, [showArchived]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await getEvents(showArchived);
      if (!cancelled) {
        setEvents(list);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showArchived]);

  if (loading) {
    return (
      <div className="p-4 sm:p-8 max-w-4xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-200 rounded w-1/4" />
          <div className="space-y-3 mt-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-gray-100 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <header className="mb-8">
        <nav className="text-sm text-gray-500 dark:text-gray-400 mb-2">
          <Link href="/" className="hover:text-gray-600 dark:hover:text-gray-300">
            Home
          </Link>
          <span className="mx-1">/</span>
          <span className="text-gray-900 dark:text-gray-100">Events</span>
        </nav>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Events</h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              Select an event to view its quorums and join a station.
            </p>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none flex-shrink-0">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
            />
            Show archived
          </label>
        </div>
      </header>

      {events.length === 0 ? (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">
            {showArchived ? "No events found" : "No active events"}
          </p>
          <p className="text-sm">
            {showArchived ? (
              <>
                Create one in the{" "}
                <Link href="/architect" className="text-indigo-600 underline">
                  Architect
                </Link>
                .
              </>
            ) : (
              <>
                Try toggling &quot;Show archived&quot; or create one in the{" "}
                <Link href="/architect" className="text-indigo-600 underline">
                  Architect
                </Link>
                .
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => {
            const isArchived = !!event.archived_at;
            return (
              <div
                key={event.id}
                data-testid={`event-row-${event.slug}`}
                className={`flex items-center gap-2 border rounded-xl p-4 transition-all ${
                  isArchived
                    ? "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 opacity-70"
                    : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-indigo-300 hover:shadow-md"
                }`}
              >
                <Link
                  href={`/event/${event.slug}`}
                  data-testid={`event-card-${event.slug}`}
                  className="flex-1 min-w-0"
                >
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-base truncate">
                      {event.name}
                    </h2>
                    {isArchived && (
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 flex-shrink-0">
                        archived
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-sm text-gray-600 dark:text-gray-300">
                      {event.slug}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {new Date(event.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
                <EventActionButtons
                  event={event}
                  isArchived={isArchived}
                  iconSize={16}
                  onArchiveChanged={(archived) =>
                    setEvents((prev) =>
                      prev.map((e) =>
                        e.id === event.id
                          ? { ...e, archived_at: archived ? new Date().toISOString() : null }
                          : e,
                      ),
                    )
                  }
                  onDeleted={() =>
                    setEvents((prev) => prev.filter((e) => e.id !== event.id))
                  }
                  onError={reload}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8 text-center">
        <Link
          href="/architect"
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          Create New Event
        </Link>
      </div>
    </div>
  );
}
