/**
 * Tests for useStationConversation
 *
 * Covers:
 * - Loading state lifecycle
 * - ingestFacilitatorReply: appends assistant message and sets facilitatorReply
 * - sendMessage: optimistic insert + assistant reply append
 * - sendMessage failure: removes optimistic message and re-throws
 * - Realtime subscription deduplication
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useStationConversation } from "../useStationConversation";

// ---------------------------------------------------------------------------
// Mock dataProvider
// ---------------------------------------------------------------------------

const mockGetStationMessages = vi.fn();
const mockAskFacilitator = vi.fn();
const mockSubscribeToStationMessages = vi.fn();

vi.mock("@/lib/dataProvider", () => ({
  getStationMessages: (...args: unknown[]) => mockGetStationMessages(...args),
  askFacilitator: (...args: unknown[]) => mockAskFacilitator(...args),
  subscribeToStationMessages: (...args: unknown[]) =>
    mockSubscribeToStationMessages(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const Q_ID = "q-test-001";
const S_ID = "station-1";
const R_ID = "role-irb-001";

function setupHook() {
  return renderHook(() => useStationConversation(Q_ID, S_ID, R_ID));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useStationConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty history, no-op subscription
    mockGetStationMessages.mockResolvedValue([]);
    mockSubscribeToStationMessages.mockReturnValue(() => {});
  });

  it("starts in loading state and resolves to loaded with empty messages", async () => {
    const { result } = setupHook();

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it("loads historical messages from getStationMessages", async () => {
    const historical = [
      {
        id: "h-1",
        quorum_id: Q_ID,
        role_id: R_ID,
        station_id: S_ID,
        role: "user" as const,
        content: "Historical message",
        created_at: "2026-03-14T10:00:00Z",
      },
    ];
    mockGetStationMessages.mockResolvedValue(historical);

    const { result } = setupHook();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("Historical message");
  });

  it("ingestFacilitatorReply appends assistant message to thread", async () => {
    const { result } = setupHook();

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.ingestFacilitatorReply({
        reply: "The enrollment target is 240 patients.",
        message_id: "msg-001",
        tags: ["enrollment"],
      });
    });

    expect(result.current.messages).toHaveLength(1);
    const msg = result.current.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("The enrollment target is 240 patients.");
    expect(msg.tags).toEqual(["enrollment"]);
  });

  it("ingestFacilitatorReply sets facilitatorReply state", async () => {
    const { result } = setupHook();

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.ingestFacilitatorReply({
        reply: "Safety data looks good.",
        message_id: "msg-002",
        tags: ["safety"],
      });
    });

    expect(result.current.facilitatorReply).toEqual({
      reply: "Safety data looks good.",
      message_id: "msg-002",
      tags: ["safety"],
    });
  });

  it("ingestFacilitatorReply deduplicates by message_id", async () => {
    const { result } = setupHook();

    await waitFor(() => expect(result.current.loading).toBe(false));

    const reply = { reply: "Only once.", message_id: "msg-003", tags: [] };

    act(() => {
      result.current.ingestFacilitatorReply(reply);
      result.current.ingestFacilitatorReply(reply);
    });

    expect(result.current.messages).toHaveLength(1);
  });

  it("sendMessage adds optimistic user message then appends assistant reply", async () => {
    mockAskFacilitator.mockResolvedValue({
      reply: "Facilitator response here.",
      message_id: "msg-ask-001",
      tags: ["test"],
    });

    const { result } = setupHook();

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage("What is the eGFR threshold?");
    });

    // Should have: optimistic user message + assistant reply = 2
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("What is the eGFR threshold?");
    expect(result.current.messages[1].role).toBe("assistant");
    expect(result.current.messages[1].content).toBe("Facilitator response here.");
  });

  it("sendMessage removes optimistic message on failure and re-throws", async () => {
    mockAskFacilitator.mockRejectedValue(new Error("Network error"));

    const { result } = setupHook();

    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.sendMessage("Test message");
      })
    ).rejects.toThrow("Failed to reach facilitator");

    // Optimistic message should be rolled back
    expect(result.current.messages).toHaveLength(0);
  });

  it("clearFacilitatorReply resets facilitatorReply to null", async () => {
    const { result } = setupHook();

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.ingestFacilitatorReply({
        reply: "Test reply",
        message_id: "msg-clear-001",
        tags: [],
      });
    });

    expect(result.current.facilitatorReply).not.toBeNull();

    act(() => {
      result.current.clearFacilitatorReply();
    });

    expect(result.current.facilitatorReply).toBeNull();
  });

  it("subscribes to station messages with correct quorum and station IDs", async () => {
    setupHook();

    await waitFor(() => {
      expect(mockSubscribeToStationMessages).toHaveBeenCalledWith(
        Q_ID,
        S_ID,
        expect.any(Function)
      );
    });
  });

  it("sends message with empty string — does nothing", async () => {
    const { result } = setupHook();

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage("   ");
    });

    expect(mockAskFacilitator).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
  });
});
