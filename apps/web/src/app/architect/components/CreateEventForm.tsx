"use client";

import { useState } from "react";
import { useArchitectStore } from "@/store/architect";
import { slugify } from "@/lib/slugify";
import { QRCodeSVG } from "qrcode.react";

export function CreateEventForm() {
  const { eventDraft, setEventDraft, setEventId, setStep } =
    useArchitectStore();

  const stationCount = eventDraft.max_active_quorums || 5;
  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://quorum.app";

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
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
        const body = await res.text();
        setError(`Server error (${res.status}): ${body}`);
        return;
      }
      const data = await res.json();
      setEventId(data.id);
      setStep(2);
    } catch (err) {
      setError(
        `Cannot reach API at ${apiBase}. Make sure the backend is running:\n` +
        `  ./scripts/start-local.sh api`
      );
    } finally {
      setSubmitting(false);
    }
  }

  const isValid =
    eventDraft.name.trim() !== "" &&
    eventDraft.slug.trim() !== "" &&
    
    eventDraft.max_active_quorums > 0;

  return (
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
  );
}
