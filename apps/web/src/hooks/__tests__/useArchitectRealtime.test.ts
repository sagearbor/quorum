/**
 * Tests for useArchitectRealtime + transcribeBlob.
 *
 * WebRTC is hard to mock cleanly in jsdom — there is no native
 * RTCPeerConnection, MediaStream, or getUserMedia. We stub them with the
 * smallest surface that the hook actually exercises:
 *
 *   - new RTCPeerConnection().createOffer/setLocalDescription/setRemoteDescription
 *   - .createDataChannel("oai-events") returns a DataChannel-like object
 *     with onopen / onmessage / onclose hooks that we can fire manually
 *   - .ontrack assignment
 *   - .addTrack / .close are no-ops
 *   - navigator.mediaDevices.getUserMedia → MediaStream-shaped stub
 *
 * We then assert:
 *   - start() fetches the ephemeral token from our backend
 *   - start() POSTs the SDP offer to api.openai.com/v1/realtime/calls
 *     using the ephemeral key (NOT the main OPENAI_API_KEY)
 *   - state transitions idle → connecting → live as expected
 *   - data-channel events trigger onToolCall when function_call_arguments.done
 *     arrives, with arguments correctly JSON-parsed
 *   - User + assistant transcript events accumulate into the transcript array
 *   - stop() closes the peer connection and stops the mic
 *   - Token-mint failure leaves state="error" with a useful message
 *   - transcribeBlob() POSTs a form-data blob to /architect/transcribe and
 *     returns the text
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import {
  useArchitectRealtime,
  transcribeBlob,
} from "../useArchitectRealtime";

// ---------------------------------------------------------------------------
// WebRTC + getUserMedia stubs
// ---------------------------------------------------------------------------

interface FakeDataChannel {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  readyState: string;
}

interface FakePeerConnection {
  ondatachannel: ((ev: unknown) => void) | null;
  ontrack: ((ev: unknown) => void) | null;
  addTrack: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createOffer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  createDataChannel: (label: string) => FakeDataChannel;
  _dc: FakeDataChannel;
}

let currentPC: FakePeerConnection | null = null;

function makeFakeDataChannel(): FakeDataChannel {
  return {
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onmessage: null,
    readyState: "connecting",
  };
}

function makeFakePeerConnection(): FakePeerConnection {
  const dc = makeFakeDataChannel();
  const pc: FakePeerConnection = {
    ondatachannel: null,
    ontrack: null,
    addTrack: vi.fn(),
    close: vi.fn(),
    createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "v=0\nfake-offer" }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    createDataChannel: vi.fn(() => dc) as unknown as (
      label: string,
    ) => FakeDataChannel,
    _dc: dc,
  };
  currentPC = pc;
  return pc;
}

class FakeMediaStream {
  private tracks = [{ stop: vi.fn(), kind: "audio" }];
  getTracks() {
    return this.tracks;
  }
}

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  currentPC = null;
  // vi.fn() returns a function that doesn't work with `new` — vitest warns
  // and the constructed object is undefined. Use a real function declaration
  // so `new RTCPeerConnection()` properly returns our fake.
  function RTCPeerConnectionStub(this: unknown) {
    const fake = makeFakePeerConnection();
    Object.assign(this as object, fake);
    return fake;
  }
  // @ts-expect-error: jsdom doesn't have RTCPeerConnection — install stub
  global.RTCPeerConnection = RTCPeerConnectionStub;
  function AudioStub(this: unknown) {
    const fake = { autoplay: false, srcObject: null };
    Object.assign(this as object, fake);
    return fake;
  }
  // @ts-expect-error: minimal Audio stub
  global.Audio = AudioStub;
  Object.defineProperty(global.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(new FakeMediaStream()),
    },
  });
  // FormData is provided by jsdom but ensure it exists
  if (typeof FormData === "undefined") {
    // @ts-expect-error stub
    global.FormData = class {
      private parts: [string, unknown, string?][] = [];
      append(k: string, v: unknown, f?: string) {
        this.parts.push([k, v, f]);
      }
    };
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock fetch with per-URL handlers
// ---------------------------------------------------------------------------

function installFetchMock(handlers: {
  session?: (init?: RequestInit) => Promise<Response> | Response;
  calls?: (init?: RequestInit) => Promise<Response> | Response;
  transcribe?: (init?: RequestInit) => Promise<Response> | Response;
}) {
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/architect/realtime/session")) {
      return await (handlers.session?.(init) ?? new Response("{}", { status: 500 }));
    }
    if (url.includes("api.openai.com/v1/realtime/calls")) {
      return await (handlers.calls?.(init) ?? new Response("", { status: 500 }));
    }
    if (url.includes("/architect/transcribe")) {
      return await (
        handlers.transcribe?.(init) ?? new Response("{}", { status: 500 })
      );
    }
    return new Response("", { status: 404 });
  });
  global.fetch = f as unknown as typeof fetch;
  return f;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests — useArchitectRealtime
// ---------------------------------------------------------------------------

describe("useArchitectRealtime", () => {
  it("starts idle with no transcript", () => {
    installFetchMock({});
    const { result } = renderHook(() => useArchitectRealtime());
    expect(result.current.state).toBe("idle");
    expect(result.current.transcript).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("mints an ephemeral token from the backend, then POSTs the SDP offer to OpenAI", async () => {
    const f = installFetchMock({
      session: () =>
        jsonResponse({
          client_secret: "ek_browser_only",
          expires_at: 1747000000,
          model: "gpt-realtime",
          voice: "alloy",
        }),
      calls: () =>
        new Response("v=0\nfake-answer", {
          status: 200,
          headers: { "Content-Type": "application/sdp" },
        }),
    });

    const { result } = renderHook(() =>
      useArchitectRealtime({ apiBase: "http://api.test" }),
    );

    await act(async () => {
      await result.current.start();
    });

    // Trigger the data channel onopen → state should flip to "live"
    act(() => {
      currentPC?._dc.onopen?.();
    });

    await waitFor(() => expect(result.current.state).toBe("live"));

    // Check both fetches happened with correct shape
    const calls = f.mock.calls.map((c) => ({
      url: typeof c[0] === "string" ? c[0] : c[0]?.toString(),
      init: c[1],
    }));
    const sessionCall = calls.find((c) =>
      c.url?.includes("/architect/realtime/session"),
    );
    const sdpCall = calls.find((c) =>
      c.url?.includes("api.openai.com/v1/realtime/calls"),
    );
    expect(sessionCall).toBeTruthy();
    expect(sdpCall).toBeTruthy();
    // SDP offer must use the ephemeral key, never the main API key
    const sdpAuth = (sdpCall?.init?.headers as Record<string, string>)?.[
      "Authorization"
    ];
    expect(sdpAuth).toBe("Bearer ek_browser_only");
    expect(sdpCall?.init?.body).toContain("fake-offer");
  });

  it("dispatches onToolCall when function_call_arguments.done arrives", async () => {
    installFetchMock({
      session: () =>
        jsonResponse({
          client_secret: "ek_x",
          expires_at: 1,
          model: "gpt-realtime",
          voice: "alloy",
        }),
      calls: () => new Response("v=0\nanswer", { status: 200 }),
    });

    const onToolCall = vi.fn();
    const { result } = renderHook(() =>
      useArchitectRealtime({ onToolCall, apiBase: "http://api.test" }),
    );

    await act(async () => {
      await result.current.start();
    });

    // Fire deltas + done event on the data channel
    act(() => {
      currentPC?._dc.onmessage?.({
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          call_id: "call_1",
          delta: '{"event_title":"Clinical Trial Review',
        }),
      });
      currentPC?._dc.onmessage?.({
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          call_id: "call_1",
          delta: ' — BREATHE-AI","event_slug":"breathe-ai-review"}',
        }),
      });
      currentPC?._dc.onmessage?.({
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call_1",
          name: "set_event_metadata",
        }),
      });
    });

    expect(onToolCall).toHaveBeenCalledTimes(1);
    const arg = onToolCall.mock.calls[0][0];
    expect(arg.name).toBe("set_event_metadata");
    expect(arg.call_id).toBe("call_1");
    expect(arg.arguments).toEqual({
      event_title: "Clinical Trial Review — BREATHE-AI",
      event_slug: "breathe-ai-review",
    });
  });

  it("appends user + assistant transcript lines from streaming events", async () => {
    installFetchMock({
      session: () =>
        jsonResponse({
          client_secret: "ek_x",
          expires_at: 1,
          model: "gpt-realtime",
          voice: "alloy",
        }),
      calls: () => new Response("v=0\nanswer", { status: 200 }),
    });

    const { result } = renderHook(() =>
      useArchitectRealtime({ apiBase: "http://api.test" }),
    );

    await act(async () => {
      await result.current.start();
    });

    // User speech transcript completed
    act(() => {
      currentPC?._dc.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_u1",
          transcript: "Let's create a clinical trial review event",
        }),
      });
      // Assistant transcript: delta then done
      currentPC?._dc.onmessage?.({
        data: JSON.stringify({
          type: "response.audio_transcript.delta",
          response_id: "resp_1",
          delta: "Got it — filling the form ",
        }),
      });
      currentPC?._dc.onmessage?.({
        data: JSON.stringify({
          type: "response.audio_transcript.done",
          response_id: "resp_1",
          transcript: "Got it — filling the form now.",
        }),
      });
    });

    expect(result.current.transcript).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Let's create a clinical trial review event",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "Got it — filling the form now.",
      }),
    ]);
  });

  it("sets state=error with the OpenAI message when session minting fails", async () => {
    installFetchMock({
      session: () =>
        jsonResponse(
          { detail: "OPENAI_API_KEY is not configured on the backend." },
          401,
        ),
    });

    const { result } = renderHook(() =>
      useArchitectRealtime({ apiBase: "http://api.test" }),
    );

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("error");
    expect(result.current.error).toContain("OPENAI_API_KEY");
  });

  it("stop() closes the peer connection and the mic", async () => {
    installFetchMock({
      session: () =>
        jsonResponse({
          client_secret: "ek_x",
          expires_at: 1,
          model: "gpt-realtime",
          voice: "alloy",
        }),
      calls: () => new Response("v=0\nanswer", { status: 200 }),
    });

    const { result } = renderHook(() =>
      useArchitectRealtime({ apiBase: "http://api.test" }),
    );
    await act(async () => {
      await result.current.start();
    });
    const pc = currentPC!;
    const dc = pc._dc;

    act(() => result.current.stop());

    expect(pc.close).toHaveBeenCalled();
    expect(dc.close).toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    expect(result.current.listening).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — transcribeBlob
// ---------------------------------------------------------------------------

describe("transcribeBlob", () => {
  it("POSTs a blob to /architect/transcribe and returns the text", async () => {
    const f = installFetchMock({
      transcribe: () =>
        jsonResponse({ text: "Hello world", model: "whisper-1" }),
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const text = await transcribeBlob(blob, { apiBase: "http://api.test" });

    expect(text).toBe("Hello world");
    const call = f.mock.calls[0];
    expect(call[0]).toContain("/architect/transcribe");
    expect(call[1]?.method).toBe("POST");
    // Body must be FormData so the backend can parse the file part
    expect(call[1]?.body).toBeInstanceOf(FormData);
  });

  it("throws with the backend's detail message on failure", async () => {
    installFetchMock({
      transcribe: () =>
        jsonResponse({ detail: "Audio file too large: 26214400 bytes (max 26214400)." }, 413),
    });
    const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });
    await expect(
      transcribeBlob(blob, { apiBase: "http://api.test" }),
    ).rejects.toThrow(/Audio file too large/);
  });
});
