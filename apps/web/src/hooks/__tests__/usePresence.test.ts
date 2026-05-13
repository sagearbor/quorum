/**
 * Tests for usePresence (10.10 — presence dots consumer).
 *
 * Covers:
 *   - Initial empty state
 *   - Seed snapshot is loaded on mount
 *   - INSERT / UPDATE / DELETE events update the map
 *   - Decay: a participant stops being "fresh" after 60s and "stale" after 120s
 *   - Switching quorumId re-subscribes (previous unsub fires)
 *   - Pure bucketFor / computePresence helpers
 *
 * Implementation notes:
 *   - We DO NOT call vi.useFakeTimers() globally — it conflicts with
 *     testing-library's waitFor (which polls on real timers).  Instead we
 *     drive decay tests by mocking Date.now() via vi.setSystemTime() while
 *     leaving timers real, and trigger recomputes by sending a UPDATE event
 *     (which calls recompute internally).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import {
  usePresence,
  __test,
  PRESENCE_FRESH_MS,
  PRESENCE_STALE_MS,
} from "../usePresence";
import type { Participant } from "@/lib/dataProvider";

// ---------------------------------------------------------------------------
// Mock dataProvider
// ---------------------------------------------------------------------------

type SubHandler = (evt: {
  type: "INSERT" | "UPDATE" | "DELETE";
  participant: Participant | null;
  deletedId?: string;
}) => void;

let capturedHandlers: Map<string, SubHandler> = new Map();
let unsubCalls: string[] = [];
let mockInitialParticipants: Map<string, Participant[]> = new Map();

const mockGetParticipants = vi.fn(async (quorumId: string) => {
  return mockInitialParticipants.get(quorumId) ?? [];
});

const mockSubscribeToParticipants = vi.fn(
  (quorumId: string, handler: SubHandler) => {
    capturedHandlers.set(quorumId, handler);
    return () => {
      unsubCalls.push(quorumId);
      capturedHandlers.delete(quorumId);
    };
  },
);

vi.mock("@/lib/dataProvider", () => ({
  getParticipants: (quorumId: string) => mockGetParticipants(quorumId),
  subscribeToParticipants: (quorumId: string, handler: SubHandler) =>
    mockSubscribeToParticipants(quorumId, handler),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-13T12:00:00.000Z").getTime();

function makeParticipant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: "p-001",
    quorum_id: "q-001",
    role_id: "role-medical",
    station_label: "station-1",
    display_name: "Visitor 1",
    device_kind: "laptop",
    last_heartbeat_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW - 30_000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — no timers needed
// ---------------------------------------------------------------------------

describe("usePresence helpers", () => {
  it("bucketFor returns fresh / stale / offline based on PRESENCE_* thresholds", () => {
    expect(__test.bucketFor(0)).toBe("fresh");
    expect(__test.bucketFor(PRESENCE_FRESH_MS - 1)).toBe("fresh");
    expect(__test.bucketFor(PRESENCE_FRESH_MS)).toBe("stale");
    expect(__test.bucketFor(PRESENCE_STALE_MS - 1)).toBe("stale");
    expect(__test.bucketFor(PRESENCE_STALE_MS)).toBe("offline");
    expect(__test.bucketFor(PRESENCE_STALE_MS + 100_000)).toBe("offline");
  });

  it("computePresence groups participants by role and buckets by age", () => {
    const rows = [
      makeParticipant({
        id: "a",
        role_id: "role-1",
        last_heartbeat_at: new Date(NOW - 1_000).toISOString(),
      }),
      makeParticipant({
        id: "b",
        role_id: "role-1",
        last_heartbeat_at: new Date(NOW - 90_000).toISOString(),
      }),
      makeParticipant({
        id: "c",
        role_id: "role-2",
        last_heartbeat_at: new Date(NOW - 200_000).toISOString(),
      }),
    ];

    const map = __test.computePresence(rows, NOW);

    expect(map.get("role-1")?.participantCount).toBe(2);
    expect(map.get("role-1")?.bucket).toBe("fresh");
    // role-2 only had an offline participant — should be absent from the map.
    expect(map.get("role-2")).toBeUndefined();
  });

  it("computePresence sorts per-role participants newest-first", () => {
    const rows = [
      makeParticipant({
        id: "older",
        last_heartbeat_at: new Date(NOW - 30_000).toISOString(),
      }),
      makeParticipant({
        id: "newer",
        last_heartbeat_at: new Date(NOW - 1_000).toISOString(),
      }),
    ];

    const map = __test.computePresence(rows, NOW);
    const info = map.get("role-medical");
    expect(info?.participants[0].id).toBe("newer");
    expect(info?.participants[1].id).toBe("older");
  });

  it("computePresence handles a missing/invalid last_heartbeat_at gracefully", () => {
    const rows = [makeParticipant({ id: "x", last_heartbeat_at: null })];
    const map = __test.computePresence(rows, NOW);
    // Treated as infinitely old → offline → dropped.
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hook tests
// ---------------------------------------------------------------------------

describe("usePresence hook", () => {
  beforeEach(() => {
    capturedHandlers = new Map();
    unsubCalls = [];
    mockInitialParticipants = new Map();
    mockGetParticipants.mockClear();
    mockSubscribeToParticipants.mockClear();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty map when quorumId is empty", () => {
    const { result } = renderHook(() => usePresence(""));
    expect(result.current.size).toBe(0);
    expect(mockSubscribeToParticipants).not.toHaveBeenCalled();
  });

  it("seeds presence from getParticipants on mount", async () => {
    mockInitialParticipants.set("q-001", [
      makeParticipant({ id: "p-1" }),
      makeParticipant({ id: "p-2", role_id: "role-ethics" }),
    ]);

    const { result } = renderHook(() => usePresence("q-001"));

    await waitFor(() => {
      expect(result.current.get("role-medical")?.participantCount).toBe(1);
      expect(result.current.get("role-ethics")?.participantCount).toBe(1);
    });
  });

  it("adds presence on INSERT events from realtime", async () => {
    const { result } = renderHook(() => usePresence("q-001"));

    await waitFor(() => expect(capturedHandlers.get("q-001")).toBeDefined());

    act(() => {
      capturedHandlers.get("q-001")!({
        type: "INSERT",
        participant: makeParticipant({ id: "fresh-1" }),
      });
    });

    expect(result.current.get("role-medical")?.participantCount).toBe(1);
    expect(result.current.get("role-medical")?.bucket).toBe("fresh");
  });

  it("updates presence on UPDATE events (heartbeat refresh)", async () => {
    mockInitialParticipants.set("q-001", [
      makeParticipant({
        id: "p-1",
        last_heartbeat_at: new Date(NOW - 90_000).toISOString(),
      }),
    ]);

    const { result } = renderHook(() => usePresence("q-001"));

    await waitFor(() => {
      expect(result.current.get("role-medical")?.bucket).toBe("stale");
    });

    // Heartbeat refresh — should flip back to fresh.
    act(() => {
      capturedHandlers.get("q-001")!({
        type: "UPDATE",
        participant: makeParticipant({
          id: "p-1",
          last_heartbeat_at: new Date(NOW).toISOString(),
        }),
      });
    });

    expect(result.current.get("role-medical")?.bucket).toBe("fresh");
  });

  it("removes presence on DELETE events", async () => {
    mockInitialParticipants.set("q-001", [makeParticipant({ id: "p-1" })]);

    const { result } = renderHook(() => usePresence("q-001"));

    await waitFor(() => {
      expect(result.current.get("role-medical")?.participantCount).toBe(1);
    });

    act(() => {
      capturedHandlers.get("q-001")!({
        type: "DELETE",
        participant: null,
        deletedId: "p-1",
      });
    });

    expect(result.current.get("role-medical")).toBeUndefined();
  });

  it("decays fresh → stale → offline as wall-clock time advances (simulated)", async () => {
    // Seed a participant whose heartbeat is at NOW.
    mockInitialParticipants.set("q-001", [makeParticipant({ id: "p-1" })]);

    const { result } = renderHook(() => usePresence("q-001"));

    await waitFor(() => {
      expect(result.current.get("role-medical")?.bucket).toBe("fresh");
    });

    // Simulate 65s of wall-clock by advancing the system clock and triggering
    // a recompute (we use a no-op UPDATE on the same participant to flush —
    // this matches what would happen in production when ANY participant's row
    // updates, plus the 15s decay tick runs on real timers when it elapses).
    vi.setSystemTime(NOW + 65_000);
    act(() => {
      capturedHandlers.get("q-001")!({
        type: "UPDATE",
        participant: makeParticipant({
          id: "p-1",
          // heartbeat_at unchanged — still at NOW — so 65s old now.
          last_heartbeat_at: new Date(NOW).toISOString(),
        }),
      });
    });
    expect(result.current.get("role-medical")?.bucket).toBe("stale");

    vi.setSystemTime(NOW + 125_000);
    act(() => {
      capturedHandlers.get("q-001")!({
        type: "UPDATE",
        participant: makeParticipant({
          id: "p-1",
          last_heartbeat_at: new Date(NOW).toISOString(),
        }),
      });
    });
    expect(result.current.get("role-medical")).toBeUndefined();
  });

  it("re-subscribes (and unsubscribes the old quorum) when quorumId changes", async () => {
    const { rerender } = renderHook(({ qid }) => usePresence(qid), {
      initialProps: { qid: "q-001" },
    });

    await waitFor(() => expect(capturedHandlers.has("q-001")).toBe(true));
    expect(mockSubscribeToParticipants).toHaveBeenCalledWith(
      "q-001",
      expect.any(Function),
    );

    rerender({ qid: "q-002" });

    await waitFor(() => expect(capturedHandlers.has("q-002")).toBe(true));
    expect(unsubCalls).toContain("q-001");
  });

  it("does not subscribe twice for the same quorumId on re-render", async () => {
    const { rerender } = renderHook(({ qid }) => usePresence(qid), {
      initialProps: { qid: "q-001" },
    });
    await waitFor(() => expect(capturedHandlers.has("q-001")).toBe(true));

    const firstCallCount = mockSubscribeToParticipants.mock.calls.length;
    rerender({ qid: "q-001" });
    expect(mockSubscribeToParticipants.mock.calls.length).toBe(firstCallCount);
  });

  it("clears interval and unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => usePresence("q-001"));
    await waitFor(() => expect(capturedHandlers.has("q-001")).toBe(true));

    unmount();
    expect(unsubCalls).toContain("q-001");
  });

  it("survives getParticipants rejecting (Supabase unavailable)", async () => {
    mockGetParticipants.mockRejectedValueOnce(new Error("supabase down"));
    const { result } = renderHook(() => usePresence("q-001"));
    // No throw, empty map. The subscribe still fires.
    await waitFor(() => expect(capturedHandlers.has("q-001")).toBe(true));
    expect(result.current.size).toBe(0);
  });
});
