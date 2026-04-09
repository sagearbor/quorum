"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getEvents, type EventSummary } from "@/lib/dataProvider";

export default function EventsPage() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const list = await getEvents();
        if (!cancelled) {
          setEvents(list);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

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
        <h1 className="text-2xl font-bold">Events</h1>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
          Select an event to view its quorums and join a station.
        </p>
      </header>

      {events.length === 0 ? (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No events found</p>
          <p className="text-sm">
            Create an event in the{" "}
            <Link href="/architect" className="text-indigo-600 underline">
              Architect
            </Link>{" "}
            to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <Link
              key={event.id}
              href={`/event/${event.slug}`}
              data-testid={`event-card-${event.slug}`}
              className="block border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-white dark:bg-gray-800 hover:border-indigo-300 hover:shadow-md transition-all"
            >
              <h2 className="font-semibold text-base">{event.name}</h2>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-sm text-gray-600 dark:text-gray-300">{event.slug}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {new Date(event.created_at).toLocaleDateString()}
                </span>
              </div>
            </Link>
          ))}
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
