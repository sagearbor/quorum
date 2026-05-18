"use client";

import { useState, useEffect } from "react";
import { useArchitectStore } from "@/store/architect";
import { slugify } from "@/lib/slugify";
import { QRCodeSVG } from "qrcode.react";
import { ArchitectMicButton } from "./ArchitectMicButton";
import { EventActionButtons } from "@/components/events/EventActionButtons";
import type { RealtimeToolCall } from "@/hooks/useArchitectRealtime";

interface ExistingEvent {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  archived_at?: string | null;
}

export function CreateEventForm() {
  const { eventDraft, setEventDraft, setEventId, setStep } =
    useArchitectStore();

  const stationCount = eventDraft.max_active_quorums || 5;
  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://quorum.app";

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [existingEvents, setExistingEvents] = useState<ExistingEvent[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  // Existing-events accordion is collapsed by default — the architect is
  // primarily for *creating* events; picking an existing one is the rare path.
  const [showExisting, setShowExisting] = useState(false);

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

  // Load existing events on mount + whenever the archive filter flips
  useEffect(() => {
    const url = `${apiBase}/events${showArchived ? "?include_archived=true" : ""}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setExistingEvents(data ?? []))
      .catch(() => {});
  }, [apiBase, showArchived]);

  function selectExistingEvent(event: ExistingEvent) {
    setEventId(event.id);
    setEventDraft({ name: event.name, slug: event.slug });
    setStep(2);
  }

  function refetchEvents() {
    fetch(`${apiBase}/events${showArchived ? "?include_archived=true" : ""}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setExistingEvents(data ?? []))
      .catch(() => {});
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: eventDraft.name,
          slug: eventDraft.slug,
          access_code: eventDraft.access_code,
          max_active_quorums: eventDraft.max_active_quorums,
        }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json();
          detail = body.detail ?? JSON.stringify(body);
        } catch {
          detail = await res.text().catch(() => "Unknown error");
        }
        if (res.status === 409) {
          setError(`Event slug "${eventDraft.slug}" already exists. Try a different name.`);
        } else {
          setError(`Server error (${res.status}): ${detail}`);
        }
        return;
      }
      const data = await res.json();
      setEventId(data.id);
      setStep(2);
    } catch {
      setError(
        `Cannot reach API at ${apiBase}. Make sure the backend is running:\n` +
        `  ./scripts/start.sh api`
      );
    } finally {
      setSubmitting(false);
    }
  }

  const isValid =
    eventDraft.name.trim() !== "" &&
    eventDraft.slug.trim() !== "" &&

    eventDraft.max_active_quorums > 0;

  // Voice-driven form fill. gpt-realtime calls these tools mid-conversation
  // via WebRTC and we route the parsed arguments back into Zustand here.
  // `problem_description` belongs to step 2 but we stash it on the architect
  // store so the next step can pick it up without the user re-typing.
  function handleVoiceFormUpdate(call: RealtimeToolCall) {
    const args = call.arguments as {
      event_title?: string;
      event_slug?: string;
      problem_description?: string;
    };
    if (call.name === "set_event_metadata") {
      const patch: Partial<typeof eventDraft> = {};
      if (typeof args.event_title === "string" && args.event_title.trim()) {
        patch.name = args.event_title.trim();
        if (!args.event_slug) {
          patch.slug = slugify(args.event_title);
        }
      }
      if (typeof args.event_slug === "string" && args.event_slug.trim()) {
        patch.slug = slugify(args.event_slug);
      }
      if (Object.keys(patch).length > 0) setEventDraft(patch);
      if (
        typeof args.problem_description === "string" &&
        args.problem_description.trim()
      ) {
        useArchitectStore
          .getState()
          .setProblemDescription(args.problem_description.trim());
      }
    } else if (call.name === "submit_form") {
      if (isValid && !submitting) {
        const fakeEvt = { preventDefault: () => {} } as React.FormEvent;
        void handleSubmit(fakeEvt);
      }
    }
  }

  return (
    <div className="space-y-6">
      <ArchitectMicButton onFormUpdate={handleVoiceFormUpdate} />

      {/* Existing events — collapsed by default since the architect is
          primarily for creating new events.  Click to expand. */}
      {(existingEvents.length > 0 || showArchived) && (
        <div>
          <button
            type="button"
            onClick={() => setShowExisting((v) => !v)}
            aria-expanded={showExisting}
            data-testid="existing-events-toggle"
            className="w-full flex items-center justify-between mb-2 px-1 py-1 -mx-1 rounded hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`text-gray-400 transition-transform ${showExisting ? "rotate-90" : ""}`}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              Continue with an existing event
              <span className="ml-1 text-xs font-normal text-gray-400">
                ({existingEvents.length})
              </span>
            </h3>
            {showExisting && (
              <label
                className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                />
                Show archived
              </label>
            )}
          </button>
          {showExisting && (
          <>
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {existingEvents.map((ev) => {
              const isArchived = !!ev.archived_at;
              return (
                <div
                  key={ev.id}
                  className={`flex items-center gap-1 px-3 py-2 rounded-lg border transition-colors ${
                    isArchived
                      ? "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 opacity-70"
                      : "border-gray-200 dark:border-gray-600 hover:border-indigo-300 dark:hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectExistingEvent(ev)}
                    disabled={isArchived}
                    className="flex-1 text-left flex items-center justify-between min-w-0 disabled:cursor-not-allowed"
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {ev.name}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                        /{ev.slug}
                      </span>
                      {isArchived && (
                        <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 flex-shrink-0">
                          archived
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-500 ml-2 flex-shrink-0">
                      {new Date(ev.created_at).toLocaleDateString()}
                    </span>
                  </button>
                  <EventActionButtons
                    event={ev}
                    isArchived={isArchived}
                    onArchiveChanged={(archived) =>
                      setExistingEvents((prev) =>
                        prev.map((e) =>
                          e.id === ev.id
                            ? { ...e, archived_at: archived ? new Date().toISOString() : null }
                            : e,
                        ),
                      )
                    }
                    onDeleted={() =>
                      setExistingEvents((prev) => prev.filter((e) => e.id !== ev.id))
                    }
                    onError={refetchEvents}
                  />
                </div>
              );
            })}
          </div>
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200 dark:border-gray-700" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white dark:bg-gray-800 px-3 text-xs text-gray-500 dark:text-gray-400">or create new</span>
            </div>
          </div>
          </>
          )}
        </div>
      )}

    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label
          htmlFor="event-name"
          className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
        >
          Event Name
        </label>
        <input
          id="event-name"
          type="text"
          value={eventDraft.name}
          onChange={(e) => {
            setEventDraft({
              name: e.target.value,
              slug: slugify(e.target.value),
            });
          }}
          placeholder="Duke Expo 2026"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label
          htmlFor="event-slug"
          className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
        >
          Slug
        </label>
        <input
          id="event-slug"
          type="text"
          value={eventDraft.slug}
          onChange={(e) => setEventDraft({ slug: slugify(e.target.value) })}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        />
      </div>

      <div>
        <label
          htmlFor="access-code"
          className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
        >
          Access Code{" "}
          <span className="font-normal text-gray-400 dark:text-gray-500">(optional)</span>
        </label>
        <input
          id="access-code"
          type="text"
          value={eventDraft.access_code}
          onChange={(e) =>
            setEventDraft({ access_code: e.target.value.toUpperCase() })
          }
          placeholder="Leave blank for open access"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          If blank, anyone with the link can join without a code.
        </p>
      </div>

      <div>
        <label
          htmlFor="max-quorums"
          className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
        >
          Max Concurrent Quorums
        </label>
        <input
          id="max-quorums"
          type="number"
          min={1}
          max={20}
          value={eventDraft.max_active_quorums}
          onChange={(e) =>
            setEventDraft({ max_active_quorums: Number(e.target.value) })
          }
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        />
      </div>

      {eventDraft.slug && (
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
            Station QR Codes
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {Array.from({ length: stationCount }, (_, i) => {
              const url = `${baseUrl}/event/${eventDraft.slug}?station=${i + 1}`;
              return (
                <div
                  key={i}
                  className="flex flex-col items-center p-3 border border-gray-200 rounded-lg bg-white"
                >
                  <QRCodeSVG value={url} size={96} level="M" />
                  <span className="mt-2 text-xs font-medium text-gray-600">
                    Station {i + 1}
                  </span>
                  <span className="text-[10px] text-gray-400 truncate max-w-full">
                    {url}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!isValid || submitting}
        className="w-full py-2.5 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "Creating..." : "Create Event \u2192"}
      </button>
    </form>
    </div>
  );
}
