"use client";

/**
 * useAgentDocuments — subscribes to agent documents for a quorum.
 *
 * Loads active documents on mount and merges realtime updates (inserts +
 * updates) so the DocumentPanel always shows the latest version.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import type { AgentDocument } from "@quorum/types";
import {
  getAgentDocuments,
  subscribeToAgentDocuments,
} from "@/lib/dataProvider";

export interface AgentDocumentsState {
  documents: AgentDocument[];
  loading: boolean;
  /** Non-null when the most recent fetch failed; null on success. */
  error: string | null;
  /** Re-fetch documents from the server (useful after a user-initiated edit). */
  refresh: () => Promise<void>;
}

export function useAgentDocuments(quorumId: string): AgentDocumentsState {
  const [documents, setDocuments] = useState<AgentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedOnce = useRef(false);

  const fetchDocuments = useCallback(async () => {
    if (!quorumId) {
      // No quorum yet — don't try to fetch; treat as "not loading".
      setLoading(false);
      return;
    }
    // Only show loading spinner on initial fetch, not on refreshes.
    // This prevents the dashboard from flashing blank during updates.
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }
    try {
      const docs = await getAgentDocuments(quorumId);
      setDocuments(docs);
      setError(null);
      hasLoadedOnce.current = true;
    } catch (err) {
      // Surface the failure so the dashboard can distinguish "empty" from "failed".
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      if (typeof console !== "undefined") {
        console.warn("[useAgentDocuments] fetch failed:", message);
      }
    } finally {
      setLoading(false);
    }
  }, [quorumId]);

  // Initial load
  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // Subscribe to realtime changes (inserts + updates)
  useEffect(() => {
    const unsub = subscribeToAgentDocuments(quorumId, (doc) => {
      setDocuments((prev) => {
        const idx = prev.findIndex((d) => d.id === doc.id);
        if (idx !== -1) {
          // Update existing entry (e.g. version bump, status change)
          const next = [...prev];
          next[idx] = doc;
          // Keep sorted by updated_at descending
          next.sort(
            (a, b) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          );
          return next;
        }
        // New document — prepend since it's the most recent
        return [doc, ...prev];
      });
    });

    return unsub;
  }, [quorumId]);

  return {
    documents,
    loading,
    error,
    refresh: fetchDocuments,
  };
}
