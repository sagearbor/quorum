"use client";

import { useEffect, useState, useCallback } from "react";

interface Insight {
  id: string;
  source_role_id: string;
  insight_type: string;
  content: string;
  tags?: string[];
  created_at: string;
}

interface StationMsg {
  id: string;
  role_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tags?: string[];
  created_at: string;
}

interface AgentActivity {
  id: string;
  type: "insight" | "agent_message" | "a2a_request";
  roleName: string;
  roleColor: string;
  content: string;
  tags: string[];
  timestamp: string;
}

interface Props {
  quorumId: string;
  roles: Array<{ id: string; name: string; color?: string }>;
  visible: boolean;
  onToggle: () => void;
}

export function AgentActivityFeed({ quorumId, roles, visible, onToggle }: Props) {
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchActivity = useCallback(async () => {
    const roleMap = new Map(roles.map((r) => [r.id, r]));
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    try {
      setLoading(true);

      // Fetch insights and agent station messages in parallel
      const [insightsRes, ...msgResults] = await Promise.all([
        fetch(`${apiBase}/quorums/${quorumId}/insights`).then((r) => r.ok ? r.json() : []),
        // Fetch messages from auto-stations (autonomy loop stations)
        ...roles.map((role) =>
          fetch(`${apiBase}/quorums/${quorumId}/stations/auto-${role.id.slice(0, 8)}/messages`)
            .then((r) => r.ok ? r.json() : [])
            .catch(() => [])
        ),
      ]);

      const items: AgentActivity[] = [];

      // Add insights
      for (const ins of (insightsRes as Insight[]) || []) {
        const role = roleMap.get(ins.source_role_id);
        items.push({
          id: `insight-${ins.id}`,
          type: "insight",
          roleName: role?.name ?? "Agent",
          roleColor: role?.color ?? "#6b7280",
          content: ins.content,
          tags: ins.tags ?? [],
          timestamp: ins.created_at,
        });
      }

      // Add agent messages (assistant only)
      for (let i = 0; i < roles.length; i++) {
        const role = roles[i];
        const msgs = (msgResults[i] as StationMsg[]) || [];
        for (const msg of msgs) {
          if (msg.role !== "assistant") continue;
          items.push({
            id: `msg-${msg.id}`,
            type: "agent_message",
            roleName: role.name,
            roleColor: role.color ?? "#6b7280",
            content: msg.content,
            tags: msg.tags ?? [],
            timestamp: msg.created_at,
          });
        }
      }

      // Sort by timestamp descending
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Deduplicate: agent messages often overlap with insights (same content)
      const seen = new Set<string>();
      const unique = items.filter((item) => {
        const key = `${item.roleName}-${item.content.slice(0, 80)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      setActivities(unique.slice(0, 50));
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [quorumId, roles]);

  // Initial fetch + auto-refresh
  useEffect(() => {
    if (!visible) return;
    fetchActivity();
    if (!autoRefresh) return;
    const interval = setInterval(fetchActivity, 5000);
    return () => clearInterval(interval);
  }, [visible, autoRefresh, fetchActivity]);

  const typeIcon: Record<string, string> = {
    insight: "\u26A1",
    agent_message: "\u{1F4AC}",
    a2a_request: "\u{1F501}",
  };

  const typeLabel: Record<string, string> = {
    insight: "Insight",
    agent_message: "Message",
    a2a_request: "A2A Request",
  };

  return (
    <div>
      {/* Toggle button */}
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        Agent Activity {activities.length > 0 && `(${activities.length})`}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`transition-transform ${visible ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {visible && (
        <div className="mt-2 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden max-h-[400px] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
              {loading ? "Refreshing..." : `${activities.length} activities`}
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="w-3 h-3 rounded accent-indigo-600"
                />
                Auto-refresh
              </label>
              <button
                type="button"
                onClick={fetchActivity}
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Activity list */}
          <div className="overflow-y-auto flex-1 divide-y divide-gray-100 dark:divide-gray-800">
            {activities.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400 dark:text-gray-500">
                {loading ? "Loading agent activity..." : "No agent activity yet. Agents will appear here when autonomy > 0."}
              </div>
            ) : (
              activities.map((activity) => (
                <div key={activity.id} className="px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs">{typeIcon[activity.type] ?? ""}</span>
                    <span
                      className="text-xs font-semibold px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: `${activity.roleColor}15`,
                        color: activity.roleColor,
                      }}
                    >
                      {activity.roleName}
                    </span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">
                      {typeLabel[activity.type]}
                    </span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-auto">
                      {new Date(activity.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-xs text-gray-700 dark:text-gray-300 line-clamp-3 leading-relaxed">
                    {activity.content}
                  </p>
                  {activity.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {activity.tags.slice(0, 5).map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
