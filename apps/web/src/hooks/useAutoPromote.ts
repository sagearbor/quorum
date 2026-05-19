"use client";

import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "quorumAutoPromote";
const CUSTOM_EVENT = "quorum-auto-promote-changed";

/**
 * Auto-promote chat-turn toggle (per-browser persistence).
 *
 * When ON, AI agent chat replies that score above the contribution-worthy
 * threshold get auto-inserted as ``contributions`` rows on the backend so the
 * chart moves on its own during conversation.  Default ON — a quorum visitor
 * arriving fresh sees the chart respond to chat immediately.
 *
 * Mirrors the ``useShowAvatars`` pattern: localStorage for persistence,
 * a ``storage`` listener for cross-tab sync, and a custom event for same-tab
 * sync (since the native ``storage`` event does not fire in the originating
 * tab).
 *
 * Setter side-effect: when a ``quorumId`` is supplied, the setter PATCHes
 * ``/quorums/{id}/auto-promote-chat`` so the backend ``process_agent_turn``
 * call gates auto-promote on the persisted column.  Failures are swallowed
 * — the localStorage state is still updated so the UI stays consistent.
 */
export function useAutoPromote(quorumId?: string): {
  autoPromote: boolean;
  setAutoPromote: (next: boolean) => void;
  toggleAutoPromote: () => void;
} {
  const [autoPromote, setAutoPromoteState] = useState<boolean>(true);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        setAutoPromoteState(stored !== "false");
      }
    } catch {
      // localStorage not available — keep default
    }

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setAutoPromoteState(e.newValue !== "false");
      }
    }
    function onCustom(e: Event) {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setAutoPromoteState(detail);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(CUSTOM_EVENT, onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CUSTOM_EVENT, onCustom as EventListener);
    };
  }, []);

  const setAutoPromote = useCallback(
    (next: boolean) => {
      setAutoPromoteState(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
      } catch {
        // ignore
      }
      try {
        window.dispatchEvent(
          new CustomEvent<boolean>(CUSTOM_EVENT, { detail: next })
        );
      } catch {
        // ignore
      }
      // Best-effort sync to backend so process_agent_turn honors the toggle.
      if (quorumId) {
        const apiBase =
          process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
        fetch(`${apiBase}/quorums/${quorumId}/auto-promote-chat`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auto_promote_chat: next }),
        }).catch(() => {
          // swallowed — localStorage state still reflects the user's intent
        });
      }
    },
    [quorumId]
  );

  const toggleAutoPromote = useCallback(() => {
    setAutoPromote(!autoPromote);
  }, [autoPromote, setAutoPromote]);

  return { autoPromote, setAutoPromote, toggleAutoPromote };
}
