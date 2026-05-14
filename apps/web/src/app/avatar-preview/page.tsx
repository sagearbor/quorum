/**
 * Dev-only preview of every archetype + the GLB the resolver picks for it.
 * Useful for sanity-checking that newly added avaturn GLBs are wired into the
 * rotation. Not linked from the main UI; visit /avatar-preview directly.
 */

"use client";

import { ARCHETYPES, resolveGlbUrl, type ArchetypeId } from "@/components/avatar/archetypes/archetypes";
import { IdleScene } from "@/components/avatar/IdleScene";
import { useMemo } from "react";

export default function AvatarPreviewPage() {
  const rows = useMemo(() => {
    return (Object.keys(ARCHETYPES) as ArchetypeId[]).map((id) => {
      const archetype = ARCHETYPES[id];
      const glbUrl = resolveGlbUrl(archetype);
      const filename = glbUrl.split("/").pop() ?? glbUrl;
      return { id, archetype, glbUrl, filename };
    });
  }, []);

  const grouped = useMemo(() => {
    const byFile: Record<string, typeof rows> = {};
    for (const row of rows) {
      byFile[row.filename] ??= [];
      byFile[row.filename].push(row);
    }
    return Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  return (
    <div style={{ minHeight: "100vh", background: "#0c0e13", color: "#e6e9f2", padding: "24px", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: "20px", marginBottom: "8px" }}>Avatar preview — all archetypes × resolved GLB</h1>
      <p style={{ fontSize: "13px", color: "#8b93a8", marginBottom: "24px" }}>
        Each card renders the archetype with the GLB the resolver picked for it. Grouped by GLB file so you can see which faces cover which archetypes. Dev-only route.
      </p>

      {grouped.map(([filename, items]) => (
        <section key={filename} style={{ marginBottom: "32px" }}>
          <h2 style={{ fontSize: "14px", color: "#6ea8ff", marginBottom: "10px", fontFamily: "ui-monospace, monospace" }}>
            {filename} <span style={{ color: "#8b93a8", fontWeight: 400 }}>· {items.length} archetype{items.length === 1 ? "" : "s"}</span>
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "12px" }}>
            {items.map((row) => (
              <div key={row.id} style={{ background: "#151821", border: "1px solid #2a3045", borderRadius: "8px", padding: "10px" }}>
                <div style={{ fontSize: "12px", color: "#facc15", fontFamily: "ui-monospace, monospace", marginBottom: "6px" }}>
                  {row.id}
                </div>
                <div style={{ width: "100%", height: "260px", background: "#0c0e13", borderRadius: "6px", overflow: "hidden" }}>
                  <IdleScene glbUrl={row.glbUrl} width="100%" height="100%" />
                </div>
                <div style={{ fontSize: "10.5px", color: "#8b93a8", fontFamily: "ui-monospace, monospace", marginTop: "6px", wordBreak: "break-all" }}>
                  {row.glbUrl}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
