import { create } from "zustand";
import type {
  DashboardType,
  CarouselMode,
  Quorum,
  Role,
  RoleCapacity,
} from "@quorum/types";

export interface RoleDraft {
  id: string;
  name: string;
  capacity: RoleCapacity;
  authority_rank: number;
  color: string;
  blocked_by: string[]; // IDs of other RoleDrafts this role depends on
}

export interface QuorumDraft {
  title: string;
  description: string;
  roles: RoleDraft[];
  dashboard_types: DashboardType[];
  carousel_mode: CarouselMode;
  autonomy_level: number;
}

export interface EventDraft {
  name: string;
  slug: string;
  access_code: string;
  max_active_quorums: number;
}

export interface RoleSuggestion {
  name: string;
  description: string;
  authority_rank: number;
  capacity: string | number;
  suggested_prompt_focus: string;
}

export interface ArchitectState {
  step: number;
  eventDraft: EventDraft;
  eventId: string | null;
  quorumDraft: QuorumDraft;
  createdQuorums: Array<Quorum & { roles: Role[] }>;
  aiMode: boolean;
  problemDescription: string;
  generatedRoles: RoleSuggestion[];

  setStep: (step: number) => void;
  setEventDraft: (draft: Partial<EventDraft>) => void;
  setEventId: (id: string) => void;
  setQuorumDraft: (draft: Partial<QuorumDraft>) => void;
  addRole: (role: RoleDraft) => void;
  removeRole: (id: string) => void;
  updateRole: (id: string, updates: Partial<RoleDraft>) => void;
  reorderRoles: (roles: RoleDraft[]) => void;
  addCreatedQuorum: (quorum: Quorum & { roles: Role[] }) => void;
  resetQuorumDraft: () => void;
  setAIMode: (aiMode: boolean) => void;
  setProblemDescription: (problem: string) => void;
  setGeneratedRoles: (roles: RoleSuggestion[]) => void;
}

const defaultQuorumDraft: QuorumDraft = {
  title: "",
  description: "",
  roles: [],
  dashboard_types: [],
  carousel_mode: "multi-view",
  autonomy_level: 0.0,
};

export const useArchitectStore = create<ArchitectState>((set) => ({
  step: 1,
  eventDraft: { name: "", slug: "", access_code: "", max_active_quorums: 5 },
  eventId: null,
  quorumDraft: { ...defaultQuorumDraft },
  createdQuorums: [],
  aiMode: false,
  problemDescription: "",
  generatedRoles: [],

  setStep: (step) => set({ step }),
  setEventDraft: (draft) =>
    set((state) => ({ eventDraft: { ...state.eventDraft, ...draft } })),
  setEventId: (id) => set({ eventId: id }),
  setQuorumDraft: (draft) =>
    set((state) => ({ quorumDraft: { ...state.quorumDraft, ...draft } })),
  addRole: (role) =>
    set((state) => ({
      quorumDraft: {
        ...state.quorumDraft,
        roles: [...state.quorumDraft.roles, role],
      },
    })),
  removeRole: (id) =>
    set((state) => ({
      quorumDraft: {
        ...state.quorumDraft,
        roles: state.quorumDraft.roles.filter((r) => r.id !== id),
      },
    })),
  updateRole: (id, updates) =>
    set((state) => ({
      quorumDraft: {
        ...state.quorumDraft,
        roles: state.quorumDraft.roles.map((r) =>
          r.id === id ? { ...r, ...updates } : r
        ),
      },
    })),
  reorderRoles: (roles) =>
    set((state) => ({
      quorumDraft: { ...state.quorumDraft, roles },
    })),
  addCreatedQuorum: (quorum) =>
    set((state) => ({
      createdQuorums: [...state.createdQuorums, quorum],
    })),
  resetQuorumDraft: () => set({ quorumDraft: { ...defaultQuorumDraft } }),
  setAIMode: (aiMode) => set({ aiMode }),
  setProblemDescription: (problemDescription) => set({ problemDescription }),
  setGeneratedRoles: (generatedRoles) => set({ generatedRoles }),
}));
