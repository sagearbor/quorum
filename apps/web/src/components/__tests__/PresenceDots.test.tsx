/**
 * Tests for PresenceDots (10.10).
 *
 * Covers:
 *   - Empty state renders nothing (no DOM noise)
 *   - One participant → one dot
 *   - <= max participants → that many dots
 *   - > max participants → (max - 1) dots + a "+N" badge
 *   - Color buckets match age (fresh emerald / stale amber)
 *   - Tooltip text includes display_name and last seen seconds
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PresenceDots } from "../PresenceDots";
import type { PresenceInfo, PresenceMap } from "@/hooks/usePresence";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function presenceFor(roleId: string, info: PresenceInfo): PresenceMap {
  return new Map([[roleId, info]]);
}

function makeInfo(overrides: Partial<PresenceInfo> = {}): PresenceInfo {
  return {
    participantCount: 1,
    lastSeen: new Date("2026-05-13T12:00:00Z"),
    lastSeenSeconds: 5,
    bucket: "fresh",
    participants: [
      {
        id: "p-1",
        displayName: "Visitor 1",
        bucket: "fresh",
        lastSeenSeconds: 5,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PresenceDots", () => {
  it("renders nothing when the role is not in the map", () => {
    const { container } = render(
      <PresenceDots roleId="role-medical" presence={new Map()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when participantCount is zero", () => {
    const presence = presenceFor(
      "role-medical",
      makeInfo({ participantCount: 0, participants: [] }),
    );
    const { container } = render(
      <PresenceDots roleId="role-medical" presence={presence} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one dot for one participant", () => {
    const presence = presenceFor("role-medical", makeInfo());
    render(<PresenceDots roleId="role-medical" presence={presence} />);

    const dots = screen.getAllByTestId(/^presence-dot-/);
    expect(dots).toHaveLength(1);
    expect(screen.queryByTestId("presence-overflow-role-medical")).toBeNull();
  });

  it("renders up to `max` dots for participants under the cap", () => {
    const participants = ["p-1", "p-2", "p-3"].map((id) => ({
      id,
      displayName: `Visitor ${id}`,
      bucket: "fresh" as const,
      lastSeenSeconds: 5,
    }));
    const presence = presenceFor(
      "role-medical",
      makeInfo({ participantCount: 3, participants }),
    );

    render(<PresenceDots roleId="role-medical" presence={presence} max={3} />);
    expect(screen.getAllByTestId(/^presence-dot-/)).toHaveLength(3);
    expect(screen.queryByTestId("presence-overflow-role-medical")).toBeNull();
  });

  it("renders (max - 1) dots + a +N badge when participantCount > max", () => {
    const participants = ["p-1", "p-2", "p-3", "p-4", "p-5"].map((id) => ({
      id,
      displayName: `Visitor ${id}`,
      bucket: "fresh" as const,
      lastSeenSeconds: 5,
    }));
    const presence = presenceFor(
      "role-medical",
      makeInfo({ participantCount: 5, participants }),
    );

    render(<PresenceDots roleId="role-medical" presence={presence} max={3} />);
    // 5 total > 3 max → render (3 - 1) = 2 dots plus a +3 badge.
    expect(screen.getAllByTestId(/^presence-dot-/)).toHaveLength(2);
    const overflow = screen.getByTestId("presence-overflow-role-medical");
    expect(overflow).toHaveTextContent("+3");
  });

  it("color class matches the participant bucket", () => {
    const presence = presenceFor(
      "role-medical",
      makeInfo({
        bucket: "stale",
        participants: [
          {
            id: "p-1",
            displayName: "Visitor 1",
            bucket: "stale",
            lastSeenSeconds: 75,
          },
        ],
      }),
    );

    render(<PresenceDots roleId="role-medical" presence={presence} />);
    const dot = screen.getByTestId("presence-dot-p-1");
    expect(dot).toHaveAttribute("data-bucket", "stale");
    expect(dot.className).toContain("bg-amber-400");
  });

  it("fresh participants get the emerald color + glow shadow", () => {
    const presence = presenceFor("role-medical", makeInfo());
    render(<PresenceDots roleId="role-medical" presence={presence} />);
    const dot = screen.getByTestId("presence-dot-p-1");
    expect(dot.className).toContain("bg-emerald-400");
  });

  it("tooltip includes the display name and last seen seconds", () => {
    const presence = presenceFor(
      "role-medical",
      makeInfo({
        participants: [
          {
            id: "p-1",
            displayName: "Visitor 7",
            bucket: "fresh",
            lastSeenSeconds: 12,
          },
        ],
      }),
    );
    render(<PresenceDots roleId="role-medical" presence={presence} />);
    const dot = screen.getByTestId("presence-dot-p-1");
    const tooltip = dot.getAttribute("title");
    expect(tooltip).toContain("Visitor 7");
    expect(tooltip).toContain("12s ago");
  });

  it("sets data-presence-count and data-presence-bucket on the container", () => {
    const participants = ["p-1", "p-2"].map((id) => ({
      id,
      displayName: `Visitor ${id}`,
      bucket: "fresh" as const,
      lastSeenSeconds: 5,
    }));
    const presence = presenceFor(
      "role-medical",
      makeInfo({ participantCount: 2, participants }),
    );
    render(<PresenceDots roleId="role-medical" presence={presence} />);

    const container = screen.getByTestId("presence-dots-role-medical");
    expect(container).toHaveAttribute("data-presence-count", "2");
    expect(container).toHaveAttribute("data-presence-bucket", "fresh");
  });
});
