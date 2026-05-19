/**
 * Tests for useQuorumLive — A2A events integration.
 *
 * Covers the change introduced by the A2A Visibility feature: the hook should
 * fetch the initial set of agent_requests for the quorum and update its
 * `a2aEvents` array when realtime INSERTs land.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { AgentRequest } from "@quorum/types";

// ---------------------------------------------------------------------------
// Mocks — dataProvider (getA2ARequests, subscribeToQuorumA2ARequests)
// ---------------------------------------------------------------------------

let capturedHandler:
  | ((req: AgentRequest, event: "INSERT" | "UPDATE") => void)
  | null = null;

const mockGetA2ARequests = vi.fn(async (...args: unknown[]) => {
  void args;
  return [] as AgentRequest[];
});

const mockSubscribe = vi.fn(
  (
    _quorumId: string,
    handler: (req: AgentRequest, event: "INSERT" | "UPDATE") => void
  ) => {
    void _quorumId;
    capturedHandler = handler;
    return () => {
      capturedHandler = null;
    };
  }
);

vi.mock("@/lib/dataProvider", () => ({
  getA2ARequests: (...args: unknown[]) =>
    mockGetA2ARequests(...(args as [string])),
  subscribeToQuorumA2ARequests: (...args: unknown[]) =>
    mockSubscribe(
      ...(args as [
        string,
        (req: AgentRequest, ev: "INSERT" | "UPDATE") => void,
      ])
    ),
}));

// The hook also imports @/lib/supabase inside its production path. We stub
// it with a chain that resolves to empty data so the effect body completes
// without errors. Realtime channels are no-ops in this test.
vi.mock("@/lib/supabase", () => {
  const noopChain = {
    select: () => noopChain,
    eq: () => noopChain,
    order: () => Promise.resolve({ data: [], error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    limit: () => Promise.resolve({ data: [], error: null }),
  };
  return {
    supabase: {
      from: () => noopChain,
      channel: () => ({
        on: function on() {
          return this;
        },
        subscribe: function subscribe() {
          return this;
        },
      }),
      removeChannel: () => {},
    },
  };
});

// Ensure we hit the production branch (not the mockStream branch).
const ORIGINAL_TEST_MODE = process.env.NEXT_PUBLIC_QUORUM_TEST_MODE;
process.env.NEXT_PUBLIC_QUORUM_TEST_MODE = "false";

// Import after the env is set so isTestMode() inside the hook reads false.
// (Top-level imports run in source order, so this static import will resolve
// before the test body — but Vitest still hoists vi.mock calls; the env read
// happens inside the hook on render, so this works either way.)
// eslint-disable-next-line import/first
import { useQuorumLive } from "../useQuorumLive";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    id: "a2a-test-001",
    quorum_id: "q-test",
    from_role_id: "role-safety",
    to_role_id: "role-irb",
    request_type: "conflict_flag",
    content: "Sample size assumption conflicts with safety target",
    tags: ["statistics"],
    status: "pending",
    priority: 2,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useQuorumLive — a2aEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = null;
    mockGetA2ARequests.mockImplementation(async () => []);
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_QUORUM_TEST_MODE = ORIGINAL_TEST_MODE;
  });

  it("starts with empty a2aEvents", () => {
    const { result } = renderHook(() => useQuorumLive("q-test"));
    expect(result.current.a2aEvents).toEqual([]);
  });

  it("seeds a2aEvents from getA2ARequests on mount", async () => {
    const seeded = [
      makeAgentRequest({ id: "seed-1" }),
      makeAgentRequest({ id: "seed-2", status: "resolved" }),
    ];
    mockGetA2ARequests.mockResolvedValueOnce(seeded);

    const { result } = renderHook(() => useQuorumLive("q-test"));

    await waitFor(() => {
      expect(result.current.a2aEvents).toHaveLength(2);
    });
    expect(result.current.a2aEvents.map((e) => e.id)).toEqual([
      "seed-1",
      "seed-2",
    ]);
  });

  it("appends a new A2A event when a realtime INSERT lands", async () => {
    const { result } = renderHook(() => useQuorumLive("q-test"));

    await waitFor(() => expect(capturedHandler).not.toBeNull());

    const incoming = makeAgentRequest({ id: "live-1", content: "live ping" });
    act(() => {
      capturedHandler!(incoming, "INSERT");
    });

    expect(result.current.a2aEvents).toHaveLength(1);
    expect(result.current.a2aEvents[0]).toMatchObject({
      id: "live-1",
      content: "live ping",
    });
  });

  it("merges UPDATE events into the existing row (status transition)", async () => {
    const initial = makeAgentRequest({ id: "merge-1", status: "pending" });
    mockGetA2ARequests.mockResolvedValueOnce([initial]);

    const { result } = renderHook(() => useQuorumLive("q-test"));

    await waitFor(() => expect(result.current.a2aEvents).toHaveLength(1));
    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      capturedHandler!(
        { ...initial, status: "resolved", response: "ack" },
        "UPDATE"
      );
    });

    expect(result.current.a2aEvents).toHaveLength(1);
    expect(result.current.a2aEvents[0].status).toBe("resolved");
    expect(result.current.a2aEvents[0].response).toBe("ack");
  });
});

// `afterAll` lives in vitest's globals via setup, but importing here keeps the
// reference explicit for the env-reset hook above.
// eslint-disable-next-line import/first
import { afterAll } from "vitest";
