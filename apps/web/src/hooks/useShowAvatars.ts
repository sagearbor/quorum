"use client";

import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "quorumShowAvatars";
const CUSTOM_EVENT = "quorum-show-avatars-changed";

/**
 * Global avatar visibility toggle.
 *
 * Default ON for existing users (opt-out, not opt-in).  Persisted in
 * localStorage.  Cross-tab sync uses the native `storage` event; SAME-tab
 * sync uses a custom `quorum-show-avatars-changed` event because `storage`
 * does not fire in the originating tab.
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
    function onCustom(e: Event) {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setShowAvatarsState(detail);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(CUSTOM_EVENT, onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CUSTOM_EVENT, onCustom as EventListener);
    };
  }, []);

  const setShowAvatars = useCallback((next: boolean) => {
    setShowAvatarsState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      // ignore
    }
    // Notify every other useShowAvatars instance mounted in this tab.
    try {
      window.dispatchEvent(new CustomEvent<boolean>(CUSTOM_EVENT, { detail: next }));
    } catch {
      // ignore
    }
  }, []);

  const toggleAvatars = useCallback(() => {
    setShowAvatars(!showAvatars);
  }, [showAvatars, setShowAvatars]);

  return { showAvatars, setShowAvatars, toggleAvatars };
}
