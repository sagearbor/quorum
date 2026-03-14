"use client";

/**
 * useStationConversation — manages per-station conversation state.
 *
 * Handles:
 * - Loading historical messages from Supabase (or empty in demo mode)
 * - Subscribing to new messages via Supabase Realtime
 * - Sending a message via askFacilitator (direct question) or
 *   surfacing the facilitator_reply from a /contribute response
 * - Tracking loading/sending states and the latest facilitator reply
 */

import { useEffect, useState, useRef, useCallback } from "react";
import type { StationMessage } from "@quorum/types";
import {
  getStationMessages,
  askFacilitator,
  subscribeToStationMessages,
  type FacilitatorReply,
} from "@/lib/dataProvider";

export interface StationConversationState {
  messages: StationMessage[];
  loading: boolean;
  sending: boolean;
  /** The most recent facilitator reply — clears after it has been consumed by AvatarPanel. */
  facilitatorReply: FacilitatorReply | null;
  sendMessage: (content: string) => Promise<void>;
  /** Called externally when a /contribute response includes a facilitator_reply. */
  ingestFacilitatorReply: (reply: FacilitatorReply) => void;
  clearFacilitatorReply: () => void;
}

export function useStationConversation(
  quorumId: string,
  stationId: string,
  roleId: string
): StationConversationState {
  const [messages, setMessages] = useState<StationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [facilitatorReply, setFacilitatorReply] = useState<FacilitatorReply | null>(null);

  // Keep a stable ref to avoid stale-closure issues in subscription callback
  const quorumIdRef = useRef(quorumId);
  const stationIdRef = useRef(stationId);
  quorumIdRef.current = quorumId;
  stationIdRef.current = stationId;

  // Load historical messages on mount / when station changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getStationMessages(quorumId, stationId)
      .then((msgs) => {
        if (!cancelled) {
          setMessages(msgs);
        }
      })
      .catch(() => {
        // Non-fatal: start with empty thread
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [quorumId, stationId]);

  // Subscribe to realtime inserts for this station
  useEffect(() => {
    const unsub = subscribeToStationMessages(quorumId, stationId, (msg) => {
      setMessages((prev) => {
        // Deduplicate — Supabase realtime can fire after an optimistic insert
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    return unsub;
  }, [quorumId, stationId]);

  /**
   * Post an optimistic user message then call askFacilitator, appending the
   * assistant reply to the thread and exposing it via facilitatorReply for
   * the AvatarPanel to speak.
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      const optimisticMsg: StationMessage = {
        id: `optimistic-${Date.now()}`,
        quorum_id: quorumId,
        role_id: roleId,
        station_id: stationId,
        role: "user",
        content,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, optimisticMsg]);
      setSending(true);

      try {
        const reply = await askFacilitator(quorumId, stationId, roleId, content);

        // Append the assistant reply to the thread
        const assistantMsg: StationMessage = {
          id: reply.message_id,
          quorum_id: quorumId,
          role_id: roleId,
          station_id: stationId,
          role: "assistant",
          content: reply.reply,
          tags: reply.tags,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setFacilitatorReply(reply);
      } catch {
        // Remove the optimistic message on failure and re-throw so the
        // component can surface an error state to the user
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
        throw new Error("Failed to reach facilitator. Please try again.");
      } finally {
        setSending(false);
      }
    },
    [quorumId, stationId, roleId]
  );

  /**
   * Called when a /contribute response includes a facilitator_reply so the
   * QuorumPage can keep the AvatarPanel in sync without the user explicitly
   * asking a question.
   */
  const ingestFacilitatorReply = useCallback((reply: FacilitatorReply) => {
    setFacilitatorReply(reply);

    // Also append the assistant message to the visible thread
    const assistantMsg: StationMessage = {
      id: reply.message_id,
      quorum_id: quorumId,
      role_id: roleId,
      station_id: stationId,
      role: "assistant",
      content: reply.reply,
      tags: reply.tags,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => {
      if (prev.some((m) => m.id === assistantMsg.id)) return prev;
      return [...prev, assistantMsg];
    });
  }, [quorumId, roleId, stationId]);

  const clearFacilitatorReply = useCallback(() => {
    setFacilitatorReply(null);
  }, []);

  return {
    messages,
    loading,
    sending,
    facilitatorReply,
    sendMessage,
    ingestFacilitatorReply,
    clearFacilitatorReply,
  };
}
