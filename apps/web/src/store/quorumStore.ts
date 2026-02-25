"use client";

import { create } from "zustand";

import type {
  Event,
  Quorum,
  Role,
  Contribution,
  ActiveRole,
} from "@quorum/types";

interface QuorumStore {
  // Current context
  currentEvent: Event | null;
  currentQuorum: Quorum | null;
  currentRole: Role | null;
  stationDefault: number | null;

  // Data
  quorums: Quorum[];
  roles: Record<string, Role[]>; // keyed by quorum_id
  contributions: Contribution[];
  activeRoles: ActiveRole[];
  healthScore: number;

  // Optimistic contributions (pending server confirmation)
  pendingContributions: Contribution[];

  // Actions
  setCurrentEvent: (event: Event) => void;
  setCurrentQuorum: (quorum: Quorum | null) => void;
  setCurrentRole: (role: Role | null) => void;
  setStationDefault: (station: number | null) => void;
  setQuorums: (quorums: Quorum[]) => void;
  setRolesForQuorum: (quorumId: string, roles: Role[]) => void;
  setContributions: (contributions: Contribution[]) => void;
  setActiveRoles: (activeRoles: ActiveRole[]) => void;
  setHealthScore: (score: number) => void;
  addOptimisticContribution: (contribution: Contribution) => void;
  confirmContribution: (tempId: string, realId: string) => void;
  removeOptimisticContribution: (tempId: string) => void;
}

export const useQuorumStore = create<QuorumStore>((set) => ({
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

  setCurrentEvent: (event) => set({ currentEvent: event }),
  setCurrentQuorum: (quorum) => set({ currentQuorum: quorum }),
  setCurrentRole: (role) => set({ currentRole: role }),
  setStationDefault: (station) => set({ stationDefault: station }),
  setQuorums: (quorums) => set({ quorums }),
  setRolesForQuorum: (quorumId, roles) =>
    set((state) => ({
      roles: { ...state.roles, [quorumId]: roles },
    })),
  setContributions: (contributions) => set({ contributions }),
  setActiveRoles: (activeRoles) => set({ activeRoles }),
  setHealthScore: (score) => set({ healthScore: score }),

  addOptimisticContribution: (contribution) =>
    set((state) => ({
      pendingContributions: [...state.pendingContributions, contribution],
      contributions: [...state.contributions, contribution],
    })),

  confirmContribution: (tempId, realId) =>
    set((state) => ({
      pendingContributions: state.pendingContributions.filter(
        (c) => c.id !== tempId
      ),
      contributions: state.contributions.map((c) =>
        c.id === tempId ? { ...c, id: realId } : c
      ),
    })),

  removeOptimisticContribution: (tempId) =>
    set((state) => ({
      pendingContributions: state.pendingContributions.filter(
        (c) => c.id !== tempId
      ),
      contributions: state.contributions.filter((c) => c.id !== tempId),
    })),
}));
