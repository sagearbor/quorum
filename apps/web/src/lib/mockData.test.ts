import { describe, it, expect } from "vitest";
import {
  mockEvent,
  mockQuorums,
  mockRolesByQuorum,
  mockActiveRoles,
  mockContributions,
  stationRoleMap,
} from "./mockData";

describe("mockData", () => {
  it("has a valid event with required fields", () => {
    expect(mockEvent.id).toBeTruthy();
    expect(mockEvent.slug).toBe("duke-expo-2026");
    expect(mockEvent.max_active_quorums).toBe(5);
  });

  it("has 3 quorums with different statuses", () => {
    expect(mockQuorums).toHaveLength(3);
    const statuses = mockQuorums.map((q) => q.status);
    expect(statuses).toContain("active");
    expect(statuses).toContain("open");
  });

  it("each quorum has roles with prompt templates", () => {
    for (const quorum of mockQuorums) {
      const roles = mockRolesByQuorum[quorum.id];
      expect(roles).toBeDefined();
      expect(roles.length).toBeGreaterThanOrEqual(2);

      for (const role of roles) {
        expect(role.quorum_id).toBe(quorum.id);
        expect(role.prompt_template.length).toBeGreaterThan(0);
        expect(role.color).toMatch(/^#/);
        expect(role.authority_rank).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("active roles have participant counts", () => {
    for (const quorum of mockQuorums) {
      const active = mockActiveRoles[quorum.id];
      expect(active).toBeDefined();
      expect(active.length).toBeGreaterThan(0);
    }
  });

  it("has contributions linked to valid roles and quorums", () => {
    for (const c of mockContributions) {
      expect(mockQuorums.some((q) => q.id === c.quorum_id)).toBe(true);
      const roles = mockRolesByQuorum[c.quorum_id];
      expect(roles.some((r) => r.id === c.role_id)).toBe(true);
    }
  });

  it("station role map maps station numbers to role IDs", () => {
    expect(stationRoleMap[1]).toBe("r-001");
    expect(stationRoleMap[3]).toBe("r-003");
  });
});
