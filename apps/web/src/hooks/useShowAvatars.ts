"use client";

import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "quorumShowAvatars";

/**
 * Global avatar visibility toggle.
 *
 * Default ON for existing users (opt-out, not opt-in).  Persisted in
 * localStorage and synchronised across tabs via the `storage` event so that
 * flipping the toggle in the navbar updates every open page instantly.
 *
 * Pages that render avatars MUST conditionally omit the entire <AvatarPanel>
 * div when this is false — never just blank/hide it, since a leftover layout
 * box looks broken.
 */
export function useShowAvatars(): {
  showAvatars: boolean;
  setShowAvatars: (next: boolean) => void;
  toggleAvatars: () => void;
} {
  const [showAvatars, setShowAvatarsState] = useState<boolean>(true);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        setShowAvatarsState(stored !== "false");
      }
    } catch {
      // localStorage not available — keep default
    }

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setShowAvatarsState(e.newValue !== "false");
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setShowAvatars = useCallback((next: boolean) => {
    setShowAvatarsState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      // ignore
    }
  }, []);

  const toggleAvatars = useCallback(() => {
    setShowAvatars(!showAvatars);
  }, [showAvatars, setShowAvatars]);

  return { showAvatars, setShowAvatars, toggleAvatars };
}
