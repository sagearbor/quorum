import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationThread } from "./ConversationThread";
import type { StationMessage } from "@quorum/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseProps = {
  quorumId: "q-001",
  stationId: "station-1",
  roleId: "role-irb",
};

function makeMessage(
  overrides: Partial<StationMessage> & { id: string }
): StationMessage {
  return {
    quorum_id: "q-001",
    role_id: "role-irb",
    station_id: "station-1",
    role: "user",
    content: "Test message",
    created_at: "2026-03-14T10:00:00Z",
    ...overrides,
  };
}

const userMsg = makeMessage({
  id: "msg-1",
  role: "user",
  content: "What is the enrollment target?",
});

const assistantMsg = makeMessage({
  id: "msg-2",
  role: "assistant",
  content: "The enrollment target is 240 patients across 6 sites.",
  tags: ["enrollment", "sites"],
});

const systemMsg = makeMessage({
  id: "msg-3",
  role: "system",
  content: "Session started",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationThread", () => {
  const noop = async () => {};

  it("renders empty state when no messages", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    expect(screen.getByTestId("conversation-empty")).toBeInTheDocument();
    expect(
      screen.getByText(/ask the facilitator a question/i)
    ).toBeInTheDocument();
  });

  it("renders loading skeleton", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={true}
        sending={false}
        onSend={noop}
      />
    );

    expect(screen.getByTestId("conversation-loading")).toBeInTheDocument();
    // Should not render the message list or input while loading
    expect(screen.queryByTestId("conversation-messages")).not.toBeInTheDocument();
  });

  it("renders user messages aligned right", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[userMsg]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    const msgEl = screen.getByTestId(`msg-${userMsg.id}`);
    expect(msgEl).toBeInTheDocument();
    expect(msgEl).toHaveClass("items-end");
    // User bubble should have indigo background
    expect(msgEl.querySelector(".bg-indigo-600")).toBeInTheDocument();
  });

  it("renders assistant messages aligned left with tags", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[assistantMsg]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    const msgEl = screen.getByTestId(`msg-${assistantMsg.id}`);
    expect(msgEl).toHaveClass("items-start");
    expect(msgEl.querySelector(".bg-gray-100")).toBeInTheDocument();

    // Tags should be rendered
    const tagContainer = screen.getByTestId(`msg-tags-${assistantMsg.id}`);
    expect(tagContainer).toBeInTheDocument();
    expect(screen.getByText("enrollment")).toBeInTheDocument();
    expect(screen.getByText("sites")).toBeInTheDocument();
  });

  it("renders system messages as centered pills", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[systemMsg]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    const msgEl = screen.getByTestId(`msg-${systemMsg.id}`);
    expect(msgEl).toHaveClass("justify-center");
    expect(screen.getByText("Session started")).toBeInTheDocument();
  });

  it("renders multiple messages in order", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[userMsg, assistantMsg]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    expect(screen.getByTestId(`msg-${userMsg.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`msg-${assistantMsg.id}`)).toBeInTheDocument();
    expect(
      screen.getByText("What is the enrollment target?")
    ).toBeInTheDocument();
    expect(
      screen.getByText("The enrollment target is 240 patients across 6 sites.")
    ).toBeInTheDocument();
  });

  it("shows typing indicator when sending", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[userMsg]}
        loading={false}
        sending={true}
        onSend={noop}
      />
    );

    expect(screen.getByTestId("conversation-typing")).toBeInTheDocument();
  });

  it("hides typing indicator when not sending", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[userMsg]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    expect(screen.queryByTestId("conversation-typing")).not.toBeInTheDocument();
  });

  it("disables send button when input is empty", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    const sendBtn = screen.getByTestId("conversation-send");
    expect(sendBtn).toBeDisabled();
  });

  it("enables send button when input has text", async () => {
    const user = userEvent.setup();
    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    const input = screen.getByTestId("conversation-input");
    await user.type(input, "Hello facilitator");

    const sendBtn = screen.getByTestId("conversation-send");
    expect(sendBtn).not.toBeDisabled();
  });

  it("calls onSend with input content on form submit", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={false}
        sending={false}
        onSend={onSend}
      />
    );

    const input = screen.getByTestId("conversation-input");
    await user.type(input, "What are the inclusion criteria?");
    await user.click(screen.getByTestId("conversation-send"));

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("What are the inclusion criteria?");
  });

  it("clears input after send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={false}
        sending={false}
        onSend={onSend}
      />
    );

    const input = screen.getByTestId("conversation-input") as HTMLTextAreaElement;
    await user.type(input, "Question here");
    await user.click(screen.getByTestId("conversation-send"));

    expect(input.value).toBe("");
  });

  it("shows error message when onSend rejects", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockRejectedValue(new Error("Network error"));

    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={false}
        sending={false}
        onSend={onSend}
      />
    );

    const input = screen.getByTestId("conversation-input");
    await user.type(input, "Test message");
    await user.click(screen.getByTestId("conversation-send"));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-error")).toBeInTheDocument();
    });
    expect(screen.getByText("Network error")).toBeInTheDocument();
  });

  it("disables input while sending", () => {
    render(
      <ConversationThread
        {...baseProps}
        messages={[]}
        loading={false}
        sending={true}
        onSend={noop}
      />
    );

    const input = screen.getByTestId("conversation-input");
    expect(input).toBeDisabled();
  });

  it("truncates tags to max 5", () => {
    const msgWithManyTags = makeMessage({
      id: "msg-many-tags",
      role: "assistant",
      content: "Response with many tags",
      tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7"],
    });

    render(
      <ConversationThread
        {...baseProps}
        messages={[msgWithManyTags]}
        loading={false}
        sending={false}
        onSend={noop}
      />
    );

    // Should show at most 5 tags
    const tagContainer = screen.getByTestId(`msg-tags-${msgWithManyTags.id}`);
    const pills = tagContainer.querySelectorAll("span");
    expect(pills.length).toBeLessThanOrEqual(5);
  });
});
