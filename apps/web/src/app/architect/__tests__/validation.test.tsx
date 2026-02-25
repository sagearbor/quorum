import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateEventForm } from "../components/CreateEventForm";
import { useArchitectStore } from "@/store/architect";

describe("CreateEventForm validation", () => {
  beforeEach(() => {
    useArchitectStore.setState({
      step: 1,
      eventDraft: { name: "", slug: "", access_code: "", max_active_quorums: 5 },
      eventId: null,
    });
  });

  it("disables submit button when form is empty", () => {
    render(<CreateEventForm />);
    const button = screen.getByRole("button", { name: /create event/i });
    expect(button).toBeDisabled();
  });

  it("enables submit button when all fields are filled", async () => {
    const user = userEvent.setup();
    render(<CreateEventForm />);

    await user.type(screen.getByLabelText(/event name/i), "Test Event");
    await user.clear(screen.getByLabelText(/access code/i));
    await user.type(screen.getByLabelText(/access code/i), "TEST123");

    const button = screen.getByRole("button", { name: /create event/i });
    expect(button).toBeEnabled();
  });

  it("auto-generates slug from name", async () => {
    const user = userEvent.setup();
    render(<CreateEventForm />);

    await user.type(screen.getByLabelText(/event name/i), "My Cool Event");

    const slugInput = screen.getByLabelText(/slug/i) as HTMLInputElement;
    expect(slugInput.value).toBe("my-cool-event");
  });

  it("uppercases access code", async () => {
    const user = userEvent.setup();
    render(<CreateEventForm />);

    await user.type(screen.getByLabelText(/access code/i), "abc123");

    const codeInput = screen.getByLabelText(/access code/i) as HTMLInputElement;
    expect(codeInput.value).toBe("ABC123");
  });
});
