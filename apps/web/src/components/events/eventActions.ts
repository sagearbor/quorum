/**
 * Shared archive/delete actions for events.
 *
 * Used by both /events (top-level listing) and the architect's existing-events
 * picker.  Keep these as plain async helpers — the caller owns the optimistic
 * state update + the re-fetch fallback so each page can decide how to surface
 * partial-failure cases.
 */

export interface ArchiveableEvent {
  id: string;
  name: string;
}

function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
}

/** PATCH /events/{id} toggling archived_at. Throws on non-2xx. */
export async function patchEventArchived(
  eventId: string,
  archived: boolean,
): Promise<void> {
  const res = await fetch(`${apiBase()}/events/${eventId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Show a browser confirm dialog, then DELETE /events/{id} on accept.
 * Returns true when the event was actually deleted, false when the user
 * cancelled.  Throws on non-2xx (excluding 204).
 */
export async function confirmAndDeleteEvent(
  event: ArchiveableEvent,
): Promise<boolean> {
  if (
    typeof window !== "undefined" &&
    !window.confirm(
      `Permanently delete "${event.name}"?\n\nAll quorums, contributions, and artifacts in this event will also be deleted. This cannot be undone.`,
    )
  ) {
    return false;
  }
  const res = await fetch(`${apiBase()}/events/${event.id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
  return true;
}
