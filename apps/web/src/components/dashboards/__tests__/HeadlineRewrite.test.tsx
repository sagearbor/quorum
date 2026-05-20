import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HeadlineRewrite } from "../HeadlineRewrite";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/dataProvider", () => ({
  getQuorum: vi.fn(async () => ({
    id: "q-1",
    title: "Original quorum framing — should we lower the eGFR threshold?",
    roles: [
      { id: "role-irb", name: "IRB Officer", color: "#f87171" },
      { id: "role-pi", name: "Principal Investigator", color: "#60a5fa" },
    ],
  })),
}));

beforeEach(() => {
  // Ensure no API base is set so we exercise the fallback path
  // (no /before-after endpoint hit).
  delete (process.env as Record<string, string | undefined>).NEXT_PUBLIC_API_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HeadlineRewrite", () => {
  it("renders without error with a static snapshot containing a final_position", () => {
    render(
      <HeadlineRewrite
        quorumId="q-1"
        staticData={{
          snapshot: {
            original_question: "Should we lower the eGFR threshold?",
            final_position: {
              headline: "Quorum endorses lowering eGFR threshold to 45",
              summary_sentences: [
                "After two rounds of deliberation, the quorum recommended lowering the eGFR threshold to expand the eligible patient pool while preserving safety guarantees.",
              ],
            },
            roles: [
              { id: "role-irb", name: "IRB Officer", color: "#f87171" },
              { id: "role-pi", name: "Principal Investigator", color: "#60a5fa" },
            ],
          },
        }}
      />,
    );

    // Root container present
    expect(screen.getByTestId("headline-rewrite")).toBeTruthy();
    // Status pill should report "Resolved"
    expect(screen.getByTestId("headline-rewrite-status").textContent).toMatch(/resolved/i);
    // Byline lists the roles
    expect(screen.getByTestId("headline-rewrite-byline-role-role-irb")).toBeTruthy();
    expect(screen.getByTestId("headline-rewrite-byline-role-role-pi")).toBeTruthy();
  });

  it("falls back to the quorum title when no snapshot exists", async () => {
    render(<HeadlineRewrite quorumId="q-1" />);

    // The Loading state appears first, then the resolved title.
    await waitFor(() => {
      expect(screen.getByTestId("headline-rewrite")).toBeTruthy();
    });

    // Status pill should report "Deliberating" since no final_position.
    expect(screen.getByTestId("headline-rewrite-status").textContent).toMatch(
      /deliberating/i,
    );

    // The current headline should contain the quorum.title text.
    const current = screen.getByTestId("headline-rewrite-current");
    expect(current.textContent).toContain("Original quorum framing");

    // Awaiting-resolution caption should be present.
    expect(screen.getByTestId("headline-rewrite-awaiting")).toBeTruthy();
  });
});
