"use client";

/**
 * ConversationThread — chat bubble UI for a per-station facilitator conversation.
 *
 * Layout:
 * - User messages aligned right (blue bubble) with role name prepended
 * - Assistant/system messages aligned left (gray bubble) with "AI {role} [model]" label + tag pills
 * - Typing indicator while sending
 * - Input field pinned to bottom
 * - Auto-scrolls to latest message on new insertions
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { StationMessage } from "@quorum/types";

export interface ConversationThreadProps {
  quorumId: string;
  stationId: string;
  roleId: string;
  messages: StationMessage[];
  loading: boolean;
  sending: boolean;
  /** Called when the user submits a new message. */
  onSend: (content: string) => Promise<void>;
  /** Human participant's role name, shown as prefix on user messages. */
  roleName?: string;
  /** Avatar/AI role name, shown as "AI {avatarRoleName}" on assistant messages. */
  avatarRoleName?: string;
  /** LLM model currently in use — shown as a small badge on assistant messages. */
  currentModel?: string;
}

export function ConversationThread({
  messages,
  loading,
  sending,
  onSend,
  roleName,
  avatarRoleName,
  currentModel,
}: ConversationThreadProps) {
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to newest message whenever the list grows.
  // scrollIntoView is not available in jsdom — guard so tests don't throw.
  useEffect(() => {
    if (bottomRef.current && typeof bottomRef.current.scrollIntoView === "function") {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, sending]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;

    setDraft("");
    setSendError(null);

    try {
      await onSend(content);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed. Please retry.");
    }
  };

  // Allow Shift+Enter for newlines, Enter alone to submit
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e as unknown as FormEvent);
    }
  };

  if (loading) {
    return (
      <div
        className="flex flex-col h-full animate-pulse"
        data-testid="conversation-loading"
      >
        <div className="flex-1 space-y-3 p-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className={`h-10 rounded-2xl bg-gray-200 ${
                i % 2 === 0 ? "ml-8" : "mr-8"
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="conversation-thread">
      {/* Message list — scrollable */}
      <div
        className="flex-1 overflow-y-auto space-y-3 p-3 min-h-0"
        data-testid="conversation-messages"
      >
        {messages.length === 0 && (
          <p
            className="text-center text-xs text-gray-400 py-6"
            data-testid="conversation-empty"
          >
            Ask the facilitator a question about this quorum.
          </p>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === "user";
          const isSystem = msg.role === "system";

          if (isSystem) {
            // A2A and system notifications are styled as prominent amber banners
            // so they stand out from regular conversation bubbles.
            const isA2A = msg.id.startsWith("a2a-");
            return (
              <div
                key={msg.id}
                className="flex justify-center"
                data-testid={`msg-${msg.id}`}
              >
                <div
                  className={`max-w-[90%] flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                    isA2A
                      ? "bg-amber-50 border border-amber-200 text-amber-800"
                      : "bg-gray-100 text-gray-500 rounded-full"
                  }`}
                >
                  {isA2A && (
                    /* Agent activity icon */
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="flex-shrink-0 mt-0.5 text-amber-500"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  )}
                  <span>{msg.content}</span>
                </div>
              </div>
            );
          }

          // Derive the sender label shown above the bubble.
          // User messages show the human's role name; assistant messages show
          // "AI {role}" with an optional model badge.
          const senderLabel = isUser
            ? (roleName ?? null)
            : (avatarRoleName ?? roleName)
              ? `AI ${avatarRoleName ?? roleName}`
              : "AI Facilitator";

          return (
            <div
              key={msg.id}
              className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
              data-testid={`msg-${msg.id}`}
            >
              {/* Sender label row */}
              {senderLabel && (
                <div className={`flex items-center gap-1.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
                  <span
                    className="text-[11px] font-semibold text-gray-600"
                    data-testid={isUser ? `msg-user-label-${msg.id}` : `msg-ai-label-${msg.id}`}
                  >
                    {senderLabel}
                  </span>
                  {/* Model badge — only on assistant messages when model is known */}
                  {!isUser && currentModel && (
                    <span
                      className="text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded font-mono"
                      data-testid={`msg-model-badge-${msg.id}`}
                    >
                      [{currentModel}]
                    </span>
                  )}
                </div>
              )}

              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  isUser
                    ? "bg-indigo-600 text-white rounded-br-sm"
                    : "bg-gray-100 text-gray-800 rounded-bl-sm"
                }`}
              >
                {msg.content}
              </div>

              {/* Tag pills for assistant messages */}
              {!isUser && msg.tags && msg.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 max-w-[85%]" data-testid={`msg-tags-${msg.id}`}>
                  {msg.tags.slice(0, 5).map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded-full"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <span className="text-[10px] text-gray-400">
                {new Date(msg.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          );
        })}

        {/* Typing indicator */}
        {sending && (
          <div
            className="flex items-start"
            data-testid="conversation-typing"
          >
            <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Error banner */}
      {sendError && (
        <div
          className="mx-3 mb-1 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg"
          data-testid="conversation-error"
        >
          {sendError}
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-gray-200 p-3 flex gap-2 items-end"
        data-testid="conversation-form"
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          rows={1}
          placeholder="Ask the facilitator…"
          className="flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
          data-testid="conversation-input"
          style={{ minHeight: "40px", maxHeight: "120px" }}
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="flex-shrink-0 w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="conversation-send"
          aria-label="Send message"
        >
          {/* Send arrow icon */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </div>
  );
}
