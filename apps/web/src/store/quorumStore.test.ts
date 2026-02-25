import { describe, it, expect, beforeEach } from "vitest";
import { useQuorumStore } from "./quorumStore";
import { mockEvent, mockQuorums, quorum1Roles } from "@/lib/mockData";
import type { Contribution } from "@quorum/types";

describe("quorumStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useQuorumStore.setState({
      currentEvent: null,
      currentQuorum: null,
      currentRole: null,
      stationDefault: null,
      quorums: [],
      roles: {},
      contributions: [],
      activeRoles: [],
      healthScore: 0,
      pendingContributions: [],
    });
  });

  it("sets current event", () => {
    useQuorumStore.getState().setCurrentEvent(mockEvent);
    expect(useQuorumStore.getState().currentEvent).toEqual(mockEvent);
  });

  it("sets quorums list", () => {
    useQuorumStore.getState().setQuorums(mockQuorums);
    expect(useQuorumStore.getState().quorums).toHaveLength(3);
  });

  it("sets roles for a quorum", () => {
    useQuorumStore.getState().setRolesForQuorum("q-001", quorum1Roles);
    expect(useQuorumStore.getState().roles["q-001"]).toHaveLength(3);
    expect(useQuorumStore.getState().roles["q-001"][0].name).toBe("IRB Chair");
  });

  it("sets station default", () => {
    useQuorumStore.getState().setStationDefault(3);
    expect(useQuorumStore.getState().stationDefault).toBe(3);
  });

  it("manages optimistic contributions", () => {
    const contribution: Contribution = {
      id: "temp-1",
      quorum_id: "q-001",
      role_id: "r-001",
      user_token: "test",
      content: "test content",
      structured_fields: {},
      tier_processed: 1,
      created_at: new Date().toISOString(),
    };

    // Add optimistic
    useQuorumStore.getState().addOptimisticContribution(contribution);
    expect(useQuorumStore.getState().contributions).toHaveLength(1);
    expect(useQuorumStore.getState().pendingContributions).toHaveLength(1);

    // Confirm
    useQuorumStore.getState().confirmContribution("temp-1", "real-1");
    expect(useQuorumStore.getState().contributions[0].id).toBe("real-1");
    expect(useQuorumStore.getState().pendingContributions).toHaveLength(0);
  });

  it("removes optimistic contribution on failure", () => {
    const contribution: Contribution = {
      id: "temp-2",
      quorum_id: "q-001",
      role_id: "r-001",
      user_token: "test",
      content: "test",
      structured_fields: {},
      tier_processed: 1,
      created_at: new Date().toISOString(),
    };

    useQuorumStore.getState().addOptimisticContribution(contribution);
    expect(useQuorumStore.getState().contributions).toHaveLength(1);

    useQuorumStore.getState().removeOptimisticContribution("temp-2");
    expect(useQuorumStore.getState().contributions).toHaveLength(0);
    expect(useQuorumStore.getState().pendingContributions).toHaveLength(0);
  });

  it("sets health score", () => {
    useQuorumStore.getState().setHealthScore(85);
    expect(useQuorumStore.getState().healthScore).toBe(85);
  });

  it("sets active roles", () => {
    const activeRoles = [
      { role_id: "r-001", participant_count: 2 },
      { role_id: "r-002", participant_count: 1 },
    ];
    useQuorumStore.getState().setActiveRoles(activeRoles);
    expect(useQuorumStore.getState().activeRoles).toHaveLength(2);
  });
});
