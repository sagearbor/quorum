"use client";

import { useRouter } from "next/navigation";
import { useArchitectStore } from "@/store/architect";
import { RoleBuilder } from "./RoleBuilder";
import { AuthorityStack } from "./AuthorityStack";
import { DashboardSelector } from "./DashboardSelector";
import type { Quorum, Role } from "@quorum/types";

export function CreateQuorumForm() {
  const router = useRouter();
  const {
    quorumDraft,
    setQuorumDraft,
    eventId,
    eventDraft,
    addCreatedQuorum,
    resetQuorumDraft,
    setStep,
  } = useArchitectStore();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!eventId) return;

    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    const res = await fetch(`${apiBase}/events/${eventId}/quorums`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: quorumDraft.title,
        description: quorumDraft.description,
        roles: quorumDraft.roles.map((r) => ({
          name: r.name,
          capacity: r.capacity,
          authority_rank: r.authority_rank,
          prompt_template: [],
          fallback_chain: [],
          blocked_by: r.blocked_by.map((depId) =>
            String(quorumDraft.roles.findIndex((role) => role.id === depId))
          ),
        })),
        dashboard_types: quorumDraft.dashboard_types,
        carousel_mode: quorumDraft.carousel_mode,
        autonomy_level: quorumDraft.autonomy_level,
      }),
    });
    if (!res.ok) return;
    const data = await res.json();

    const quorum: Quorum & { roles: Role[] } = {
      id: data.id,
      event_id: eventId,
      title: quorumDraft.title,
      description: quorumDraft.description,
      status: "open",
      heat_score: 0,
      carousel_mode: quorumDraft.carousel_mode,
      dashboard_types: quorumDraft.dashboard_types,
      autonomy_level: quorumDraft.autonomy_level,
      created_at: new Date().toISOString(),
      roles: quorumDraft.roles.map((r) => ({
        id: `${data.id}-${r.id}`,
        quorum_id: data.id,
        name: r.name,
        capacity: r.capacity,
        authority_rank: r.authority_rank,
        prompt_template: [],
        fallback_chain: [],
        color: r.color,
      })),
    };

    addCreatedQuorum(quorum);
    resetQuorumDraft();

    // Navigate to the newly created quorum page
    const slug = eventDraft.slug;
    if (slug && data.id) {
      router.push(`/event/${slug}/quorum/${data.id}`);
    }
  }

  const isValid =
    quorumDraft.title.trim() !== "" &&
    quorumDraft.roles.length > 0 &&
    quorumDraft.dashboard_types.length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div className="space-y-4">
        <div>
          <label
            htmlFor="quorum-title"
            className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
          >
            Quorum Title
          </label>
          <input
            id="quorum-title"
            type="text"
            value={quorumDraft.title}
            onChange={(e) => setQuorumDraft({ title: e.target.value })}
            placeholder="Protocol Amendment Review"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            required
          />
        </div>
        <div>
          <label
            htmlFor="quorum-description"
            className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
          >
            Description
          </label>
          <textarea
            id="quorum-description"
            value={quorumDraft.description}
            onChange={(e) => setQuorumDraft({ description: e.target.value })}
            placeholder="Describe what this quorum will address..."
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      <div className="border-t border-gray-200 pt-6">
        <RoleBuilder />
      </div>

      <div className="border-t border-gray-200 pt-6">
        <AuthorityStack />
      </div>

      <div className="border-t border-gray-200 pt-6">
        <DashboardSelector />
      </div>

      <div className="border-t border-gray-200 pt-6">
        <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
          Agent Autonomy Level
        </label>
        <div className="space-y-2">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={quorumDraft.autonomy_level}
              onChange={(e) =>
                setQuorumDraft({ autonomy_level: parseFloat(e.target.value) })
              }
              className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <span className="text-lg font-semibold text-blue-600 w-10 text-right tabular-nums">
              {quorumDraft.autonomy_level.toFixed(1)}
            </span>
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>Human Only</span>
            <span>Human-Led</span>
            <span>Collaborative</span>
            <span>Agent-Led</span>
            <span>Autonomous</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Controls how proactively AI agents communicate via A2A.
            At 0 agents only respond to humans. At 1.0 agents autonomously solve the problem.
          </p>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={!isValid}
          className="flex-1 py-2.5 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Create Quorum
        </button>
        <button
          type="button"
          onClick={() => setStep(3)}
          className="py-2.5 px-4 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200 transition-colors"
        >
          View Dashboard &rarr;
        </button>
      </div>
    </form>
  );
}
