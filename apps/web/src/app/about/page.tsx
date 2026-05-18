import type { Metadata } from "next";
import { AboutExperience } from "./AboutExperience";

export const metadata: Metadata = {
  title: "About · Quorum",
  description:
    "How Quorum coordinates people and AI agents into a single decision-making organism — tiered LLM cost, agent-to-agent collaboration, and an audit-trailed artifact at the end.",
};

export default function AboutPage() {
  return <AboutExperience />;
}
