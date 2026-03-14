"use client";

/**
 * useA2ARequests — subscribes to incoming A2A (agent-to-agent) requests for the
 * current station's role and surfaces them as dismissible notifications.
 *
 * Design:
 * - Inserts a "system" banner message into the conversation thread so the human
 *   sees what the other agents are flagging.
 * - Keeps a local list of notifications (newest-first) for the A2A badge count.
 * - Only fires when a live Supabase backend is connected (no-op in demo mode).
 */

import { useEffect, useState, useCallback } from "react";
import type { AgentRequest } from "@quorum/types";
import { subscribeToA2ARequests } from "@/lib/dataProvider";

export interface A2ANotification {
  id: string;
  request: AgentRequest;
  /** Human-readable summary of what the other agent is flagging. */
  summary: string;
  dismissed: boolean;
  receivedAt: string;
}

export interface A2ARequestsState {
  /** All received notifications (newest first), including dismissed ones. */
  notifications: A2ANotification[];
  /** Count of undismissed notifications. */
  pendingCount: number;
  /** Dismiss a notification by request ID. */
  dismiss: (requestId: string) => void;
  /** Clear all dismissed notifications. */
  clearDismissed: () => void;
}

/** Maps request_type to a human-readable description for display in the UI. */
function formatA2ANotification(request: AgentRequest): string {
  const fromRole = request.from_role_id; // Will be enriched to role name by backend in future
  switch (request.request_type) {
    case "conflict_flag":
      return `Conflict flagged by ${fromRole}: ${request.content}`;
    case "input_request":
      return `${fromRole} is requesting your input: ${request.content}`;
    case "review_request":
      return `${fromRole} requests your review: ${request.content}`;
    case "doc_edit_notify":
      return `${fromRole} has edited a document you're tracking: ${request.content}`;
    case "escalation":
      return `ESCALATION from ${fromRole}: ${request.content}`;
    case "negotiation":
      return `Negotiation request from ${fromRole}: ${request.content}`;
    default:
      return `Message from ${fromRole}: ${request.content}`;
  }
}

export function useA2ARequests(
  quorumId: string,
  roleId: string
): A2ARequestsState {
  const [notifications, setNotifications] = useState<A2ANotification[]>([]);

  // Subscribe to incoming A2A requests whenever both quorumId and roleId are available
  useEffect(() => {
    // Don't subscribe without a valid role
    if (!quorumId || !roleId) return;

    const unsub = subscribeToA2ARequests(quorumId, roleId, (request) => {
      const notification: A2ANotification = {
        id: request.id,
        request,
        summary: formatA2ANotification(request),
        dismissed: false,
        receivedAt: new Date().toISOString(),
      };

      setNotifications((prev) => {
        // Deduplicate: ignore if we already have this request ID
        if (prev.some((n) => n.id === notification.id)) return prev;
        // Prepend newest first
        return [notification, ...prev];
      });
    });

    return unsub;
  }, [quorumId, roleId]);

  const dismiss = useCallback((requestId: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === requestId ? { ...n, dismissed: true } : n))
    );
  }, []);

  const clearDismissed = useCallback(() => {
    setNotifications((prev) => prev.filter((n) => !n.dismissed));
  }, []);

  const pendingCount = notifications.filter((n) => !n.dismissed).length;

  return {
    notifications,
    pendingCount,
    dismiss,
    clearDismissed,
  };
}
