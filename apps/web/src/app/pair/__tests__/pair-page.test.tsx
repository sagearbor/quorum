/**
 * Tests for the /pair landing page (10.4 → 10.5).
 *
 * The page mints a participant_id by POSTing /sessions/participant,
 * resolves the role_id for the station via /quorums/<id>/roles, stashes
 * the bundle in sessionStorage, then redirects to
 * `/agent/<role_id>?ds=<participant_id>`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// --- Mocks --------------------------------------------------------------

const replaceMock = vi.fn();
const searchParams = new URLSearchParams({
  qr: "quorum-abc",
  st: "station-2",
});

// Stable router/searchParams objects so useEffect deps don't change identity
// across renders (which would re-fire the mint forever).
const stableRouter = { replace: replaceMock, push: vi.fn(), back: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
  useSearchParams: () => searchParams,
  usePathname: () => "/pair",
}));

import PairPage from "../page";

// --- Tests --------------------------------------------------------------

describe("/pair", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    window.sessionStorage.clear();
  });

  it("mints a participant_id, resolves a role_id, and redirects to /agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/sessions/participant")) {
        return new Response(
          JSON.stringify({
            participant_id: "pid-123",
            display_name: "Visitor 1",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/quorums/quorum-abc/roles")) {
        return new Response(
          JSON.stringify([
            { id: "role-medical", authority_rank: 3 },
            { id: "role-ethics", authority_rank: 2 },
            { id: "role-patient", authority_rank: 1 },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    // @ts-expect-error — overriding global fetch for the test
    global.fetch = fetchMock;

    render(<PairPage />);

    await waitFor(() => {
      const raw = window.sessionStorage.getItem("quorum.participant");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.participant_id).toBe("pid-123");
      // station-2 → index 1 → role-ethics
      expect(parsed.role_id).toBe("role-ethics");
    });

    expect(screen.getByText(/Welcome, Visitor 1/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledTimes(1);
    });
    const target = replaceMock.mock.calls[0][0] as string;
    expect(target).toBe("/agent/role-ethics?ds=pid-123");
  });

  it("shows an error when the participant endpoint returns 404", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("not found", { status: 404 }),
    );
    // @ts-expect-error — overriding global fetch for the test
    global.fetch = fetchMock;

    render(<PairPage />);

    await waitFor(() => {
      expect(screen.getByText(/Pairing failed/i)).toBeInTheDocument();
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
