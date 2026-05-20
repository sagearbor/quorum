/**
 * useAvatarChoice + Navbar dropdown smoke tests.
 *
 * Verifies:
 *   - hook defaults to "random"
 *   - hook reads + writes localStorage
 *   - Navbar renders the dropdown with the expected options
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, renderHook } from "@testing-library/react";
import {
  useAvatarChoice,
  resolveRandomAvatar,
  AVAILABLE_AVATARS,
  DEFAULT_AVATAR_CHOICE,
} from "../useAvatarChoice";
import { Navbar } from "@/components/Navbar";

// usePathname is required by Navbar.
vi.mock("next/navigation", () => ({
  usePathname: () => "/events",
}));

describe("useAvatarChoice", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'random' when localStorage is empty", () => {
    const { result } = renderHook(() => useAvatarChoice());
    expect(result.current.avatarChoice).toBe(DEFAULT_AVATAR_CHOICE);
    expect(DEFAULT_AVATAR_CHOICE).toBe("random");
  });

  it("persists a chosen avatar to localStorage", () => {
    const { result } = renderHook(() => useAvatarChoice());
    act(() => {
      result.current.setAvatarChoice("match_role");
    });
    expect(result.current.avatarChoice).toBe("match_role");
    expect(window.localStorage.getItem("quorumAvatarChoice")).toBe("match_role");
  });

  it("syncs changes across instances in the same tab via custom event", () => {
    const a = renderHook(() => useAvatarChoice());
    const b = renderHook(() => useAvatarChoice());
    const target = AVAILABLE_AVATARS[0].url;
    act(() => {
      a.result.current.setAvatarChoice(target);
    });
    expect(b.result.current.avatarChoice).toBe(target);
  });
});

describe("resolveRandomAvatar", () => {
  it("returns a stable avatar for the same seed", () => {
    const a = resolveRandomAvatar("Physician");
    const b = resolveRandomAvatar("Physician");
    expect(a).toBe(b);
    expect(AVAILABLE_AVATARS.some((x) => x.url === a)).toBe(true);
  });

  it("returns a valid avatar even for empty input", () => {
    const url = resolveRandomAvatar("");
    expect(AVAILABLE_AVATARS.some((x) => x.url === url)).toBe(true);
  });
});

describe("Navbar avatar choice dropdown", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the dropdown with Random + Match role + each available avatar", () => {
    render(<Navbar />);
    const select = screen.getByTestId("navbar-avatar-choice") as HTMLSelectElement;
    expect(select).toBeTruthy();
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain("random");
    expect(optionValues).toContain("match_role");
    for (const a of AVAILABLE_AVATARS) {
      expect(optionValues).toContain(a.url);
    }
    // Default selection should be Random.
    expect(select.value).toBe("random");
  });
});
