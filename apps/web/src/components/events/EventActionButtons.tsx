"use client";

/**
 * Archive + delete icon buttons for an event row.
 *
 * Stateless — the parent owns the event list and is responsible for the
 * optimistic update + error-recovery (typically a re-fetch).  Used by
 * /events and the architect's existing-events picker so the two stay in
 * lockstep visually and behaviourally.
 */

import { confirmAndDeleteEvent, patchEventArchived, type ArchiveableEvent } from "./eventActions";

interface EventActionButtonsProps {
  event: ArchiveableEvent;
  isArchived: boolean;
  onArchiveChanged: (archived: boolean) => void;
  onDeleted: () => void;
  /** Called when an API call throws so the parent can re-fetch to recover. */
  onError?: () => void;
  /** Icon dimension in px. Defaults to 14 (compact); /events uses 16. */
  iconSize?: number;
}

export function EventActionButtons({
  event,
  isArchived,
  onArchiveChanged,
  onDeleted,
  onError,
  iconSize = 14,
}: EventActionButtonsProps) {
  async function handleArchive() {
    try {
      await patchEventArchived(event.id, !isArchived);
      onArchiveChanged(!isArchived);
    } catch {
      onError?.();
    }
  }

  async function handleDelete() {
    try {
      const deleted = await confirmAndDeleteEvent(event);
      if (deleted) onDeleted();
    } catch {
      onError?.();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleArchive}
        aria-label={isArchived ? `Unarchive ${event.name}` : `Archive ${event.name}`}
        title={isArchived ? "Unarchive" : "Archive"}
        className="p-1.5 rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors flex-shrink-0"
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      </button>
      <button
        type="button"
        onClick={handleDelete}
        aria-label={`Delete ${event.name}`}
        title="Delete (cascades to all quorums)"
        className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors flex-shrink-0"
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
      </button>
    </>
  );
}
