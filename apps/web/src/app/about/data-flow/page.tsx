import type { Metadata } from "next";
import { DataFlowExperience } from "./DataFlowExperience";

export const metadata: Metadata = {
  title: "Data Flow · Quorum",
  description:
    "End-to-end pipeline of a single contribution: structured form → Tier-2 LLM analyzer → conflict detector → health score recompute → Postgres UPDATE → realtime broadcast → live chart bump.",
};

export default function DataFlowPage() {
  return <DataFlowExperience />;
}
