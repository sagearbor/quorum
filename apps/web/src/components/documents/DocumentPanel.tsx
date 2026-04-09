"use client";

/**
 * DocumentPanel — renders the list of agent-maintained documents for a quorum.
 *
 * Features:
 * - Card-per-document with status badge, version, last-edited time
 * - Click to expand inline viewer (JSON pretty-print, CSV table, markdown text)
 * - Expandable change log per document
 * - Empty and loading states
 */

import { useState } from "react";
import type { AgentDocument } from "@quorum/types";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: AgentDocument["status"] }) {
  const styles: Record<AgentDocument["status"], string> = {
    active: "bg-emerald-50 text-emerald-700",
    superseded: "bg-amber-50 text-amber-700",
    canceled: "bg-gray-100 text-gray-500 line-through",
  };
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${styles[status]}`}
      data-testid="doc-status-badge"
    >
      {status}
    </span>
  );
}

/**
 * Renders the document content based on its format.
 *
 * - json / yaml: syntax-highlighted JSON block
 * - csv: simple HTML table (best-effort parse)
 * - markdown: preformatted text (full markdown renderer out of scope here)
 */
function DocumentViewer({
  document,
}: {
  document: AgentDocument;
}) {
  if (document.format === "csv") {
    // Attempt to render the content object as a simple key-value table
    const entries = Object.entries(document.content);
    return (
      <div className="overflow-x-auto">
        <table
          className="w-full text-xs border-collapse"
          data-testid="doc-csv-table"
        >
          <thead>
            <tr>
              {entries.map(([key]) => (
                <th
                  key={key}
                  className="border border-gray-200 dark:border-gray-700 px-2 py-1 bg-gray-50 dark:bg-gray-900 text-left font-semibold text-gray-600 dark:text-gray-300"
                >
                  {key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {entries.map(([key, val]) => (
                <td
                  key={key}
                  className="border border-gray-200 dark:border-gray-700 px-2 py-1 text-gray-700 dark:text-gray-200"
                >
                  {typeof val === "object" ? JSON.stringify(val) : String(val)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  if (document.format === "markdown") {
    return (
      <pre
        className="text-xs text-gray-700 dark:text-gray-200 whitespace-pre-wrap font-mono bg-gray-50 dark:bg-gray-900 rounded p-3"
        data-testid="doc-markdown-viewer"
      >
        {typeof document.content.text === "string"
          ? document.content.text
          : JSON.stringify(document.content, null, 2)}
      </pre>
    );
  }

  // json / yaml — render as formatted JSON
  return (
    <pre
      className="text-xs text-gray-700 dark:text-gray-200 overflow-x-auto font-mono bg-gray-50 dark:bg-gray-900 rounded p-3"
      data-testid="doc-json-viewer"
    >
      {JSON.stringify(document.content, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface DocumentPanelProps {
  quorumId: string;
  documents: AgentDocument[];
  loading?: boolean;
}

export function DocumentPanel({
  documents,
  loading = false,
}: DocumentPanelProps) {
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [changeLogExpanded, setChangeLogExpanded] = useState<Set<string>>(
    new Set()
  );

  const toggleDoc = (id: string) => {
    setExpandedDocId((prev) => (prev === id ? null : id));
  };

  const toggleChangeLog = (id: string) => {
    setChangeLogExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div
        className="space-y-3 animate-pulse p-3"
        data-testid="document-panel-loading"
      >
        {[1, 2].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-xl" />
        ))}
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400"
        data-testid="document-panel-empty"
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="mb-3 opacity-40"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <p className="text-sm">No documents yet.</p>
        <p className="text-xs mt-1 opacity-70">
          Documents appear when agents create or edit structured content.
        </p>
      </div>
    );
  }

  return (
    <div
      className="space-y-3 p-3 overflow-y-auto"
      data-testid="document-panel"
    >
      {documents.map((doc) => {
        const isExpanded = expandedDocId === doc.id;
        const isChangeLogOpen = changeLogExpanded.has(doc.id);

        return (
          <div
            key={doc.id}
            className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden"
            data-testid={`doc-card-${doc.id}`}
          >
            {/* Card header — always visible */}
            <button
              type="button"
              onClick={() => toggleDoc(doc.id)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
              data-testid={`doc-expand-${doc.id}`}
            >
              <div className="flex-1 min-w-0 mr-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-gray-800 truncate">
                    {doc.title}
                  </span>
                  <StatusBadge status={doc.status} />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-gray-600 dark:text-gray-300 uppercase tracking-wide">
                    {doc.format}
                  </span>
                  <span className="text-xs text-gray-400">·</span>
                  <span className="text-xs text-gray-600 dark:text-gray-300">
                    v{doc.version}
                  </span>
                  <span className="text-xs text-gray-400">·</span>
                  <span className="text-xs text-gray-400">
                    {new Date(doc.updated_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              </div>

              {/* Tags */}
              {doc.tags && doc.tags.length > 0 && (
                <div className="hidden sm:flex flex-wrap gap-1 max-w-[40%] justify-end">
                  {doc.tags.slice(0, 3).map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded-full"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Chevron */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`flex-shrink-0 ml-2 text-gray-400 transition-transform ${
                  isExpanded ? "rotate-180" : ""
                }`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Expanded content */}
            {isExpanded && (
              <div
                className="border-t border-gray-100 px-4 py-3"
                data-testid={`doc-content-${doc.id}`}
              >
                <DocumentViewer document={doc} />

                {/* Change log toggle */}
                {doc.status !== "canceled" && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => toggleChangeLog(doc.id)}
                      className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                      data-testid={`doc-changelog-toggle-${doc.id}`}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={`transition-transform ${
                          isChangeLogOpen ? "rotate-180" : ""
                        }`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                      {isChangeLogOpen ? "Hide" : "Show"} change log
                    </button>

                    {isChangeLogOpen && (
                      <div
                        className="mt-2 space-y-2"
                        data-testid={`doc-changelog-${doc.id}`}
                      >
                        {/* Change log is fetched externally; here we show what we have
                            in the document itself as metadata. A full implementation would
                            pass DocumentChange[] as a prop. */}
                        <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                          v{doc.version} — last updated{" "}
                          {new Date(doc.updated_at).toLocaleString()}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
