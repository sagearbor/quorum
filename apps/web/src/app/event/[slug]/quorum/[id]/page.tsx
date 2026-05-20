"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  getQuorum,
  getQuorums,
  getRoles,
  getContributions,
  isDemoMode,
} from "@/lib/dataProvider";
import { enqueue } from "@/lib/offlineQueue";
import type { Role, Contribution, ContributeRequest } from "@quorum/types";
import { AvatarPanel } from "@/components/avatar/AvatarPanel";
import { useShowAvatars } from "@/hooks/useShowAvatars";
import { useAutoPromote } from "@/hooks/useAutoPromote";
import { ConversationThread } from "@/components/conversation/ConversationThread";
import { DocumentPanel } from "@/components/documents/DocumentPanel";
import { useStationConversation } from "@/hooks/useStationConversation";
import { useAgentDocuments } from "@/hooks/useAgentDocuments";
import { useA2ARequests } from "@/hooks/useA2ARequests";
import type { StationMessage } from "@quorum/types";
import { AgentActivityFeed } from "@/components/AgentActivityFeed";
import { A2AActivityTab } from "@/components/A2AActivityTab";
import { BeforeAfterPanel } from "@/components/dashboards/BeforeAfterPanel";
import { PresenceDots } from "@/components/PresenceDots";
import { usePresence } from "@/hooks/usePresence";
import { useQuorumLive } from "@/hooks/useQuorumLive";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tabs shown below the contribution form. */
type PanelTab = "conversation" | "contributions" | "documents" | "a2a" | "resolution";

// ---------------------------------------------------------------------------
// VoiceButton
// ---------------------------------------------------------------------------

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function VoiceButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);

  const toggle = useCallback(() => {
    if (typeof window === "undefined") return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition not supported in this browser");
      return;
    }

    if (listening) {
      setListening(false);
      return;
    }

    const recognition: SpeechRecognitionLike = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      onTranscript(transcript);
      setListening(false);
    };

    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognition.start();
    setListening(true);
  }, [listening, onTranscript]);

  return (
    <button
      type="button"
      onClick={toggle}
      data-testid="voice-button"
      className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        listening
          ? "bg-red-100 text-red-700 animate-pulse"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
      {listening ? "Listening..." : "Voice"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// QuorumPage
// ---------------------------------------------------------------------------

export default function QuorumPage() {
  const params = useParams<{ slug: string; id: string }>();
  const searchParams = useSearchParams();
  const station = searchParams.get("station");
  const participantFromQuery = searchParams.get("participant");
  /**
   * Optional URL param to pre-select a role for this station — lets us hardcode
   * a persona per laptop ("station 1 is the Ethicist, station 2 is the
   * Clinician") without anyone touching a GUI.  Matches either role.id (uuid)
   * or role.name (case-insensitive, URL-encoded).  Falls through if no match.
   */
  const roleParam = searchParams.get("role");

  const quorumId = params.id;
  const slug = params.slug;

  // Derive a stable stationId: use the ?station= param or fall back to a
  // synthetic identifier so the conversation hook always has a valid ID.
  const stationId = station ? `station-${station}` : `station-default`;

  // 10.4 — participant attribution.  On first load, if we have no participant
  // in sessionStorage (laptop occupant arriving fresh), mint one via
  // /sessions/participant (device_kind=laptop).  Then heartbeat every 30s.
  const [participantId, setParticipantId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

    async function ensureParticipant() {
      // 1. If the /pair flow passed ?participant=<id>, store + use it.
      if (participantFromQuery) {
        if (!cancelled) setParticipantId(participantFromQuery);
        try {
          window.sessionStorage.setItem(
            "quorum.participant",
            JSON.stringify({
              participant_id: participantFromQuery,
              quorum_id: quorumId,
              station_label: stationId,
              device_kind: "phone",
            }),
          );
        } catch {
          /* sessionStorage may be unavailable; non-fatal */
        }
        return;
      }

      // 2. Otherwise look in sessionStorage.
      try {
        const raw = window.sessionStorage.getItem("quorum.participant");
        if (raw) {
          const stored = JSON.parse(raw) as { participant_id?: string };
          if (stored.participant_id) {
            if (!cancelled) setParticipantId(stored.participant_id);
            return;
          }
        }
      } catch {
        /* fall through to mint */
      }

      // 3. Mint a laptop participant for the station occupant.
      try {
        const res = await fetch(`${apiBase}/sessions/participant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quorum_id: quorumId,
            station_label: stationId,
            device_kind: "laptop",
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            participant_id: string;
            display_name: string;
          };
          if (!cancelled) setParticipantId(data.participant_id);
          try {
            window.sessionStorage.setItem(
              "quorum.participant",
              JSON.stringify({
                participant_id: data.participant_id,
                display_name: data.display_name,
                quorum_id: quorumId,
                station_label: stationId,
                device_kind: "laptop",
              }),
            );
          } catch {
            /* non-fatal */
          }
        }
      } catch {
        /* network failure — degrade silently, contributions fall back to user_token */
      }
    }

    ensureParticipant();
    return () => {
      cancelled = true;
    };
  }, [quorumId, stationId, participantFromQuery]);

  // Heartbeat every 30s while the participant_id is known.
  useEffect(() => {
    if (!participantId) return;
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

    const ping = () => {
      fetch(`${apiBase}/sessions/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participant_id: participantId }),
      }).catch(() => {
        /* heartbeat is best-effort */
      });
    };
    // Fire once immediately, then on interval.
    ping();
    const handle = window.setInterval(ping, 30_000);
    return () => window.clearInterval(handle);
  }, [participantId]);

  const [quorumTitle, setQuorumTitle] = useState<string>("");
  const [quorumDescription, setQuorumDescription] = useState<string>("");
  /** This quorum's 1-indexed position within its event (used for the "#N" prefix
   *  in the sticky header so visitors can tell sister quorums apart). */
  const [quorumPosition, setQuorumPosition] = useState<number | null>(null);
  /** Quorum status — drives whether the Resolve button is enabled / labeled. */
  const [quorumStatus, setQuorumStatus] = useState<string>("open");
  const [resolving, setResolving] = useState(false);
  const [autonomyLevel, setAutonomyLevel] = useState<number>(0);
  const [showAutonomyControl, setShowAutonomyControl] = useState(false);
  const [showAgentActivity, setShowAgentActivity] = useState(false);
  // Sticky topic header is collapsed by default — only the title + role + dashboard
  // are always visible.  Expanded reveals description, station, autonomy slider.
  const [headerExpanded, setHeaderExpanded] = useState(false);
  // Always-visible row can swap between the short title and a 2-line preview
  // of the long description without forcing the user to expand the accordion.
  const [headerShowDescription, setHeaderShowDescription] = useState(false);
  const [roles, setRoles] = useState<Role[]>([]);
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [currentRole, setCurrentRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Active tab in the bottom panel (defaults to Conversation)
  const [activeTab, setActiveTab] = useState<PanelTab>("conversation");

  // Audio mute — when true, synthesisText is withheld from AvatarPanel so
  // the browser TTS engine does not speak the facilitator reply.
  // Audio (TTS + mic) is OFF by default — small expo room with multiple stations
  // means cross-station audio bleed otherwise. User opts in via the Audio toggle.
  const [audioMuted, setAudioMuted] = useState(true);
  const { showAvatars } = useShowAvatars();
  // Auto-promote toggle — persisted per-browser, mirrored to the
  // ``quorums.auto_promote_chat`` column so process_agent_turn gates on it.
  const { autoPromote, toggleAutoPromote } = useAutoPromote(quorumId);

  // Webcam availability — only enable emotion tracking when a camera is present.
  const [hasWebcam, setHasWebcam] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setHasWebcam(devices.some((d) => d.kind === "videoinput"));
    }).catch(() => {
      setHasWebcam(false);
    });
  }, []);

  // Conversation hook — scoped to this station + current role
  const conversation = useStationConversation(
    quorumId,
    stationId,
    currentRole?.id ?? ""
  );

  // Presence (10.10) — one subscription per quorum, shared across all role buttons.
  const presence = usePresence(quorumId);

  // Agent documents hook
  const { documents, loading: docsLoading } = useAgentDocuments(quorumId);

  // A2A notifications for the current role — shows when other agents flag concerns
  const a2a = useA2ARequests(quorumId, currentRole?.id ?? "");

  // Full A2A event stream for this quorum (every agent-to-agent ping, not
  // only the ones directed at the current role). Powers the A2A Activity tab
  // and chart markers.
  const live = useQuorumLive(quorumId);
  const a2aEvents = live.a2aEvents;

  // Track the timestamp of the newest A2A event the user has already seen so
  // we can render an "unread" counter badge on the A2A tab. Persisted only in
  // memory — resetting on reload is fine; the badge is a recency hint, not a
  // durable inbox.
  const [a2aLastSeen, setA2aLastSeen] = useState<number>(0);
  const a2aUnreadCount = a2aEvents.filter(
    (e) => new Date(e.created_at).getTime() > a2aLastSeen
  ).length;

  // Merge A2A notifications as synthetic "system" messages into the conversation
  // so the human always sees agent-to-agent activity without a separate UI panel.
  // We derive a stable merged array here; ConversationThread deduplicates by id.
  const mergedMessages: StationMessage[] = [
    ...conversation.messages,
    ...a2a.notifications
      .filter((n) => !n.dismissed)
      .map((n): StationMessage => ({
        id: `a2a-${n.id}`,
        quorum_id: quorumId,
        role_id: currentRole?.id ?? "",
        station_id: stationId,
        role: "system",
        content: n.summary,
        created_at: n.receivedAt,
      })),
  ].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // When the user opens the A2A Activity tab, mark all currently-known events
  // as "seen" by snapping a2aLastSeen to now. Suppresses the unread badge.
  useEffect(() => {
    if (activeTab === "a2a") {
      setA2aLastSeen(Date.now());
    }
  }, [activeTab, a2aEvents.length]);

  // Track whether the auto-greet has been sent for this station
  const greetingSentRef = useRef(false);

  // Auto-greet: when the page loads with a role selected (or when the user
  // first selects a role) and the conversation is empty, send a greeting.
  useEffect(() => {
    if (
      !currentRole ||
      greetingSentRef.current ||
      conversation.loading ||
      conversation.messages.length > 0 ||
      loading
    ) {
      return;
    }

    greetingSentRef.current = true;

    const greetingPrompt = `I just arrived at this station as ${currentRole.name}. The quorum topic is: "${quorumTitle}". ${quorumDescription ? `Description: ${quorumDescription}. ` : ""}Please introduce the problem we're working on and what you'd like me to focus on.`;

    const result = conversation.sendMessage(greetingPrompt);
    // Guard: sendMessage may return void in test mocks
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        // Non-fatal — greeting is a nice-to-have
        greetingSentRef.current = false;
      });
    }
  }, [currentRole, conversation.loading, conversation.messages.length, loading, quorumTitle, quorumDescription]); // eslint-disable-line react-hooks/exhaustive-deps

  // When there is a live facilitator reply, derive synthesisText for the avatar.
  // Paused replies have no text and must not be spoken — AvatarPanel shows a
  // status pill instead.
  const facilitatorPaused = conversation.facilitatorReply?.paused === true;
  const facilitatorPausedReason =
    conversation.facilitatorReply?.reason ?? null;
  const synthesisText = facilitatorPaused
    ? undefined
    : conversation.facilitatorReply?.reply ?? undefined;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [quorum, qRoles, qContribs, siblings] = await Promise.all([
        getQuorum(quorumId),
        getRoles(quorumId),
        getContributions(quorumId),
        // Fetch sibling quorums so we can compute this one's 1-indexed position
        // within the event for the "#N · Title" header — slug already in scope.
        getQuorums(slug).catch(() => []),
      ]);
      if (cancelled) return;

      if (quorum) {
        setQuorumTitle(quorum.title);
        setQuorumDescription(quorum.description);
        setAutonomyLevel(quorum.autonomy_level ?? 0);
        setQuorumStatus(quorum.status ?? "open");
      }
      setRoles(qRoles as Role[]);
      setContributions(qContribs as Contribution[]);
      // Sibling list is sorted oldest→newest by the backend; position = index + 1
      if (Array.isArray(siblings) && siblings.length > 0) {
        const idx = siblings.findIndex((s) => s.id === quorumId);
        if (idx >= 0) setQuorumPosition(idx + 1);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [quorumId]);

  const selectRole = (role: Role) => {
    setCurrentRole(role);
    setFieldValues({});
    setSubmitSuccess(false);
  };

  // Auto-select role from ?role=<id-or-name> URL param once roles are loaded.
  // Lets Sophie hardcode "this laptop = this persona" without a GUI step —
  // open 5 different URLs on 5 stations and each lands on its own role.
  useEffect(() => {
    if (currentRole || !roleParam || roles.length === 0) return;
    const want = roleParam.trim().toLowerCase();
    const match = roles.find(
      (r) => r.id.toLowerCase() === want || r.name.toLowerCase() === want,
    );
    if (match) selectRole(match);
  }, [roleParam, roles, currentRole]);

  const handleFieldChange = (fieldName: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldName]: value }));
  };

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (!currentRole) return;
      if ((currentRole.prompt_template ?? []).length > 0) {
        const firstEmptyField = (currentRole.prompt_template ?? []).find(
          (f) => !fieldValues[f.field_name]
        );
        if (firstEmptyField) {
          handleFieldChange(firstEmptyField.field_name, text);
        }
      } else {
        handleFieldChange("contribution", text);
      }
    },
    [currentRole, fieldValues]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRole) return;

    setSubmitting(true);
    setSubmitSuccess(false);

    const content = Object.values(fieldValues).filter(Boolean).join("\n\n");

    // 10.4 — attribute the contribution to the participant (laptop occupant
    // or phone visitor).  We pass participant_id explicitly AND also use it
    // as user_token for backward compatibility with any backend code paths
    // that still read user_token directly.  Falls back to "anon-local" only
    // when the participant mint failed (offline / network error).
    const attribution = participantId ?? "anon-local";
    const payload: ContributeRequest = {
      role_id: currentRole.id,
      user_token: attribution,
      content,
      structured_fields: { ...fieldValues },
      station_id: stationId,
      participant_id: participantId ?? undefined,
    };

    try {
      const apiBase =
        process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
      const res = await fetch(
        `${apiBase}/quorums/${quorumId}/contribute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (res.ok) {
        const data = await res.json();

        const newContrib: Contribution = {
          id: data.contribution_id,
          quorum_id: quorumId,
          role_id: currentRole.id,
          user_token: attribution,
          content,
          structured_fields: { ...fieldValues },
          tier_processed: data.tier_processed ?? 1,
          created_at: new Date().toISOString(),
        };
        setContributions((prev) => [...prev, newContrib]);
        setSubmitSuccess(true);
        setFieldValues({});

        // Wire facilitator reply from /contribute response to AvatarPanel and
        // the conversation thread — satisfies the TODO in AvatarPanel.tsx.
        if (data.facilitator_paused) {
          // Facilitator paused (LLM unavailable). Don't render an assistant
          // message and don't speak; surface the paused state to the avatar.
          conversation.ingestFacilitatorReply({
            reply: null,
            message_id: null,
            tags: [],
            paused: true,
            reason: data.facilitator_paused_reason ?? "llm_unavailable",
          });
        } else if (data.facilitator_reply) {
          conversation.ingestFacilitatorReply({
            reply: data.facilitator_reply,
            message_id: data.facilitator_message_id ?? `auto-${Date.now()}`,
            tags: data.facilitator_tags ?? [],
          });
          // Switch to the Conversation tab so users see the reply
          setActiveTab("conversation");
        }
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      await enqueue(quorumId, payload);
      setSubmitSuccess(true);
      setFieldValues({});
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 sm:p-6 max-w-4xl mx-auto animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-1/3 mb-4" />
        <div className="h-64 bg-gray-100 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Left panel: Avatar facilitator — hidden globally via Navbar avatar toggle */}
      {showAvatars && (
      <div className="lg:w-1/3 lg:min-h-screen bg-slate-900 p-4 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <Link
            href={`/event/${slug}`}
            className="text-xs text-white/50 hover:text-white/80 transition-colors"
          >
            &larr; Back to {slug}
          </Link>
          <div className="flex items-center gap-2">
            {isDemoMode() && (
              <span className="text-[10px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">
                Demo Mode
              </span>
            )}
            {/* Audio output toggle — suppresses facilitator TTS when muted */}
            <button
              type="button"
              onClick={() => setAudioMuted((m) => !m)}
              data-testid="audio-mute-toggle"
              title={audioMuted ? "Unmute facilitator audio" : "Mute facilitator audio"}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors text-xs font-medium ${
                audioMuted
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white/80"
              }`}
              aria-pressed={audioMuted}
              aria-label={audioMuted ? "Unmute facilitator audio" : "Mute facilitator audio"}
            >
              {audioMuted ? (
                /* Muted speaker icon */
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                /* Speaker with sound waves icon */
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
              {audioMuted ? "Audio Off" : "Audio On"}
            </button>
          </div>
        </div>

        {/* 3D Avatar — synthesisText is wired to the latest facilitator reply.
            When audioMuted is true, we pass undefined so TTS never fires. */}
        <div className="flex-1 min-h-[300px]">
          <AvatarPanel
            quorumId={quorumId}
            showDirectionIndicator
            enableEmotionTracking={hasWebcam && !audioMuted}
            enableMic={!audioMuted}
            roleName={currentRole?.name}
            staticSynthesisText={audioMuted ? undefined : synthesisText}
            paused={facilitatorPaused}
            pausedReason={facilitatorPausedReason}
          />
        </div>
      </div>
      )}

      {/* Right panel: Quorum interaction */}
      <div className="flex-1 p-4 sm:p-6 max-w-2xl flex flex-col min-h-screen lg:min-h-0">
        {/* A2A activity toast — visible whenever there are undismissed A2A notifications
            and the user is not already on the Conversation tab.  Clicking it switches
            the tab so the user can see the full notification in context. */}
        {a2a.pendingCount > 0 && activeTab !== "conversation" && (
          <div
            role="alert"
            data-testid="a2a-toast"
            className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-2.5 text-sm text-amber-800 shadow-sm"
          >
            <div className="flex items-center gap-2">
              {/* Agent icon */}
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="flex-shrink-0 text-amber-500"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>
                <strong>{a2a.pendingCount}</strong> agent{" "}
                {a2a.pendingCount === 1 ? "notification" : "notifications"} — agents are
                flagging activity that needs your attention.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab("conversation")}
              className="flex-shrink-0 text-xs font-medium text-amber-700 hover:text-amber-900 underline"
            >
              View
            </button>
          </div>
        )}

        <header
          data-testid="quorum-header"
          className="sticky top-0 z-30 -mx-4 sm:-mx-6 px-4 sm:px-6 mb-4 bg-white/95 dark:bg-gray-900/95 backdrop-blur supports-[backdrop-filter]:bg-white/75 supports-[backdrop-filter]:dark:bg-gray-900/75 border-b border-gray-200 dark:border-gray-700"
        >
          {/* Always-visible row: topic title + current role + dashboard + expand chevron */}
          <div className="flex items-center justify-between gap-2 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              {headerShowDescription && quorumDescription ? (
                <p
                  data-testid="quorum-header-text"
                  className="text-xs sm:text-sm text-gray-700 dark:text-gray-300 line-clamp-2 min-w-0"
                  title={quorumDescription}
                >
                  {quorumDescription}
                </p>
              ) : (
                <h1
                  data-testid="quorum-header-text"
                  className="text-base sm:text-lg font-bold truncate text-gray-900 dark:text-gray-100"
                >
                  {quorumPosition !== null && (
                    <span className="text-gray-400 dark:text-gray-500 font-mono mr-1.5">
                      #{quorumPosition}
                    </span>
                  )}
                  {quorumTitle || `Quorum ${quorumId}`}
                </h1>
              )}
              {quorumDescription && (
                <button
                  type="button"
                  data-testid="header-title-toggle"
                  onClick={() => setHeaderShowDescription((v) => !v)}
                  aria-pressed={headerShowDescription}
                  aria-label={
                    headerShowDescription
                      ? "Show short title"
                      : "Show longer description"
                  }
                  title={
                    headerShowDescription
                      ? "Show short title"
                      : "Show longer description"
                  }
                  className="p-1 rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors flex-shrink-0"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {/* Two horizontal lines + arrows = "swap short/long view" */}
                    <line x1="3" y1="8" x2="15" y2="8" />
                    <polyline points="18 5 21 8 18 11" />
                    <line x1="21" y1="16" x2="9" y2="16" />
                    <polyline points="6 13 3 16 6 19" />
                  </svg>
                </button>
              )}
              {currentRole && (
                <span
                  className="text-[10px] sm:text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap"
                  style={{
                    backgroundColor: currentRole.color
                      ? `${currentRole.color}20`
                      : "#e0e7ff",
                    color: currentRole.color ?? "#4f46e5",
                  }}
                >
                  {currentRole.name}
                </span>
              )}
              {station && (
                <span className="text-[10px] sm:text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap bg-indigo-50 text-indigo-700">
                  Station {station}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {/* Auto-promote toggle — pill with a status dot.  ON = agent
                  chat turns flow into contributions when the analyzer scores
                  them above the threshold (chart moves during conversation).
                  OFF = chart only moves on explicit /contribute submissions. */}
              <button
                type="button"
                onClick={toggleAutoPromote}
                data-testid="auto-promote-toggle"
                aria-pressed={autoPromote}
                title={
                  autoPromote
                    ? "Auto-promote chat: ON — agent replies become contributions when contribution-worthy"
                    : "Auto-promote chat: OFF — chart only moves on explicit Submit Contribution"
                }
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  autoPromote
                    ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400"
                }`}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                    autoPromote ? "bg-emerald-500" : "bg-gray-400"
                  }`}
                  aria-hidden
                />
                <span className="hidden sm:inline">Auto-promote chat</span>
                <span className="sm:hidden">Auto</span>
              </button>
              {/* Resolve button — locks the quorum and triggers Tier-3 synthesis,
                  which writes the final artifact + the `final_position` snapshot
                  the Before/After tab reads from.  Confirmation gate prevents
                  accidental clicks; backend returns 409 if already resolved. */}
              <button
                type="button"
                data-testid="resolve-button"
                onClick={async () => {
                  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
                  // Already-resolved click = refresh the snapshot (the original
                  // synthesis can drop the snapshot step silently if the
                  // position_analyzer throws — see /refresh-snapshot route).
                  if (quorumStatus === "resolved") {
                    setResolving(true);
                    try {
                      const res = await fetch(
                        `${apiBase}/quorums/${quorumId}/refresh-snapshot`,
                        { method: "POST" },
                      );
                      if (res.ok) {
                        setActiveTab("resolution");
                      } else {
                        const detail = await res.json().catch(() => null);
                        alert(`Refresh failed (HTTP ${res.status}): ${detail?.detail ?? "unknown error"}`);
                      }
                    } catch (err) {
                      alert(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                      setResolving(false);
                    }
                    return;
                  }
                  if (
                    !window.confirm(
                      "Resolve this quorum?\n\n• Writes the final Before/After snapshot\n• Runs one Tier-3 synthesis to generate the artifact\n• Does NOT lock future chat — agents can still talk after\n\nYou can re-run this (the button becomes 'Refresh') to retry the snapshot.",
                    )
                  ) {
                    return;
                  }
                  setResolving(true);
                  try {
                    const res = await fetch(`${apiBase}/quorums/${quorumId}/resolve`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ sign_off_token: "manual-resolve" }),
                    });
                    if (res.ok) {
                      setQuorumStatus("resolved");
                      setActiveTab("resolution");
                    } else if (res.status === 409) {
                      setQuorumStatus("resolved");
                      // 409 = already resolved.  Auto-fire snapshot refresh in
                      // case the original resolve's snapshot step failed.
                      await fetch(`${apiBase}/quorums/${quorumId}/refresh-snapshot`, {
                        method: "POST",
                      }).catch(() => undefined);
                      setActiveTab("resolution");
                    } else {
                      const detail = await res.json().catch(() => null);
                      alert(`Resolve failed (HTTP ${res.status}): ${detail?.detail ?? "unknown error"}`);
                    }
                  } catch (err) {
                    alert(`Resolve failed: ${err instanceof Error ? err.message : String(err)}`);
                  } finally {
                    setResolving(false);
                  }
                }}
                disabled={resolving}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  quorumStatus === "resolved"
                    ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 cursor-pointer"
                    : resolving
                      ? "bg-amber-50 text-amber-700 cursor-wait"
                      : "bg-amber-500 text-white hover:bg-amber-600 cursor-pointer"
                }`}
                title={
                  quorumStatus === "resolved"
                    ? "Re-run snapshot extraction (in case the original synthesis dropped rows)"
                    : resolving
                      ? "Synthesizing artifact…"
                      : "Run synthesis + write the Before/After snapshot"
                }
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {quorumStatus === "resolved" ? (
                    <>
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </>
                  ) : (
                    <polyline points="20 6 9 17 4 12" />
                  )}
                </svg>
                <span className="hidden sm:inline">
                  {quorumStatus === "resolved"
                    ? resolving
                      ? "Refreshing…"
                      : "Refresh Before/After"
                    : resolving
                      ? "Resolving…"
                      : "Resolve"}
                </span>
              </button>
              <Link
                href={`/display/${slug}`}
                data-testid="dashboard-link"
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 text-indigo-600 px-2.5 py-1.5 text-xs font-medium hover:bg-indigo-100 transition-colors"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                </svg>
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
              <button
                type="button"
                data-testid="header-expand-toggle"
                onClick={() => setHeaderExpanded((v) => !v)}
                aria-expanded={headerExpanded}
                aria-label={headerExpanded ? "Hide topic details" : "Show topic details"}
                title={headerExpanded ? "Hide topic details" : "Show topic details"}
                className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${headerExpanded ? "rotate-180" : ""}`}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
          </div>

          {/* Expanded details — description, station, autonomy. Hidden by default
              so the sticky bar stays small. */}
          {headerExpanded && (
            <div className="pb-3 space-y-2">
              {quorumDescription && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {quorumDescription}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAutonomyControl((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  Autonomy: {autonomyLevel.toFixed(1)}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d={showAutonomyControl ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
                  </svg>
                </button>
              </div>
              {showAutonomyControl && (
                <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 dark:text-gray-300 w-16">Human</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={autonomyLevel}
                      onChange={async (e) => {
                        const val = parseFloat(e.target.value);
                        setAutonomyLevel(val);
                        const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
                        await fetch(`${apiBase}/quorums/${quorumId}/autonomy`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ autonomy_level: val }),
                        }).catch(() => {});
                      }}
                      className="flex-1 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    />
                    <span className="text-xs text-gray-600 dark:text-gray-300 w-16 text-right">Autonomous</span>
                    <span className="text-sm font-semibold text-blue-600 w-8 text-right tabular-nums">
                      {autonomyLevel.toFixed(1)}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                    Adjust how proactively agents communicate. Changes take effect immediately.
                  </p>
                </div>
              )}
            </div>
          )}
        </header>

        {/* Role selection */}
        {roles.length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Select your role
            </h2>
            <div className="flex flex-col gap-2">
              {roles.map((role) => {
                const isSelected = currentRole?.id === role.id;
                return (
                  <button
                    key={role.id}
                    data-testid={`role-select-${role.id}`}
                    onClick={() => selectRole(role)}
                    className="w-full flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm font-medium transition-all"
                    style={{
                      backgroundColor: isSelected
                        ? `${role.color ?? "#6b7280"}20`
                        : `${role.color ?? "#6b7280"}08`,
                      color: role.color ?? "#6b7280",
                      ...(isSelected
                        ? { boxShadow: `0 0 0 2px ${role.color ?? "#6b7280"}` }
                        : {}),
                    }}
                  >
                    <span>{role.name}</span>
                    <PresenceDots roleId={role.id} presence={presence} />
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Contribution form */}
        {currentRole && (
          <section className="mb-6">
            <form onSubmit={handleSubmit} data-testid="contribution-form">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-700">
                  Contributing as{" "}
                  <span style={{ color: currentRole.color }}>
                    {currentRole.name}
                  </span>
                </h2>
                <VoiceButton onTranscript={handleVoiceTranscript} />
              </div>

              <div className="space-y-4">
                {(currentRole.prompt_template ?? []).length > 0 ? (
                  (currentRole.prompt_template ?? []).map((field) => (
                    <div key={field.field_name}>
                      <label
                        htmlFor={field.field_name}
                        className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
                      >
                        {field.prompt}
                      </label>
                      <textarea
                        id={field.field_name}
                        data-testid={`field-${field.field_name}`}
                        value={fieldValues[field.field_name] ?? ""}
                        onChange={(e) =>
                          handleFieldChange(field.field_name, e.target.value)
                        }
                        rows={3}
                        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none resize-none dark:bg-gray-800 dark:text-gray-100"
                        placeholder={`Enter your ${field.field_name.replace(/_/g, " ")}...`}
                      />
                    </div>
                  ))
                ) : (
                  <div>
                    <label
                      htmlFor="contribution"
                      className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
                    >
                      Your contribution
                    </label>
                    <textarea
                      id="contribution"
                      data-testid="field-contribution"
                      value={fieldValues["contribution"] ?? ""}
                      onChange={(e) =>
                        handleFieldChange("contribution", e.target.value)
                      }
                      rows={4}
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none resize-none dark:bg-gray-800 dark:text-gray-100"
                      placeholder={`Share your perspective as ${currentRole.name}...`}
                    />
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={
                    submitting ||
                    Object.values(fieldValues).every((v) => !v.trim())
                  }
                  data-testid="submit-contribution"
                  className="flex-1 rounded-xl bg-indigo-600 text-white py-3 px-4 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  {submitting ? "Submitting..." : "Submit Contribution"}
                </button>
              </div>

              {submitSuccess && (
                <p
                  data-testid="submit-success"
                  className="mt-2 text-sm text-green-600 font-medium"
                >
                  Contribution submitted successfully
                </p>
              )}
            </form>
          </section>
        )}

        {/* Agent activity feed — shows what autonomous agents are doing */}
        <section className="mb-4">
          <AgentActivityFeed
            quorumId={quorumId}
            roles={roles}
            visible={showAgentActivity}
            onToggle={() => setShowAgentActivity((v) => !v)}
          />
        </section>

        {/* Tabbed panel — Conversation | Documents | Contributions */}
        <section className="flex-1 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden flex flex-col min-h-[400px]">
          {/* Tab bar */}
          <div
            className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900"
            role="tablist"
            data-testid="quorum-tabs"
          >
            {(
              [
                { id: "conversation", label: "Conversation" },
                { id: "documents", label: "Documents" },
                { id: "contributions", label: `Contributions (${contributions.length})` },
                { id: "a2a", label: "A2A Activity" },
                { id: "resolution", label: "Before / After" },
              ] as { id: PanelTab; label: string }[]
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                onClick={() => setActiveTab(id)}
                data-testid={`tab-${id}`}
                className={`px-4 py-2.5 text-sm font-medium transition-colors focus:outline-none ${
                  activeTab === id
                    ? "text-indigo-600 border-b-2 border-indigo-600 bg-white dark:bg-gray-800"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                }`}
              >
                {label}
                {/* Unread badge: amber number for A2A notifications, indigo dot for
                    regular facilitator replies — always hidden on the active tab */}
                {id === "conversation" && activeTab !== "conversation" && (
                  <>
                    {a2a.pendingCount > 0 && (
                      <span
                        data-testid="a2a-badge"
                        className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none align-middle"
                      >
                        {a2a.pendingCount}
                      </span>
                    )}
                    {a2a.pendingCount === 0 && conversation.facilitatorReply && (
                      <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 align-middle" />
                    )}
                  </>
                )}
                {/* A2A tab unread badge — counts every quorum-wide A2A event
                    that has landed since the user last viewed this tab. */}
                {id === "a2a" && activeTab !== "a2a" && a2aUnreadCount > 0 && (
                  <span
                    data-testid="a2a-tab-badge"
                    className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none align-middle"
                  >
                    {a2aUnreadCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {/* Conversation tab */}
            {activeTab === "conversation" && (
              <ConversationThread
                quorumId={quorumId}
                stationId={stationId}
                roleId={currentRole?.id ?? ""}
                messages={mergedMessages}
                loading={conversation.loading}
                sending={conversation.sending}
                onSend={conversation.sendMessage}
              />
            )}

            {/* Documents tab */}
            {activeTab === "documents" && (
              <DocumentPanel
                quorumId={quorumId}
                documents={documents}
                loading={docsLoading}
              />
            )}

            {/* A2A Activity tab — chronological feed of every agent-to-agent
                ping in this quorum (source → target, status, request, outcome).
                Source data is `useQuorumLive(...).a2aEvents`, which is fetched
                once + kept fresh via Supabase realtime. */}
            {activeTab === "a2a" && (
              <A2AActivityTab events={a2aEvents} roles={roles} />
            )}

            {/* Before / After tab — wraps the 3 before/after views behind a
                toggle (Headline / Radar / Table).  Powered by the
                /quorums/{id}/before-after endpoint added in PR #66. */}
            {activeTab === "resolution" && (
              <BeforeAfterPanel quorumId={quorumId} />
            )}

            {/* Contributions tab */}
            {activeTab === "contributions" && (
              <div className="p-3 overflow-y-auto h-full">
                {contributions.length === 0 ? (
                  <p
                    className="text-center text-sm text-gray-400 py-8"
                    data-testid="contributions-empty"
                  >
                    No contributions yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {contributions.map((c) => {
                      const role = roles.find((r) => r.id === c.role_id);
                      return (
                        <div
                          key={c.id}
                          data-testid={`contribution-${c.id}`}
                          className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-sm"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className="text-xs font-medium px-2 py-0.5 rounded-full"
                              style={{
                                backgroundColor: role
                                  ? `${role.color}15`
                                  : "#f3f4f6",
                                color: role?.color ?? "#6b7280",
                              }}
                            >
                              {role?.name ?? "Unknown"}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
                              {new Date(c.created_at).toLocaleTimeString()}
                            </span>
                          </div>
                          <p className="text-gray-700 dark:text-gray-200 line-clamp-2">
                            {c.content}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
