import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentDocument } from "@quorum/types";
import { AgentDocumentDashboard } from "../AgentDocumentDashboard";

// ---------------------------------------------------------------------------
// Mock useAgentDocuments to isolate the component from the data layer.
// When staticDocuments are passed in, the hook result is irrelevant but we
// still mock it to avoid Supabase initialization in jsdom.
// ---------------------------------------------------------------------------
vi.mock("@/hooks/useAgentDocuments", () => ({
  useAgentDocuments: () => ({
    documents: [],
    loading: false,
    refresh: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Test fixture factories
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<AgentDocument> = {}): AgentDocument {
  return {
    id: "doc-001",
    quorum_id: "quorum-001",
    title: "Test Document",
    doc_type: "json",
    format: "json",
    content: {
      schema_version: "1.0",
      sections: { key: "value" },
      metadata: { problems: [] },
    },
    status: "active",
    version: 1,
    tags: ["test"],
    created_at: "2026-03-14T00:00:00Z",
    updated_at: "2026-03-14T00:00:00Z",
    ...overrides,
  };
}

const timelineDoc = makeDoc({
  id: "doc-timeline",
  title: "Protocol Timeline (Gantt)",
  doc_type: "timeline",
  content: {
    schema_version: "1.0",
    sections: {
      tasks: [
        {
          id: "t1",
          name: "Site Selection",
          start: "2026-04-01",
          end: "2026-05-15",
          depends_on: [],
          owner_role: "sponsor",
          status: "in_progress",
        },
        {
          id: "t2",
          name: "IRB Approval",
          start: "2026-04-15",
          end: "2026-06-30",
          depends_on: ["t1"],
          owner_role: "irb_officer",
          status: "not_started",
        },
      ],
    },
    metadata: {
      problems: [
        "DEPENDENCY CONFLICT: Site Activation overlaps with IRB Approval",
        "IMPOSSIBLE MILESTONE: First Patient Enrolled before IRB completes",
      ],
    },
  },
});

const budgetDoc = makeDoc({
  id: "doc-budget",
  title: "Budget Analysis",
  doc_type: "budget",
  content: {
    schema_version: "1.0",
    sections: {
      line_items: [
        {
          category: "CRO Management Fee",
          planned: 450000,
          actual: 520000,
          variance: -70000,
          notes: "Scope change not budgeted",
          status: "over_budget",
        },
        {
          category: "Drug Supply",
          planned: 120000,
          actual: 95000,
          variance: 25000,
          notes: "Lower than expected dosing",
          status: "under_budget",
        },
      ],
      totals: {
        total_planned: 570000,
        total_actual: 615000,
        total_variance: -45000,
      },
    },
    metadata: {
      problems: ["BUDGET OVERRUN: Total variance is -$45,000"],
    },
  },
});

const protocolDoc = makeDoc({
  id: "doc-protocol",
  title: "Protocol Amendment Tracker",
  doc_type: "protocol",
  content: {
    schema_version: "1.0",
    sections: {
      amendments: [
        {
          id: "PA-001",
          title: "Dosing Schedule Modification",
          status: "pending_irb",
          submitted: "2026-03-01",
          impacts: ["enrollment_criteria", "informed_consent"],
          description: "Change from BID to QD dosing",
          consent_revised: false,
          sites_notified: false,
        },
      ],
    },
    metadata: {
      problems: ["CONSENT NOT REVISED: PA-001 pending but consent not updated"],
    },
  },
});

const supersededDoc = makeDoc({
  id: "doc-superseded",
  title: "Old Document",
  doc_type: "json",
  status: "superseded",
  content: {
    schema_version: "1.0",
    sections: {},
    metadata: { problems: [] },
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentDocumentDashboard", () => {
  it("shows empty state when no documents", () => {
    render(
      <AgentDocumentDashboard quorumId="q1" staticDocuments={[]} />,
    );
    expect(
      screen.getByTestId("agent-document-dashboard-empty"),
    ).toBeTruthy();
  });

  it("renders the dashboard container when documents are present", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc]}
      />,
    );
    expect(screen.getByTestId("agent-document-dashboard")).toBeTruthy();
  });

  it("shows 'active' document count in header", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc, budgetDoc]}
      />,
    );
    expect(screen.getByText("2 active")).toBeTruthy();
  });

  it("filters out superseded documents", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc, supersededDoc]}
      />,
    );
    // Only 1 active document
    expect(screen.getByText("1 active")).toBeTruthy();
    // superseded title should not appear
    expect(screen.queryByText("Old Document")).toBeNull();
  });

  it("renders a document card for each active document", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc, budgetDoc, protocolDoc]}
      />,
    );
    expect(screen.getByTestId("document-card-doc-timeline")).toBeTruthy();
    expect(screen.getByTestId("document-card-doc-budget")).toBeTruthy();
    expect(screen.getByTestId("document-card-doc-protocol")).toBeTruthy();
  });

  it("renders document titles", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc]}
      />,
    );
    expect(screen.getByText("Protocol Timeline (Gantt)")).toBeTruthy();
  });

  // --- Format: timeline ---

  it("renders Gantt view for timeline doc_type", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc]}
      />,
    );
    expect(screen.getByTestId("gantt-view")).toBeTruthy();
  });

  it("renders the Gantt chart container (Recharts does not render axes in jsdom)", () => {
    // Recharts needs real DOM sizing to render tick labels — in jsdom the chart
    // container is zero-size so axis text is absent.  We verify the chart div
    // exists; full visual correctness is covered by Storybook / Playwright.
    const { container } = render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc]}
      />,
    );
    // The recharts-responsive-container wrapper should be present
    const chartContainer = container.querySelector(".recharts-responsive-container");
    expect(chartContainer).not.toBeNull();
  });

  // --- Format: budget ---

  it("renders budget table for budget doc_type", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[budgetDoc]}
      />,
    );
    expect(screen.getByTestId("budget-view")).toBeTruthy();
  });

  it("shows category names in budget table", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[budgetDoc]}
      />,
    );
    expect(screen.getByText("CRO Management Fee")).toBeTruthy();
    expect(screen.getByText("Drug Supply")).toBeTruthy();
  });

  it("renders TOTAL row in budget table", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[budgetDoc]}
      />,
    );
    expect(screen.getByText("TOTAL")).toBeTruthy();
  });

  // --- Format: protocol ---

  it("renders protocol view for protocol doc_type", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[protocolDoc]}
      />,
    );
    expect(screen.getByTestId("protocol-view")).toBeTruthy();
  });

  it("shows amendment titles in protocol view", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[protocolDoc]}
      />,
    );
    expect(screen.getByText("Dosing Schedule Modification")).toBeTruthy();
  });

  it("shows 'Consent not revised' warning in protocol view", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[protocolDoc]}
      />,
    );
    expect(screen.getByText("Consent not revised")).toBeTruthy();
  });

  // --- Format: json fallback ---

  it("renders json view for unknown doc_type", () => {
    const jsonDoc = makeDoc({
      doc_type: "risk_register",
      content: {
        schema_version: "1.0",
        sections: { risks: [{ id: "r1", description: "Protocol delay" }] },
        metadata: { problems: [] },
      },
    });
    render(
      <AgentDocumentDashboard quorumId="q1" staticDocuments={[jsonDoc]} />,
    );
    expect(screen.getByTestId("json-view")).toBeTruthy();
  });

  // --- Problem annotations ---

  it("shows problem list when document has problems", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc]}
      />,
    );
    expect(screen.getByTestId("problem-list")).toBeTruthy();
  });

  it("shows problem count badge on document card", () => {
    render(
      <AgentDocumentDashboard
        quorumId="q1"
        staticDocuments={[timelineDoc]}
      />,
    );
    // 2 problems in the fixture
    expect(screen.getByText("2 problems")).toBeTruthy();
  });

  it("does not show problem list when document has no problems", () => {
    const cleanDoc = makeDoc({
      content: {
        schema_version: "1.0",
        sections: { key: "value" },
        metadata: { problems: [] },
      },
    });
    render(
      <AgentDocumentDashboard quorumId="q1" staticDocuments={[cleanDoc]} />,
    );
    expect(screen.queryByTestId("problem-list")).toBeNull();
  });

  it("shows version number on card", () => {
    const v3Doc = makeDoc({ version: 3 });
    render(
      <AgentDocumentDashboard quorumId="q1" staticDocuments={[v3Doc]} />,
    );
    expect(screen.getByText("v3")).toBeTruthy();
  });

  it("shows tag pills on card (up to 3)", () => {
    const tagDoc = makeDoc({
      tags: ["budget", "cost_analysis", "funding", "vendor_management"],
    });
    render(
      <AgentDocumentDashboard quorumId="q1" staticDocuments={[tagDoc]} />,
    );
    // First 3 tags shown
    expect(screen.getByText("budget")).toBeTruthy();
    expect(screen.getByText("cost_analysis")).toBeTruthy();
    expect(screen.getByText("funding")).toBeTruthy();
    // 4th tag should not appear (slice(0, 3))
    expect(screen.queryByText("vendor_management")).toBeNull();
  });
});
