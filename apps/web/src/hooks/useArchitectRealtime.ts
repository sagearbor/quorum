/**
 * useArchitectRealtime — WebRTC client for OpenAI's gpt-realtime API,
 * scoped to the Architect form-fill flow.
 *
 * Flow (May 2026 GA Realtime API):
 *
 *   1. `start()` POSTs to our backend `/architect/realtime/session` and
 *      receives an ephemeral `ek_…` client_secret.
 *   2. We open a single `RTCPeerConnection`, attach the user's mic, and
 *      create a data channel for the API events (`oai-events`).
 *   3. We POST the SDP offer to `https://api.openai.com/v1/realtime/calls`
 *      with the ephemeral key as Bearer.  We get an SDP answer back and
 *      `setRemoteDescription` it. Audio out comes back on the existing
 *      peer connection (no extra negotiation needed).
 *   4. As the user speaks, gpt-realtime emits:
 *        - `response.audio_transcript.delta` (its own spoken answer's text)
 *        - `conversation.item.input_audio_transcription.completed` (what
 *          the user said)
 *        - `response.function_call_arguments.delta` / `.done` (tool calls
 *          that fill the form)
 *   5. The hook surfaces:
 *        - `start()` / `stop()`
 *        - state: "idle" | "connecting" | "live" | "error"
 *        - `transcript` — running concatenation of user + assistant lines
 *        - `onToolCall` callback prop — invoked whenever gpt-realtime
 *          completes a function call so callers can update Zustand
 *
 * Whisper fallback is NOT done in this hook — it lives in a separate
 * `transcribeBlob` helper because Whisper is one-shot (record → POST →
 * text) and has no live state.
 *
 * Browser compat: requires WebRTC + getUserMedia (Chrome/Safari/Firefox
 * 2024+).  In jsdom these are undefined, so the test suite stubs them.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RealtimeState = "idle" | "connecting" | "live" | "error";

/** Tool-call event the model emits when it wants to fill the form. */
export interface RealtimeToolCall {
  /** Tool name as declared in voice_routes.ARCHITECT_TOOLS. */
  name: string;
  /** Parsed arguments object (already JSON.parse'd). */
  arguments: Record<string, unknown>;
  /** OpenAI's call_id — needed if you want to send a tool result back. */
  call_id: string;
}

export interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
  /** Wall-clock ms when the line was added. */
  ts: number;
}

export interface UseArchitectRealtimeOptions {
  /** API base for our backend. Defaults to NEXT_PUBLIC_API_URL. */
  apiBase?: string;
  /**
   * Called whenever gpt-realtime completes a `function_call`. The caller
   * typically routes this into the Architect Zustand store.
   */
  onToolCall?: (call: RealtimeToolCall) => void;
  /**
   * Override voice for this session (defaults to backend default).
   */
  voice?: string;
  /**
   * Override model for this session (defaults to backend default
   * `gpt-realtime`).
   */
  model?: string;
}

export interface UseArchitectRealtimeReturn {
  start: () => Promise<void>;
  stop: () => void;
  state: RealtimeState;
  error: string | null;
  transcript: TranscriptLine[];
  /** True when the model is actively producing audio output. */
  speaking: boolean;
  /** True when the mic is open. */
  listening: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// Default model used when the backend doesn't override.  We keep this
// frontend-local default in sync with voice_routes.DEFAULT_REALTIME_MODEL so
// that querystring-style ?model=… works even if the backend doesn't echo
// the model back yet.
const DEFAULT_MODEL = "gpt-realtime";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useArchitectRealtime(
  opts: UseArchitectRealtimeOptions = {},
): UseArchitectRealtimeReturn {
  const { apiBase: optApiBase, onToolCall, voice, model } = opts;

  const apiBase =
    optApiBase ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8000";

  const [state, setState] = useState<RealtimeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  // Accumulators keyed by item/response id so we can stitch deltas back into
  // a single transcript line (the API streams text in fragments).
  const pendingUserTranscript = useRef<Map<string, string>>(new Map());
  const pendingAssistantTranscript = useRef<Map<string, string>>(new Map());
  const pendingToolArgs = useRef<Map<string, string>>(new Map());
  // Stable reference to onToolCall so cleanup doesn't depend on prop identity.
  const onToolCallRef = useRef(onToolCall);
  useEffect(() => {
    onToolCallRef.current = onToolCall;
  }, [onToolCall]);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  const cleanup = useCallback(() => {
    try {
      dcRef.current?.close();
    } catch {
      /* no-op */
    }
    dcRef.current = null;
    try {
      pcRef.current?.close();
    } catch {
      /* no-op */
    }
    pcRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }
    pendingUserTranscript.current.clear();
    pendingAssistantTranscript.current.clear();
    pendingToolArgs.current.clear();
    setSpeaking(false);
    setListening(false);
  }, []);

  // Always clean up on unmount.
  useEffect(() => cleanup, [cleanup]);

  // -------------------------------------------------------------------------
  // Event handler for the `oai-events` data channel
  // -------------------------------------------------------------------------

  const handleEvent = useCallback((evt: unknown) => {
    if (!evt || typeof evt !== "object") return;
    const e = evt as { type?: string; [k: string]: unknown };
    switch (e.type) {
      // Model started speaking (audio response begun)
      case "response.created":
      case "output_audio_buffer.started":
      case "response.output_audio.delta":
        setSpeaking(true);
        break;

      case "response.done":
      case "response.audio.done":
      case "output_audio_buffer.stopped":
        setSpeaking(false);
        break;

      // User's audio transcription (Whisper-on-server-side)
      case "conversation.item.input_audio_transcription.delta": {
        const id = (e.item_id as string) ?? "user-current";
        const delta = (e.delta as string) ?? "";
        const cur = pendingUserTranscript.current.get(id) ?? "";
        pendingUserTranscript.current.set(id, cur + delta);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const id = (e.item_id as string) ?? "user-current";
        const text =
          ((e.transcript as string) ?? pendingUserTranscript.current.get(id) ?? "").trim();
        pendingUserTranscript.current.delete(id);
        if (text) {
          setTranscript((cur) => [
            ...cur,
            { role: "user", text, ts: Date.now() },
          ]);
        }
        break;
      }

      // Assistant's spoken-text transcription (the API speaks AND streams text)
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const id = (e.response_id as string) ?? "asst-current";
        const delta = (e.delta as string) ?? "";
        const cur = pendingAssistantTranscript.current.get(id) ?? "";
        pendingAssistantTranscript.current.set(id, cur + delta);
        break;
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const id = (e.response_id as string) ?? "asst-current";
        const text =
          ((e.transcript as string) ?? pendingAssistantTranscript.current.get(id) ?? "").trim();
        pendingAssistantTranscript.current.delete(id);
        if (text) {
          setTranscript((cur) => [
            ...cur,
            { role: "assistant", text, ts: Date.now() },
          ]);
        }
        break;
      }

      // Function-call arguments arrive as deltas, then a `.done` event with
      // the full string.  We only invoke onToolCall once we have the full
      // arguments to avoid partial JSON parse errors.
      case "response.function_call_arguments.delta": {
        const id = (e.call_id as string) ?? "";
        const delta = (e.delta as string) ?? "";
        if (id) {
          const cur = pendingToolArgs.current.get(id) ?? "";
          pendingToolArgs.current.set(id, cur + delta);
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const id = (e.call_id as string) ?? "";
        const name = (e.name as string) ?? "";
        const argsStr =
          (e.arguments as string) ?? pendingToolArgs.current.get(id) ?? "{}";
        pendingToolArgs.current.delete(id);
        let parsed: Record<string, unknown> = {};
        try {
          parsed = argsStr ? JSON.parse(argsStr) : {};
        } catch {
          // Drop malformed tool calls — better than crashing the form.
          parsed = {};
        }
        if (name && onToolCallRef.current) {
          onToolCallRef.current({ name, arguments: parsed, call_id: id });
        }
        break;
      }

      case "error": {
        const msg =
          ((e.error as { message?: string })?.message as string) ??
          "Realtime API error";
        setError(msg);
        setState("error");
        break;
      }
      default:
        // Many events we ignore (session.created, rate_limits.updated, etc.)
        break;
    }
  }, []);

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  const start = useCallback(async () => {
    if (state === "live" || state === "connecting") return;
    setError(null);
    setState("connecting");
    setTranscript([]);

    try {
      // 1) Mint ephemeral token via our backend (the server holds the real
      //    OPENAI_API_KEY — the browser never sees it).
      const tokenResp = await fetch(
        `${apiBase}/architect/realtime/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voice,
            model: model ?? DEFAULT_MODEL,
          }),
        },
      );
      if (!tokenResp.ok) {
        let detail = "";
        try {
          const j = await tokenResp.json();
          detail =
            typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
        } catch {
          detail = await tokenResp.text().catch(() => "");
        }
        throw new Error(
          `Could not mint realtime session (HTTP ${tokenResp.status}): ${detail}`,
        );
      }
      const { client_secret, model: respModel } = (await tokenResp.json()) as {
        client_secret: string;
        model: string;
      };

      // 2) Build the WebRTC PeerConnection.
      if (typeof RTCPeerConnection === "undefined") {
        throw new Error(
          "WebRTC is not available in this browser. Use the Whisper fallback or upgrade your browser.",
        );
      }
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 3) Hook up remote audio playback.  The API will add an audio track
      //    for the assistant's voice when it speaks.
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (ev) => {
        const [stream] = ev.streams;
        if (stream) audioEl.srcObject = stream;
      };

      // 4) Open a data channel for the JSON event stream.
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          handleEvent(parsed);
        } catch {
          /* drop malformed events */
        }
      };
      dc.onopen = () => setState("live");
      dc.onclose = () => {
        // If the data channel closes while we believed we were live, treat
        // it as a clean stop unless we already errored.
        setState((prev) => (prev === "error" ? prev : "idle"));
        cleanup();
      };

      // 5) Get the user's mic and add it as the outbound audio track.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      setListening(true);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // 6) Create SDP offer and POST to /v1/realtime/calls.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch(
        `${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(respModel ?? DEFAULT_MODEL)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${client_secret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp ?? "",
        },
      );
      if (!sdpResp.ok) {
        const detail = await sdpResp.text().catch(() => "");
        throw new Error(
          `OpenAI Realtime SDP exchange failed (HTTP ${sdpResp.status}): ${detail}`,
        );
      }
      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      // State will flip to "live" when dc.onopen fires.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setState("error");
      cleanup();
    }
  }, [apiBase, cleanup, handleEvent, model, state, voice]);

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  const stop = useCallback(() => {
    cleanup();
    setState("idle");
  }, [cleanup]);

  return { start, stop, state, error, transcript, speaking, listening };
}

// ---------------------------------------------------------------------------
// transcribeBlob — Whisper STT fallback
// ---------------------------------------------------------------------------

/**
 * POST a recorded audio blob to our backend, which relays to OpenAI's
 * /v1/audio/transcriptions endpoint and returns the text.  Use this when
 * `useArchitectRealtime.start()` rejects (no WebRTC, no API key, paid-tier
 * gated) — record via MediaRecorder, then call this with the resulting
 * Blob and treat the returned text as if the user typed it.
 */
export async function transcribeBlob(
  blob: Blob,
  opts: { apiBase?: string; filename?: string } = {},
): Promise<string> {
  const apiBase =
    opts.apiBase ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8000";
  const filename = opts.filename ?? "architect-voice.webm";

  const form = new FormData();
  form.append("file", blob, filename);

  const resp = await fetch(`${apiBase}/architect/transcribe`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const j = await resp.json();
      detail =
        typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      detail = await resp.text().catch(() => "");
    }
    throw new Error(
      `Transcription failed (HTTP ${resp.status}): ${detail}`,
    );
  }
  const { text } = (await resp.json()) as { text: string };
  return text;
}
