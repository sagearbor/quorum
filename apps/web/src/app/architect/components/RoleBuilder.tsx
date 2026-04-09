"use client";

import { useState } from "react";
import { useArchitectStore, type RoleDraft } from "@/store/architect";

const ROLE_COLORS = [
  "#3B82F6",
  "#EF4444",
  "#10B981",
  "#8B5CF6",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#84CC16",
  "#F97316",
  "#6366F1",
];

export function RoleBuilder() {
  const { quorumDraft, addRole, removeRole, updateRole } = useArchitectStore();
  const [newRoleName, setNewRoleName] = useState("");

  function handleAddRole() {
    if (!newRoleName.trim()) return;
    const role: RoleDraft = {
      id: `role-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: newRoleName.trim(),
      capacity: 1,
      authority_rank: quorumDraft.roles.length + 1,
      color: ROLE_COLORS[quorumDraft.roles.length % ROLE_COLORS.length],
      blocked_by: [],
    };
    addRole(role);
    setNewRoleName("");
  }

  function toggleDependency(roleId: string, depId: string) {
    const role = quorumDraft.roles.find((r) => r.id === roleId);
    if (!role) return;
    const current = role.blocked_by;
    const next = current.includes(depId)
      ? current.filter((id) => id !== depId)
      : [...current, depId];
    updateRole(roleId, { blocked_by: next });
  }

  function removeDependency(roleId: string, depId: string) {
    const role = quorumDraft.roles.find((r) => r.id === roleId);
    if (!role) return;
    updateRole(roleId, { blocked_by: role.blocked_by.filter((id) => id !== depId) });
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Roles</h4>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={newRoleName}
          onChange={(e) => setNewRoleName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAddRole();
            }
          }}
          placeholder="Role name (e.g. IRB Representative)"
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-800 dark:text-gray-100"
          aria-label="New role name"
        />
        <button
          type="button"
          onClick={handleAddRole}
          disabled={!newRoleName.trim()}
          className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm font-medium hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          + Add
        </button>
      </div>

      {quorumDraft.roles.length > 0 && (
        <div className="space-y-2">
          {quorumDraft.roles.map((role) => {
            const otherRoles = quorumDraft.roles.filter((r) => r.id !== role.id);
            const depNames = role.blocked_by
              .map((id) => quorumDraft.roles.find((r) => r.id === id))
              .filter(Boolean) as RoleDraft[];

            return (
              <div
                key={role.id}
                className="px-3 py-2 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={role.color}
                    onChange={(e) => updateRole(role.id, { color: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer border-0"
                    title="Pick color"
                  />
                  <span className="flex-1 text-sm font-medium">{role.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      updateRole(role.id, {
                        capacity: role.capacity === 1 ? "unlimited" : 1,
                      })
                    }
                    className="text-lg px-2 py-0.5 rounded hover:bg-gray-200 transition-colors"
                    title={
                      role.capacity === 1
                        ? "Single person — click for committee"
                        : "Committee — click for single"
                    }
                  >
                    {role.capacity === 1 ? "\u{1F464}" : "\u{1F465}"}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRole(role.id)}
                    className="text-red-400 hover:text-red-600 text-sm px-1"
                    title="Remove role"
                  >
                    ✕
                  </button>
                </div>

                {/* Depends-on selector */}
                {otherRoles.length > 0 && (
                  <div className="mt-2 ml-9">
                    <label className="text-xs text-gray-600 dark:text-gray-300 block mb-1">Depends on:</label>
                    <select
                      className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 dark:bg-gray-800 dark:text-gray-100"
                      value=""
                      aria-label={`Add dependency for ${role.name}`}
                      onChange={(e) => {
                        if (e.target.value) toggleDependency(role.id, e.target.value);
                        e.target.value = "";
                      }}
                    >
                      <option value="">Select a role...</option>
                      {otherRoles
                        .filter((r) => !role.blocked_by.includes(r.id))
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </select>

                    {/* Dependency tags */}
                    {depNames.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {depNames.map((dep) => (
                          <span
                            key={dep.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-800 text-xs rounded-full"
                          >
                            {dep.name}
                            <button
                              type="button"
                              onClick={() => removeDependency(role.id, dep.id)}
                              className="hover:text-red-600"
                              aria-label={`Remove dependency on ${dep.name}`}
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
