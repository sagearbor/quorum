"use client";

import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "quorumAvatarChoice";
const CUSTOM_EVENT = "quorum-avatar-choice-changed";

/**
 * Special sentinel values for `AvatarChoice`.
 *  - "random"     — deterministic-random per role (stable within a session).
 *  - "match_role" — current behaviour: resolveArchetype(roleName) → glbUrl.
 *  - anything else — treated as a literal GLB URL ("/avatars/avaturn/...glb").
 */
export type AvatarChoice = "random" | "match_role" | string;

export const DEFAULT_AVATAR_CHOICE: AvatarChoice = "random";

/** Friendly label + GLB URL for the available photoreal avatars. */
export interface AvailableAvatar {
  /** GLB URL — used as the `AvatarChoice` value when this one is picked. */
  url: string;
  /** Display label in the dropdown. */
  label: string;
}

/**
 * The set of photoreal avatars currently shipped under /public/avatars/avaturn/.
 * Order matters: this is the order shown in the Navbar dropdown.
 *
 * Kept in sync with `AVAILABLE_AVATURN` in archetypes.ts.
 */
export const AVAILABLE_AVATARS: ReadonlyArray<AvailableAvatar> = [
  { url: "/avatars/avaturn/female_assistant.glb",    label: "Taf v1" },
  { url: "/avatars/avaturn/female_assistant_sn.glb", label: "Taf v2" },
  { url: "/avatars/avaturn/female_business.glb",     label: "Stephanie" },
  { url: "/avatars/avaturn/humanities_social.glb",   label: "Sage (humanities)" },
  { url: "/avatars/avaturn/neutral.glb",             label: "Sage (neutral)" },
];

/**
 * Global avatar-choice preference.
 *
 * Default "random" so users don't see the same face every session.  When
 * "random", consumers should pass a stable id (role_id, role_name) to
 * `resolveRandomAvatar` so a given role consistently maps to the same avatar
 * within a session — no jitter on each contribution.
 *
 * Cross-tab sync uses native `storage`; same-tab sync uses a custom event
 * (mirrors useShowAvatars.ts).
 */
export function useAvatarChoice(): {
  avatarChoice: AvatarChoice;
  setAvatarChoice: (next: AvatarChoice) => void;
} {
  const [avatarChoice, setChoiceState] = useState<AvatarChoice>(DEFAULT_AVATAR_CHOICE);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setChoiceState(stored);
    } catch {
      // localStorage not available — keep default
    }

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setChoiceState(e.newValue || DEFAULT_AVATAR_CHOICE);
      }
    }
    function onCustom(e: Event) {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") setChoiceState(detail);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(CUSTOM_EVENT, onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CUSTOM_EVENT, onCustom as EventListener);
    };
  }, []);

  const setAvatarChoice = useCallback((next: AvatarChoice) => {
    setChoiceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent<string>(CUSTOM_EVENT, { detail: next }));
    } catch {
      // ignore
    }
  }, []);

  return { avatarChoice, setAvatarChoice };
}

/**
 * Deterministically map a seed string (role id, role name) to one of the
 * available avatars. Same seed → same avatar within a session. Empty seed
 * returns the first available avatar so the UI never breaks.
 */
export function resolveRandomAvatar(seed: string | undefined | null): string {
  const s = (seed ?? "").trim();
  if (!s) return AVAILABLE_AVATARS[0].url;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % AVAILABLE_AVATARS.length;
  return AVAILABLE_AVATARS[idx].url;
}
