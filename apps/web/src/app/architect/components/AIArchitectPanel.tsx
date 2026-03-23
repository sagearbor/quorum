"use client";

import { useState } from "react";
import { useArchitectStore } from "@/store/architect";

interface RoleSuggestion {
  name: string;
  description: string;
  authority_rank: number;
  capacity: string | number;
  suggested_prompt_focus: string;
}

const RANK_COLORS: Record<number, string> = {
  1: "bg-gray-100 text-gray-700",
  2: "bg-blue-100 text-blue-700",
  3: "bg-yellow-100 text-yellow-700",
  4: "bg-orange-100 text-orange-700",
  5: "bg-red-100 text-red-700",
};

export function AIArchitectPanel() {
  const { eventId } = useArchitectStore();

  const [problem, setProblem] = useState("");
  const [mode, setMode] = useState<"auto" | "approved">("approved");
  const [roles, setRoles] = useState<RoleSuggestion[]>([]);
  const [quorumTitle, setQuorumTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

  async function handleGenerate() {
    if (!eventId || !problem.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${apiBase}/events/${eventId}/architect/generate-roles`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problem }),
        }
      );
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || "Failed to generate roles");
      }
      const data = await res.json();
      setRoles(data.roles);
      if (!quorumTitle) {
        setQuorumTitle(data.problem_summary);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleStart() {
    if (!eventId || roles.length === 0 || !quorumTitle.trim()) return;
    setStarting(true);
    setError(null);

    try {
      const res = await fetch(
        `${apiBase}/events/${eventId}/architect/ai-start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            problem,
            roles,
            mode,
            quorum_title: quorumTitle,
          }),
        }
      );
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || "Failed to start quorum");
      }
      const data = await res.json();
      window.location.href = data.share_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Start failed");
    } finally {
      setStarting(false);
    }
  }

  function updateRole(index: number, updates: Partial<RoleSuggestion>) {
    setRoles((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...updates } : r))
    );
  }

  function removeRole(index: number) {
    setRoles((prev) => prev.filter((_, i) => i !== index));
  }

  function addBlankRole() {
    setRoles((prev) => [
      ...prev,
      {
        name: "",
        description: "",
        authority_rank: 1,
        capacity: "unlimited",
        suggested_prompt_focus: "",
      },
    ]);
  }

  return (
    <div className="space-y-6">
      {/* Problem input */}
      <div>
        <label
          htmlFor="ai-problem"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Problem Description
        </label>
        <textarea
          id="ai-problem"
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
          placeholder="Describe the problem or decision this quorum needs to address..."
          rows={5}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y"
        />
      </div>

      {/* Mode selection */}
      <fieldset>
        <legend className="text-sm font-medium text-gray-700 mb-2">
          Start Mode
        </legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="ai-mode"
              value="auto"
              checked={mode === "auto"}
              onChange={() => setMode("auto")}
              className="text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">
              Auto-start — trust the AI
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="ai-mode"
              value="approved"
              checked={mode === "approved"}
              onChange={() => setMode("approved")}
              className="text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">
              Review roles before starting
            </span>
          </label>
        </div>
      </fieldset>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={loading || !problem.trim() || !eventId}
        className="w-full py-2.5 px-4 bg-purple-600 text-white font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg
              className="animate-spin h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Generating roles...
          </span>
        ) : (
          "Generate Roles"
        )}
      </button>

      {/* Error display */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Role cards */}
      {roles.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-700">
              Suggested Roles ({roles.length})
            </h3>
            <button
              type="button"
              onClick={addBlankRole}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              + Add Role
            </button>
          </div>

          {roles.map((role, idx) => (
            <div
              key={idx}
              className="border border-gray-200 rounded-lg p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <input
                  type="text"
                  value={role.name}
                  onChange={(e) => updateRole(idx, { name: e.target.value })}
                  placeholder="Role name"
                  className="flex-1 px-2 py-1 border border-gray-200 rounded text-sm font-medium focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
                <span
                  className={`px-2 py-0.5 rounded text-xs font-bold ${RANK_COLORS[role.authority_rank] || RANK_COLORS[1]}`}
                >
                  Rank {role.authority_rank}
                </span>
                <button
                  type="button"
                  onClick={() => removeRole(idx)}
                  className="text-gray-400 hover:text-red-500 text-sm"
                  aria-label={`Remove ${role.name || "role"}`}
                >
                  &times;
                </button>
              </div>
              <textarea
                value={role.description}
                onChange={(e) =>
                  updateRole(idx, { description: e.target.value })
                }
                placeholder="Role description"
                rows={2}
                className="w-full px-2 py-1 border border-gray-200 rounded text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y"
              />
              <div className="text-xs text-gray-500">
                Focus: {role.suggested_prompt_focus || "—"}
              </div>
            </div>
          ))}

          {/* Quorum title */}
          <div>
            <label
              htmlFor="quorum-title-ai"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Quorum Title
            </label>
            <input
              id="quorum-title-ai"
              type="text"
              value={quorumTitle}
              onChange={(e) => setQuorumTitle(e.target.value)}
              placeholder="Title for this quorum"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Start button */}
          <button
            onClick={handleStart}
            disabled={
              starting || roles.length === 0 || !quorumTitle.trim()
            }
            className="w-full py-2.5 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {starting
              ? "Starting..."
              : mode === "auto"
                ? "Start Quorum"
                : "Approve & Start"}
          </button>
        </div>
      )}
    </div>
  );
}
