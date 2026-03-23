"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  getQuorum,
  getRoles,
  getContributions,
  isDemoMode,
} from "@/lib/dataProvider";
import { enqueue } from "@/lib/offlineQueue";
import type { Role, Contribution, ContributeRequest } from "@quorum/types";
import { AvatarPanel } from "@/components/avatar/AvatarPanel";
import { ConversationThread } from "@/components/conversation/ConversationThread";
import { DocumentPanel } from "@/components/documents/DocumentPanel";
import { useStationConversation } from "@/hooks/useStationConversation";
import { useAgentDocuments } from "@/hooks/useAgentDocuments";
import { useA2ARequests } from "@/hooks/useA2ARequests";
import type { StationMessage } from "@quorum/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tabs shown below the contribution form. */
type PanelTab = "conversation" | "contributions" | "documents";

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

  const quorumId = params.id;
  const slug = params.slug;

  // Derive a stable stationId: use the ?station= param or fall back to a
  // synthetic identifier so the conversation hook always has a valid ID.
  const stationId = station ? `station-${station}` : `station-default`;

  const [quorumTitle, setQuorumTitle] = useState<string>("");
  const [quorumDescription, setQuorumDescription] = useState<string>("");
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
  const [audioMuted, setAudioMuted] = useState(false);

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

  // Agent documents hook
  const { documents, loading: docsLoading } = useAgentDocuments(quorumId);

  // A2A notifications for the current role — shows when other agents flag concerns
  const a2a = useA2ARequests(quorumId, currentRole?.id ?? "");

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

  // When there is a live facilitator reply, derive synthesisText for the avatar
  const synthesisText = conversation.facilitatorReply?.reply ?? undefined;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [quorum, qRoles, qContribs] = await Promise.all([
        getQuorum(quorumId),
        getRoles(quorumId),
        getContributions(quorumId),
      ]);
      if (cancelled) return;

      if (quorum) {
        setQuorumTitle(quorum.title);
        setQuorumDescription(quorum.description);
      }
      setRoles(qRoles as Role[]);
      setContributions(qContribs as Contribution[]);
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

  const handleFieldChange = (fieldName: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldName]: value }));
  };

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (!currentRole) return;
      if (currentRole.prompt_template.length > 0) {
        const firstEmptyField = currentRole.prompt_template.find(
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

    const payload: ContributeRequest = {
      role_id: currentRole.id,
      user_token: "anon-local",
      content,
      structured_fields: { ...fieldValues },
      station_id: stationId,
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
          user_token: "anon-local",
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
        if (data.facilitator_reply) {
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
      {/* Left panel: Avatar facilitator */}
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
            {/* Audio mute toggle — suppresses facilitator TTS when muted */}
            <button
              type="button"
              onClick={() => setAudioMuted((m) => !m)}
              data-testid="audio-mute-toggle"
              title={audioMuted ? "Unmute facilitator audio" : "Mute facilitator audio"}
              className={`p-1.5 rounded-lg transition-colors ${
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
            </button>
          </div>
        </div>

        {/* 3D Avatar — synthesisText is wired to the latest facilitator reply.
            When audioMuted is true, we pass undefined so TTS never fires. */}
        <div className="flex-1 min-h-[300px]">
          <AvatarPanel
            quorumId={quorumId}
            showDirectionIndicator
            enableEmotionTracking={hasWebcam}
            roleName={currentRole?.name}
            staticSynthesisText={audioMuted ? undefined : synthesisText}
          />
        </div>
      </div>

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

        <header className="mb-4">
          <div className="flex items-start justify-between">
            <h1 className="text-xl font-bold">
              {quorumTitle || `Quorum ${quorumId}`}
            </h1>
            <Link
              href={`/display/${slug}`}
              data-testid="dashboard-link"
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 text-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-100 transition-colors flex-shrink-0"
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
              Dashboard
            </Link>
          </div>
          {quorumDescription && (
            <p className="text-sm text-gray-500 mt-1">{quorumDescription}</p>
          )}
          {station && (
            <span className="mt-2 inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 text-indigo-700 text-xs font-medium">
              Station {station}
            </span>
          )}
        </header>

        {/* Role selection */}
        {roles.length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
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
                {currentRole.prompt_template.length > 0 ? (
                  currentRole.prompt_template.map((field) => (
                    <div key={field.field_name}>
                      <label
                        htmlFor={field.field_name}
                        className="block text-sm font-medium text-gray-700 mb-1"
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
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none resize-none"
                        placeholder={`Enter your ${field.field_name.replace(/_/g, " ")}...`}
                      />
                    </div>
                  ))
                ) : (
                  <div>
                    <label
                      htmlFor="contribution"
                      className="block text-sm font-medium text-gray-700 mb-1"
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
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none resize-none"
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

        {/* Tabbed panel — Conversation | Documents | Contributions */}
        <section className="flex-1 border border-gray-200 rounded-xl overflow-hidden flex flex-col min-h-[400px]">
          {/* Tab bar */}
          <div
            className="flex border-b border-gray-200 bg-gray-50"
            role="tablist"
            data-testid="quorum-tabs"
          >
            {(
              [
                { id: "conversation", label: "Conversation" },
                { id: "documents", label: "Documents" },
                { id: "contributions", label: `Contributions (${contributions.length})` },
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
                    ? "text-indigo-600 border-b-2 border-indigo-600 bg-white"
                    : "text-gray-500 hover:text-gray-700"
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
                          className="rounded-lg border border-gray-200 p-3 text-sm"
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
                            <span className="text-xs text-gray-400 ml-auto">
                              {new Date(c.created_at).toLocaleTimeString()}
                            </span>
                          </div>
                          <p className="text-gray-700 line-clamp-2">
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
