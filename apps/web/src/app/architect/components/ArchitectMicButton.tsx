"use client";

/**
 * ArchitectMicButton — voice entry point for the event-creation form.
 *
 * Behavior:
 *   - Idle: shows a big mic icon. Click → opens a WebRTC session with
 *     gpt-realtime and starts listening.
 *   - Connecting: animated dot, button disabled.
 *   - Live: pulsing red dot. Click again → stop.
 *   - Tool calls from gpt-realtime call `onFormUpdate` with the parsed
 *     arguments; the parent maps them onto the event draft / problem.
 *   - Error: shows the message inline and offers a "Use Whisper fallback"
 *     button which records via MediaRecorder, POSTs to /architect/transcribe
 *     and surfaces the text in `onTranscript`.
 *
 * This file deliberately keeps Whisper recording inline — it's only a few
 * lines and reusing MediaRecorder across components would be premature.
 */

import { useCallback, useRef, useState } from "react";

import {
  transcribeBlob,
  useArchitectRealtime,
  type RealtimeToolCall,
} from "@/hooks/useArchitectRealtime";

interface Props {
  /**
   * Called when gpt-realtime fills a form field via its function-calling
   * API.  Maps a tool call name + args to local state.  When `name` is
   * `set_event_metadata`, args may contain event_title, event_slug,
   * problem_description.  When `name` is `submit_form`, the parent should
   * trigger its submit handler.
   */
  onFormUpdate: (call: RealtimeToolCall) => void;
  /**
   * Called when Whisper transcribes a one-shot recording. The parent
   * typically routes this into the problem-description textarea or shows
   * it as a chip for the user to confirm.
   */
  onTranscript?: (text: string) => void;
}

export function ArchitectMicButton({ onFormUpdate, onTranscript }: Props) {
  const handleToolCall = useCallback(
    (call: RealtimeToolCall) => {
      onFormUpdate(call);
    },
    [onFormUpdate],
  );

  const { start, stop, state, error, transcript, speaking, listening } =
    useArchitectRealtime({ onToolCall: handleToolCall });

  // ---- Whisper fallback recording (MediaRecorder) ------------------------
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [whisperError, setWhisperError] = useState<string | null>(null);

  async function startWhisperRecording() {
    setWhisperError(null);
    recordedChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunksRef.current, { type: "audio/webm" });
        try {
          const text = await transcribeBlob(blob);
          if (text && onTranscript) onTranscript(text);
        } catch (err) {
          setWhisperError(
            err instanceof Error ? err.message : "Transcription failed",
          );
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      setWhisperError(
        err instanceof Error
          ? err.message
          : "Could not access microphone for fallback recording",
      );
    }
  }

  function stopWhisperRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  // ---- Button label/state ------------------------------------------------
  const isLive = state === "live";
  const isConnecting = state === "connecting";

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4 mb-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={isLive ? "Stop talking" : "Talk to the Architect"}
          aria-pressed={isLive}
          onClick={() => (isLive ? stop() : start())}
          disabled={isConnecting}
          className={`flex items-center justify-center w-12 h-12 rounded-full transition-all flex-shrink-0 ${
            isLive
              ? "bg-red-600 hover:bg-red-700 animate-pulse"
              : isConnecting
                ? "bg-gray-400 cursor-wait"
                : "bg-blue-600 hover:bg-blue-700"
          } text-white`}
        >
          {/* Mic icon (SVG kept inline to avoid an icon-lib dep) */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-6 h-6"
            aria-hidden="true"
          >
            <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3z" />
            <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11z" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {isLive
              ? speaking
                ? "Architect speaking…"
                : listening
                  ? "Listening…"
                  : "Live"
              : isConnecting
                ? "Connecting to the Architect…"
                : "Talk to the Architect"}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {isLive
              ? "Describe the event. I'll fill the form."
              : "Say something like “Clinical trial review of BREATHE-AI.”"}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 p-2 rounded bg-red-50 dark:bg-red-900/30 text-xs text-red-700 dark:text-red-300">
          <div className="font-medium">Realtime API failed:</div>
          <div className="break-words">{error}</div>
          <button
            type="button"
            onClick={recording ? stopWhisperRecording : startWhisperRecording}
            className="mt-2 px-2 py-1 rounded bg-red-600 text-white text-xs hover:bg-red-700"
          >
            {recording ? "Stop & transcribe" : "Use Whisper fallback (record → text)"}
          </button>
          {whisperError && (
            <div className="mt-2 text-red-800 dark:text-red-200">
              Fallback: {whisperError}
            </div>
          )}
        </div>
      )}

      {transcript.length > 0 && (
        <div className="mt-3 max-h-32 overflow-y-auto text-xs space-y-1 border-t border-blue-100 dark:border-blue-800 pt-2">
          {transcript.map((line, i) => (
            <div
              key={i}
              className={
                line.role === "user"
                  ? "text-gray-700 dark:text-gray-300"
                  : "text-blue-700 dark:text-blue-300"
              }
            >
              <span className="font-semibold">
                {line.role === "user" ? "You" : "Architect"}:
              </span>{" "}
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
