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
    };
    addRole(role);
    setNewRoleName("");
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-2">Roles</h4>

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
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
          {quorumDraft.roles.map((role) => (
            <div
              key={role.id}
              className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200"
            >
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
                {role.capacity === 1 ? "👤" : "👥"}
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
          ))}
        </div>
      )}
    </div>
  );
}
