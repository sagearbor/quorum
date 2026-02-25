import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/mocks/server";
import ArchitectPage from "../page";
import { useArchitectStore } from "@/store/architect";

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Architect wizard flow", () => {
  beforeEach(() => {
    useArchitectStore.setState({
      step: 1,
      eventDraft: { name: "", slug: "", access_code: "", max_active_quorums: 5 },
      eventId: null,
      quorumDraft: {
        title: "",
        description: "",
        roles: [],
        dashboard_types: [],
        carousel_mode: "multi-view",
      },
      createdQuorums: [],
    });
  });

  it("renders step 1 by default", () => {
    render(<ArchitectPage />);
    expect(screen.getByLabelText(/event name/i)).toBeInTheDocument();
  });

  it("disables step 2 and 3 navigation until event is created", () => {
    render(<ArchitectPage />);
    const steps = screen.getAllByRole("button");
    // Step 2 and 3 buttons should be disabled
    const step2 = steps.find((b) => b.textContent?.includes("Define Quorums"));
    const step3 = steps.find((b) => b.textContent?.includes("Live Dashboard"));
    expect(step2).toBeDisabled();
    expect(step3).toBeDisabled();
  });

  it("advances to step 2 after event creation", async () => {
    const user = userEvent.setup();
    render(<ArchitectPage />);

    await user.type(screen.getByLabelText(/event name/i), "Test Event");
    await user.clear(screen.getByLabelText(/access code/i));
    await user.type(screen.getByLabelText(/access code/i), "TEST");
    await user.click(screen.getByRole("button", { name: /^create event →$/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/quorum title/i)).toBeInTheDocument();
    });
  });

  it("shows QR codes when slug is entered", async () => {
    const user = userEvent.setup();
    render(<ArchitectPage />);

    await user.type(screen.getByLabelText(/event name/i), "QR Test");

    await waitFor(() => {
      expect(screen.getByText(/station 1/i)).toBeInTheDocument();
    });
  });
});
