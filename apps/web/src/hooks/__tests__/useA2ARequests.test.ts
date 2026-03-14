/**
 * Tests for useA2ARequests
 *
 * Covers:
 * - Initial empty state
 * - Receiving an incoming A2A request → notification appears
 * - Dismissing a notification → pending count decrements
 * - Deduplication of same request ID
 * - clearDismissed removes dismissed entries
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useA2ARequests } from "../useA2ARequests";
import type { AgentRequest } from "@quorum/types";

// ---------------------------------------------------------------------------
// Mock dataProvider
// ---------------------------------------------------------------------------

let capturedHandler: ((req: AgentRequest) => void) | null = null;

const mockSubscribeToA2ARequests = vi.fn(
  (_quorumId: string, _roleId: string, handler: (req: AgentRequest) => void) => {
    capturedHandler = handler;
    return () => { capturedHandler = null; };
  }
);

vi.mock("@/lib/dataProvider", () => ({
  subscribeToA2ARequests: (...args: unknown[]) =>
    mockSubscribeToA2ARequests(...(args as [string, string, (req: AgentRequest) => void])),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    id: "req-001",
    quorum_id: "q-001",
    from_role_id: "role-safety",
    to_role_id: "role-irb",
    request_type: "conflict_flag",
    content: "Safety data conflicts with IRB timeline",
    tags: ["safety", "timeline"],
    status: "pending",
    priority: 3,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useA2ARequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = null;
  });

  it("starts with empty notifications and zero pending count", () => {
    const { result } = renderHook(() =>
      useA2ARequests("q-001", "role-irb")
    );

    expect(result.current.notifications).toHaveLength(0);
    expect(result.current.pendingCount).toBe(0);
  });

  it("does not subscribe when roleId is empty", () => {
    renderHook(() => useA2ARequests("q-001", ""));

    expect(mockSubscribeToA2ARequests).not.toHaveBeenCalled();
  });

  it("subscribes with correct quorumId and roleId", async () => {
    renderHook(() => useA2ARequests("q-001", "role-irb"));

    await waitFor(() => {
      expect(mockSubscribeToA2ARequests).toHaveBeenCalledWith(
        "q-001",
        "role-irb",
        expect.any(Function)
      );
    });
  });

  it("adds notification when A2A request arrives", async () => {
    const { result } = renderHook(() =>
      useA2ARequests("q-001", "role-irb")
    );

    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      capturedHandler!(makeRequest());
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.pendingCount).toBe(1);
    expect(result.current.notifications[0].dismissed).toBe(false);
    expect(result.current.notifications[0].summary).toContain("Conflict flagged");
  });

  it("deduplicates requests with the same ID", async () => {
    const { result } = renderHook(() =>
      useA2ARequests("q-001", "role-irb")
    );

    await waitFor(() => expect(capturedHandler).not.toBeNull());

    const req = makeRequest({ id: "dup-001" });

    act(() => {
      capturedHandler!(req);
      capturedHandler!(req);
    });

    expect(result.current.notifications).toHaveLength(1);
  });

  it("dismiss sets the notification dismissed flag and decrements pending count", async () => {
    const { result } = renderHook(() =>
      useA2ARequests("q-001", "role-irb")
    );

    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      capturedHandler!(makeRequest({ id: "req-dismiss-01" }));
    });

    expect(result.current.pendingCount).toBe(1);

    act(() => {
      result.current.dismiss("req-dismiss-01");
    });

    expect(result.current.pendingCount).toBe(0);
    expect(result.current.notifications[0].dismissed).toBe(true);
  });

  it("clearDismissed removes dismissed notifications from the list", async () => {
    const { result } = renderHook(() =>
      useA2ARequests("q-001", "role-irb")
    );

    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      capturedHandler!(makeRequest({ id: "req-a" }));
      capturedHandler!(makeRequest({ id: "req-b" }));
    });

    act(() => {
      result.current.dismiss("req-a");
    });

    expect(result.current.notifications).toHaveLength(2);

    act(() => {
      result.current.clearDismissed();
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].id).toBe("req-b");
  });

  it("formats different request types correctly in summary", async () => {
    const { result } = renderHook(() =>
      useA2ARequests("q-001", "role-irb")
    );

    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      capturedHandler!(makeRequest({ id: "r1", request_type: "input_request" }));
      capturedHandler!(makeRequest({ id: "r2", request_type: "review_request" }));
      capturedHandler!(makeRequest({ id: "r3", request_type: "escalation" }));
    });

    // Notifications are prepended newest-first, but we search by content rather
    // than position so the test is order-independent.
    const summaries = result.current.notifications.map((n) => n.summary);
    expect(summaries.some((s) => /requesting your input/i.test(s))).toBe(true);
    expect(summaries.some((s) => /requests your review/i.test(s))).toBe(true);
    expect(summaries.some((s) => /escalation/i.test(s))).toBe(true);
  });

  it("newest notifications appear first", async () => {
    const { result } = renderHook(() =>
      useA2ARequests("q-001", "role-irb")
    );

    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      capturedHandler!(makeRequest({ id: "first" }));
    });

    act(() => {
      capturedHandler!(makeRequest({ id: "second" }));
    });

    // Notifications prepend newest first
    expect(result.current.notifications[0].id).toBe("second");
    expect(result.current.notifications[1].id).toBe("first");
  });
});
