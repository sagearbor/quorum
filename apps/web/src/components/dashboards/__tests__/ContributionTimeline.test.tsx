import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { Role } from "@quorum/types";
import {
  ContributionTimeline,
  type TimelineEntry,
} from "../ContributionTimeline";

// ---------------------------------------------------------------------------
// Mocks — isolate the component from Supabase + dataProvider subs. The
// staticEntries / staticRoles props bypass the data path, but the realtime
// subscription effects still run, so stub them out.
// ---------------------------------------------------------------------------

vi.mock("@/lib/dataProvider", () => ({
  subscribeToContributions: vi.fn(() => () => {}),
  subscribeToQuorumA2ARequests: vi.fn(() => () => {}),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [] }),
          }),
        }),
      }),
    }),
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROLES: Pick<Role, "id" | "name" | "color">[] = [
  { id: "role-irb", name: "IRB Officer", color: "#DC2626" },
  { id: "role-sponsor", name: "Sponsor", color: "#2563EB" },
  { id: "role-site", name: "Site Coordinator", color: "#059669" },
];

const OLD = "2026-03-14T09:00:00Z";
const MID = "2026-03-14T11:30:00Z";
const NEW = "2026-03-14T14:45:00Z";
const NEWEST = "2026-03-14T16:12:00Z";

const ENTRIES: TimelineEntry[] = [
  {
    key: "contribution:c1",
    type: "contribution",
    createdAt: OLD,
    roleId: "role-irb",
    excerpt: "IRB note about consent timing",
    fullContent:
      "IRB note about consent timing. We need to revise the informed-consent form before re-enrolling at sites 3 and 7.",
  },
  {
    key: "chat:m1",
    type: "chat",
    createdAt: MID,
    roleId: "role-sponsor",
    excerpt: "Sponsor asked about budget impact",
    fullContent:
      "Sponsor asked about budget impact for the protocol amendment in PA-001.",
    subLabel: "user",
  },
  {
    key: "a2a:a1",
    type: "a2a",
    createdAt: NEW,
    roleId: "role-irb",
    targetRoleId: "role-site",
    excerpt: "Need site readiness confirmation",
    fullContent:
      "Need site readiness confirmation before approving the amended protocol; confirm IRB packet receipt by EoW.",
    subLabel: "review_request",
  },
  {
    key: "insight:i1",
    type: "insight",
    createdAt: NEWEST,
    roleId: "role-site",
    excerpt: "Three roles flagged enrollment risk",
    fullContent:
      "Three roles flagged enrollment risk; IRB silent so far. Site coverage 60%, below threshold.",
    subLabel: "summary",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContributionTimeline", () => {
  it("renders without error with empty static entries", () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={[]}
        staticRoles={ROLES}
      />,
    );
    expect(screen.getByTestId("contribution-timeline")).toBeTruthy();
  });

  it("shows the empty-state message when no events", () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={[]}
        staticRoles={ROLES}
      />,
    );
    expect(screen.getByTestId("timeline-empty")).toBeTruthy();
    expect(
      screen.getByText(
        /Timeline will populate as activity happens — no events yet\./,
      ),
    ).toBeTruthy();
  });

  it("renders one entry per event when entries are present", () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={ENTRIES}
        staticRoles={ROLES}
      />,
    );
    for (const e of ENTRIES) {
      expect(screen.getByTestId(`timeline-entry-${e.key}`)).toBeTruthy();
    }
  });

  it("sorts entries newest-first (chronological, descending)", () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={ENTRIES}
        staticRoles={ROLES}
      />,
    );
    const list = screen.getByTestId("timeline-list");
    const items = within(list).getAllByRole("listitem");
    const keys = items.map((li) => li.getAttribute("data-event-key"));
    // NEWEST → NEW → MID → OLD, regardless of insertion order in ENTRIES.
    expect(keys).toEqual([
      "insight:i1", // NEWEST
      "a2a:a1", // NEW
      "chat:m1", // MID
      "contribution:c1", // OLD
    ]);
  });

  it("renders all four type filter pills", () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={ENTRIES}
        staticRoles={ROLES}
      />,
    );
    expect(screen.getByTestId("filter-contribution")).toBeTruthy();
    expect(screen.getByTestId("filter-chat")).toBeTruthy();
    expect(screen.getByTestId("filter-a2a")).toBeTruthy();
    expect(screen.getByTestId("filter-insight")).toBeTruthy();
  });

  it("hides entries of a deselected type", async () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={ENTRIES}
        staticRoles={ROLES}
      />,
    );
    // Toggle off "chat" — chat:m1 should disappear (after framer-motion
    // AnimatePresence finishes its exit animation in jsdom).
    fireEvent.click(screen.getByTestId("filter-chat"));
    await waitFor(() => {
      expect(screen.queryByTestId("timeline-entry-chat:m1")).toBeNull();
    });
    // Other entries remain.
    expect(screen.getByTestId("timeline-entry-insight:i1")).toBeTruthy();
    expect(screen.getByTestId("timeline-entry-a2a:a1")).toBeTruthy();
    expect(screen.getByTestId("timeline-entry-contribution:c1")).toBeTruthy();
  });

  it("renders role names from staticRoles lookup", () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={ENTRIES}
        staticRoles={ROLES}
      />,
    );
    expect(screen.getAllByText("IRB Officer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sponsor").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Site Coordinator").length).toBeGreaterThan(0);
  });

  it("expands an entry when its card is clicked", () => {
    render(
      <ContributionTimeline
        quorumId="q1"
        staticEntries={ENTRIES}
        staticRoles={ROLES}
      />,
    );
    const entry = screen.getByTestId("timeline-entry-insight:i1");
    const button = within(entry).getByRole("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});
