import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { server } from "./server";

describe("MSW handlers", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  const API_BASE = "http://localhost:8000";

  it("GET /events/:slug returns mock event", async () => {
    const res = await fetch(`${API_BASE}/events/duke-expo-2026`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.slug).toBe("duke-expo-2026");
    expect(data.name).toBe("Duke Clinical Trial Expo 2026");
  });

  it("GET /events/:slug returns 404 for unknown slug", async () => {
    const res = await fetch(`${API_BASE}/events/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("GET /events/:eventId/quorums returns quorum list", async () => {
    const res = await fetch(`${API_BASE}/events/evt-001/quorums`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveLength(3);
    expect(data[0].title).toContain("IRB");
  });

  it("GET /quorums/:id/state returns quorum state", async () => {
    const res = await fetch(`${API_BASE}/quorums/q-001/state`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.quorum.id).toBe("q-001");
    expect(data.health_score).toBe(72);
    expect(data.active_roles.length).toBeGreaterThan(0);
    expect(data.contributions.length).toBeGreaterThan(0);
  });

  it("GET /quorums/:id/roles returns roles", async () => {
    const res = await fetch(`${API_BASE}/quorums/q-001/roles`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveLength(3);
    expect(data[0].name).toBe("IRB Chair");
  });

  it("POST /quorums/:id/contribute returns contribution ID", async () => {
    const res = await fetch(`${API_BASE}/quorums/q-001/contribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role_id: "r-001",
        user_token: "test",
        content: "test contribution",
        structured_fields: { safety_assessment: "looks good" },
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.contribution_id).toBeTruthy();
    expect(data.tier_processed).toBe(1);
  });

  it("POST /events creates a new event", async () => {
    const res = await fetch(`${API_BASE}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Event",
        slug: "test-event",
        access_code: "TEST",
        max_active_quorums: 3,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.slug).toBe("test-event");
  });
});
