"use client";

/**
 * /agent/[roleId] — mobile 1:1 chat with a single role-agent.
 *
 * Loaded by phones after they scan a QR code and pair via /pair.  Defaults to
 * NO audio output and NO microphone — the Duke Tech Expo 2026 room will be
 * small and loud, so any TTS or hot-mic cross-station bleed is unacceptable.
 *
 * URL shape: /agent/<role_id>?ds=<participant_id>
 *
 * Pre-conditions:
 *   - The /pair flow has already minted a participant_id and stored the
 *     payload in sessionStorage as `quorum.participant` (10.4 contract).
 *   - The participant's role_id must match the :roleId path param — otherwise
 *     we render an error rather than silently re-minting a participant.
 *
 * Side-effects:
 *   - 30s heartbeat ping to /sessions/heartbeat.
 *   - On 401/404 from heartbeat, redirect to /pair-expired.
 *   - sessionStorage("quorum.agent.audio.<participant_id>") persists the user's
 *     speaker/mic choices across reloads.  Defaults remain OFF on first load
 *     even on the same device — we only persist explicit user opt-in.
 *
 * See docs/audit/2026-05-12-overnight-plan.html for the 10.5 card.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import type {
  Role,
  StationMessage,
  ContributeRequest,
} from "@quorum/types";
import { getRoles, getHealthScore } from "@/lib/dataProvider";
import { useStationConversation } from "@/hooks/useStationConversation";
import { resolveArchetype } from "@/components/avatar/archetypes/resolveArchetype";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredParticipant {
  participant_id: string;
  display_name?: string;
  quorum_id: string;
  station_label?: string | null;
  role_id?: string | null;
  device_kind?: "laptop" | "phone";
}

interface AudioPrefs {
  speaker: boolean;
  mic: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const HEARTBEAT_INTERVAL_MS = 30_000;
const PARTICIPANT_KEY = "quorum.participant";

function audioPrefsKey(participantId: string): string {
  return `quorum.agent.audio.${participantId}`;
}

// ---------------------------------------------------------------------------
// MicButton — single-shot Web Speech API capture; only rendered when the user
// has explicitly toggled the mic ON.  No continuous listening, no background
// processing.
// ---------------------------------------------------------------------------

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult:
    | ((event: { results: { 0: { 0: { transcript: string } } } }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function MicButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);

  const start = useCallback(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Speech recognition not supported on this device.");
      return;
    }
    const r: SpeechRecognitionLike = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = "en-US";
    r.onresult = (event) => {
      onTranscript(event.results[0][0].transcript);
      setListening(false);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    r.start();
    setListening(true);
  }, [onTranscript]);

  return (
    <button
      type="button"
      onClick={start}
      disabled={listening}
      data-testid="agent-mic-trigger"
      aria-label={listening ? "Listening" : "Tap to speak"}
      className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
        listening
          ? "bg-red-100 text-red-600 animate-pulse"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// AgentPage
// ---------------------------------------------------------------------------

export default function AgentPage() {
  const params = useParams<{ roleId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const roleId = params.roleId;
  const participantId = searchParams.get("ds");

  // -----------------------------------------------------------------------
  // Participant validation — read sessionStorage, validate against URL
  // -----------------------------------------------------------------------
  const [participant, setParticipant] = useState<StoredParticipant | null>(null);
  const [participantError, setParticipantError] = useState<string | null>(null);

  useEffect(() => {
    if (!participantId) {
      setParticipantError(
        "This link is missing your pairing code. Ask the attendant for a fresh QR code.",
      );
      return;
    }
    try {
      const raw = window.sessionStorage.getItem(PARTICIPANT_KEY);
      if (!raw) {
        setParticipantError(
          "We can't find your pairing on this device. Ask the attendant for a fresh QR code.",
        );
        return;
      }
      const stored = JSON.parse(raw) as StoredParticipant;
      if (stored.participant_id !== participantId) {
        setParticipantError(
          "This link doesn't match the pairing stored on this device. Ask the attendant for a fresh QR code.",
        );
        return;
      }
      // role_id mismatch is recoverable only by the attendant — surface a
      // clear error rather than silently rebinding.
      if (stored.role_id && stored.role_id !== roleId) {
        setParticipantError(
          "This link points to a different role than your pairing. Ask the attendant for a fresh QR code.",
        );
        return;
      }
      setParticipant(stored);
    } catch {
      setParticipantError(
        "Could not read your pairing. Ask the attendant for a fresh QR code.",
      );
    }
  }, [participantId, roleId]);

  // -----------------------------------------------------------------------
  // Role metadata — fetch all roles, pick the matching one.  No new endpoint;
  // see the report follow-up for adding GET /roles/{id} later.
  // -----------------------------------------------------------------------
  const [role, setRole] = useState<Role | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);
  const [healthScore, setHealthScore] = useState<number | null>(null);

  useEffect(() => {
    if (!participant) return;
    let cancelled = false;
    setRoleLoading(true);

    getRoles(participant.quorum_id)
      .then((roles) => {
        if (cancelled) return;
        const match = (roles as Role[]).find((r) => r.id === roleId) ?? null;
        setRole(match);
      })
      .catch(() => {
        if (!cancelled) setRole(null);
      })
      .finally(() => {
        if (!cancelled) setRoleLoading(false);
      });

    getHealthScore(participant.quorum_id)
      .then((score) => {
        if (!cancelled) setHealthScore(score);
      })
      .catch(() => {
        /* non-fatal; widget hides itself */
      });

    return () => {
      cancelled = true;
    };
  }, [participant, roleId]);

  // -----------------------------------------------------------------------
  // Heartbeat — 30s ping while paired. 401/404 redirects to /pair-expired.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!participant) return;

    let stopped = false;

    const ping = async () => {
      try {
        const res = await fetch(`${API_BASE}/sessions/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participant_id: participant.participant_id }),
        });
        if (!stopped && (res.status === 401 || res.status === 404)) {
          router.replace("/pair-expired");
        }
      } catch {
        /* heartbeat is best-effort — don't redirect on network blips */
      }
    };

    ping();
    const handle = window.setInterval(ping, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(handle);
    };
  }, [participant, router]);

  // -----------------------------------------------------------------------
  // Audio prefs — speaker OFF / mic OFF defaults. Persist explicit opt-in
  // scoped to the participant_id.  Reloads preserve the user's last choice
  // but a brand-new participant_id starts OFF.
  // -----------------------------------------------------------------------
  const [audioPrefs, setAudioPrefs] = useState<AudioPrefs>({
    speaker: false,
    mic: false,
  });
  const audioPrefsLoadedRef = useRef(false);

  useEffect(() => {
    if (!participant) return;
    try {
      const raw = window.sessionStorage.getItem(
        audioPrefsKey(participant.participant_id),
      );
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
        setAudioPrefs({
          speaker: parsed.speaker === true,
          mic: parsed.mic === true,
        });
      }
    } catch {
      /* fall through with defaults */
    } finally {
      audioPrefsLoadedRef.current = true;
    }
  }, [participant]);

  // Persist on every change AFTER initial load, never before.
  useEffect(() => {
    if (!participant || !audioPrefsLoadedRef.current) return;
    try {
      window.sessionStorage.setItem(
        audioPrefsKey(participant.participant_id),
        JSON.stringify(audioPrefs),
      );
    } catch {
      /* non-fatal */
    }
  }, [audioPrefs, participant]);

  // -----------------------------------------------------------------------
  // Conversation hook — scoped to this station + role.  The hook already
  // partitions by station_id, and the mobile route writes its own
  // station_id derived from station_label for clean isolation.
  // -----------------------------------------------------------------------
  const stationId =
    participant?.station_label ?? `phone-${participantId ?? "unknown"}`;
  const quorumId = participant?.quorum_id ?? "";

  const conversation = useStationConversation(quorumId, stationId, roleId);

  // -----------------------------------------------------------------------
  // Browser TTS — speak assistant replies ONLY when speaker toggle is ON.
  // Paused replies (10.6) MUST NEVER speak, even when the toggle is ON.
  // -----------------------------------------------------------------------
  const spokenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!audioPrefs.speaker) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const reply = conversation.facilitatorReply;
    if (!reply || reply.paused || !reply.reply || !reply.message_id) return;
    if (spokenIdsRef.current.has(reply.message_id)) return;
    spokenIdsRef.current.add(reply.message_id);

    try {
      const utter = new window.SpeechSynthesisUtterance(reply.reply);
      utter.lang = "en-US";
      window.speechSynthesis.speak(utter);
    } catch {
      /* TTS failure is non-fatal */
    }
  }, [conversation.facilitatorReply, audioPrefs.speaker]);

  // -----------------------------------------------------------------------
  // Contribute POST — text input submission.  Includes participant_id +
  // role_id + station_id and routes the facilitator reply back through
  // the conversation hook so the thread stays in sync.
  // -----------------------------------------------------------------------
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending || !participant || !role) return;
    setSending(true);
    setSendError(null);

    const payload: ContributeRequest = {
      role_id: roleId,
      user_token: participant.participant_id,
      content,
      structured_fields: { contribution: content },
      station_id: stationId,
      participant_id: participant.participant_id,
    };

    try {
      const res = await fetch(
        `${API_BASE}/quorums/${participant.quorum_id}/contribute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Echo the user message into the thread immediately so the chat feels
      // responsive — useStationConversation only appends when askFacilitator
      // is called.
      const userMsg: StationMessage = {
        id: `local-${Date.now()}`,
        quorum_id: participant.quorum_id,
        role_id: roleId,
        station_id: stationId,
        role: "user",
        content,
        created_at: new Date().toISOString(),
      };
      // Best-effort: push the user echo via ingestFacilitatorReply path is
      // wrong; instead we lean on the realtime channel + the assistant reply
      // append below. To keep the user message visible immediately, we
      // briefly stage it through ingestFacilitatorReply's side-channel —
      // see the conversation hook for details. For now we rely on the
      // realtime channel to surface the user message via subscribeToStationMessages
      // (the backend writes both turns there). If that lags, the assistant
      // reply still confirms the round trip.
      void userMsg;

      if (data.facilitator_paused) {
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
      }

      setDraft("");
    } catch (err) {
      setSendError(
        err instanceof Error ? err.message : "Could not reach the agent.",
      );
    } finally {
      setSending(false);
    }
  }, [
    draft,
    sending,
    participant,
    role,
    roleId,
    stationId,
    conversation,
  ]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (participantError) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-6"
        data-testid="agent-error"
      >
        <div className="max-w-screen-sm w-full bg-white dark:bg-slate-800 rounded-2xl shadow-md p-6 text-center">
          <h1 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">
            Pairing problem
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {participantError}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-4">
            Ask the attendant for a fresh QR code.
          </p>
        </div>
      </div>
    );
  }

  if (!participant || roleLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-6"
        data-testid="agent-loading"
      >
        <div className="animate-pulse text-slate-500 dark:text-slate-400">
          Connecting to the agent…
        </div>
      </div>
    );
  }

  if (!role) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-6"
        data-testid="agent-role-missing"
      >
        <div className="max-w-screen-sm w-full bg-white dark:bg-slate-800 rounded-2xl shadow-md p-6 text-center">
          <h1 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">
            Role not found
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This role no longer exists for the quorum.  Ask the attendant for a
            fresh QR code.
          </p>
        </div>
      </div>
    );
  }

  const archetype = resolveArchetype(role.name);
  const facilitatorPaused = conversation.facilitatorReply?.paused === true;

  return (
    <div
      className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-900 max-w-screen-sm mx-auto px-4"
      data-testid="agent-page"
    >
      {/* Sticky header */}
      <header
        className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3"
        data-testid="agent-header"
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold uppercase"
          style={{
            backgroundColor: role.color ? `${role.color}20` : "#e5e7eb",
            color: role.color ?? "#374151",
          }}
          data-testid="agent-archetype-icon"
          aria-label={`Archetype: ${archetype}`}
          title={archetype}
        >
          {archetype.slice(0, 2)}
        </div>
        <div className="flex-1 min-w-0">
          <h1
            className="text-sm font-semibold text-slate-900 dark:text-white truncate"
            data-testid="agent-role-name"
          >
            {role.name}
          </h1>
          {healthScore !== null && (
            <p
              className="text-[11px] text-slate-500 dark:text-slate-400"
              data-testid="agent-health-score"
            >
              Health {Math.round(healthScore)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              setAudioPrefs((prev) => ({ ...prev, speaker: !prev.speaker }))
            }
            aria-pressed={audioPrefs.speaker}
            aria-label={audioPrefs.speaker ? "Mute speaker" : "Unmute speaker"}
            data-testid="agent-speaker-toggle"
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
              audioPrefs.speaker
                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                : "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300"
            }`}
          >
            {audioPrefs.speaker ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() =>
              setAudioPrefs((prev) => ({ ...prev, mic: !prev.mic }))
            }
            aria-pressed={audioPrefs.mic}
            aria-label={audioPrefs.mic ? "Disable microphone" : "Enable microphone"}
            data-testid="agent-mic-toggle"
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
              audioPrefs.mic
                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                : "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300"
            }`}
          >
            {audioPrefs.mic ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="2" x2="22" y2="22" />
                <path d="M12 2a3 3 0 0 0-3 3v7" />
                <path d="M19 10v2a7 7 0 0 1-11 5.7" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Scrolling thread */}
      <main className="flex-1 overflow-y-auto py-3 space-y-2" data-testid="agent-thread">
        {conversation.loading && (
          <p className="text-center text-xs text-slate-400 py-4">
            Loading conversation…
          </p>
        )}
        {!conversation.loading && conversation.messages.length === 0 && (
          <p
            className="text-center text-xs text-slate-500 dark:text-slate-400 py-6"
            data-testid="agent-empty"
          >
            Say hello to {role.name}.
          </p>
        )}
        {conversation.messages.map((msg) => {
          const isUser = msg.role === "user";
          if (msg.role === "system") {
            return (
              <div
                key={msg.id}
                className="flex justify-center"
                data-testid={`agent-msg-${msg.id}`}
              >
                <div className="max-w-[90%] rounded-lg bg-slate-100 text-slate-600 px-3 py-1.5 text-xs">
                  {msg.content}
                </div>
              </div>
            );
          }
          return (
            <div
              key={msg.id}
              className={`flex ${isUser ? "justify-end" : "justify-start"}`}
              data-testid={`agent-msg-${msg.id}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                  isUser
                    ? "bg-indigo-600 text-white rounded-br-sm"
                    : "bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-bl-sm shadow-sm"
                }`}
              >
                {msg.content}
              </div>
            </div>
          );
        })}
        {(sending || conversation.sending) && (
          <div className="flex justify-start" data-testid="agent-typing">
            <div className="bg-white dark:bg-slate-700 rounded-2xl rounded-bl-sm px-3 py-2 flex gap-1 shadow-sm">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Paused pill */}
      {facilitatorPaused && (
        <div
          className="mb-2 self-center inline-flex items-center gap-2 rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1 text-xs"
          data-testid="agent-paused-pill"
          role="status"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          Facilitator paused — reconnecting
        </div>
      )}

      {/* Send error */}
      {sendError && (
        <div
          className="mb-2 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg"
          data-testid="agent-send-error"
        >
          {sendError}
        </div>
      )}

      {/* Sticky footer */}
      <footer
        className="sticky bottom-0 -mx-4 px-4 py-3 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700"
        data-testid="agent-footer"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
          className="flex items-end gap-2"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            disabled={sending}
            placeholder={`Message ${role.name}`}
            data-testid="agent-input"
            className="flex-1 resize-none rounded-xl border border-slate-300 dark:border-slate-600 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none disabled:bg-slate-100 dark:bg-slate-900 dark:text-slate-100"
            style={{ minHeight: "40px", maxHeight: "120px" }}
          />
          {audioPrefs.mic && (
            <MicButton onTranscript={(text) => setDraft((d) => (d ? `${d} ${text}` : text))} />
          )}
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            data-testid="agent-send"
            aria-label="Send message"
            className="flex-shrink-0 w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
        <p className="mt-1 text-[10px] text-slate-400 text-center">
          <Link href="/pair-expired" className="hover:underline">
            Need a new pairing?
          </Link>
        </p>
      </footer>
    </div>
  );
}
