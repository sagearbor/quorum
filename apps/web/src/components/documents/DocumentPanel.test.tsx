import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DocumentPanel } from "./DocumentPanel";
import type { AgentDocument } from "@quorum/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<AgentDocument> & { id: string }): AgentDocument {
  return {
    quorum_id: "q-001",
    title: "Budget Overview",
    doc_type: "budget",
    format: "json",
    content: { total: 500000, currency: "USD" },
    status: "active",
    version: 1,
    tags: ["budget", "sponsor"],
    created_at: "2026-03-14T10:00:00Z",
    updated_at: "2026-03-14T12:00:00Z",
    ...overrides,
  };
}

const activeDoc = makeDoc({ id: "doc-1", title: "Budget Overview" });
const supersededDoc = makeDoc({
  id: "doc-2",
  title: "Old Protocol",
  status: "superseded",
  doc_type: "protocol",
  format: "markdown",
  content: { text: "# Protocol v1\n\nInitial version." },
});
const canceledDoc = makeDoc({
  id: "doc-3",
  title: "Canceled Timeline",
  status: "canceled",
  doc_type: "timeline",
  format: "csv",
  content: { milestone: "Kickoff", date: "2026-04-01" },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocumentPanel", () => {
  it("renders empty state when no documents", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[]} />
    );

    expect(screen.getByTestId("document-panel-empty")).toBeInTheDocument();
    expect(screen.getByText(/no documents yet/i)).toBeInTheDocument();
  });

  it("renders loading skeleton", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[]} loading={true} />
    );

    expect(screen.getByTestId("document-panel-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("document-panel")).not.toBeInTheDocument();
  });

  it("renders document cards", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );

    expect(screen.getByTestId("doc-card-doc-1")).toBeInTheDocument();
    expect(screen.getByText("Budget Overview")).toBeInTheDocument();
  });

  it("shows correct status badge for active document", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );

    const badge = screen.getByTestId("doc-status-badge");
    expect(badge).toHaveTextContent("active");
    expect(badge).toHaveClass("bg-emerald-50");
  });

  it("shows correct status badge for superseded document", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[supersededDoc]} />
    );

    const badge = screen.getByTestId("doc-status-badge");
    expect(badge).toHaveTextContent("superseded");
    expect(badge).toHaveClass("bg-amber-50");
  });

  it("shows correct status badge for canceled document", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[canceledDoc]} />
    );

    const badge = screen.getByTestId("doc-status-badge");
    expect(badge).toHaveTextContent("canceled");
    expect(badge).toHaveClass("bg-gray-100");
  });

  it("shows document metadata: version, format, time", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );

    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("json")).toBeInTheDocument();
  });

  it("shows tag pills on card", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );

    // Tags are visible on medium+ screens (hidden sm:flex)
    expect(screen.getByText("budget")).toBeInTheDocument();
  });

  it("expands document content on click", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );

    // Content should not be visible before expand
    expect(screen.queryByTestId(`doc-content-doc-1`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("doc-expand-doc-1"));

    expect(screen.getByTestId(`doc-content-doc-1`)).toBeInTheDocument();
    // JSON viewer should appear
    expect(screen.getByTestId("doc-json-viewer")).toBeInTheDocument();
  });

  it("collapses document content on second click", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );

    fireEvent.click(screen.getByTestId("doc-expand-doc-1"));
    expect(screen.getByTestId(`doc-content-doc-1`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("doc-expand-doc-1"));
    expect(screen.queryByTestId(`doc-content-doc-1`)).not.toBeInTheDocument();
  });

  it("renders JSON viewer for json format documents", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );
    fireEvent.click(screen.getByTestId("doc-expand-doc-1"));

    expect(screen.getByTestId("doc-json-viewer")).toBeInTheDocument();
    // Should contain the serialized JSON content
    const viewer = screen.getByTestId("doc-json-viewer");
    expect(viewer.textContent).toContain("500000");
  });

  it("renders markdown viewer for markdown format documents", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[supersededDoc]} />
    );
    fireEvent.click(screen.getByTestId("doc-expand-doc-2"));

    expect(screen.getByTestId("doc-markdown-viewer")).toBeInTheDocument();
    expect(screen.getByText(/Protocol v1/i)).toBeInTheDocument();
  });

  it("renders CSV table for csv format documents", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[canceledDoc]} />
    );
    fireEvent.click(screen.getByTestId("doc-expand-doc-3"));

    expect(screen.getByTestId("doc-csv-table")).toBeInTheDocument();
    // Table headers should match content keys
    expect(screen.getByText("milestone")).toBeInTheDocument();
    expect(screen.getByText("Kickoff")).toBeInTheDocument();
  });

  it("shows change log toggle for non-canceled documents", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );
    fireEvent.click(screen.getByTestId("doc-expand-doc-1"));

    expect(
      screen.getByTestId("doc-changelog-toggle-doc-1")
    ).toBeInTheDocument();
  });

  it("hides change log toggle for canceled documents", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[canceledDoc]} />
    );
    fireEvent.click(screen.getByTestId("doc-expand-doc-3"));

    expect(
      screen.queryByTestId("doc-changelog-toggle-doc-3")
    ).not.toBeInTheDocument();
  });

  it("expands change log on toggle click", () => {
    render(
      <DocumentPanel quorumId="q-001" documents={[activeDoc]} />
    );
    fireEvent.click(screen.getByTestId("doc-expand-doc-1"));
    fireEvent.click(screen.getByTestId("doc-changelog-toggle-doc-1"));

    expect(screen.getByTestId("doc-changelog-doc-1")).toBeInTheDocument();
    expect(screen.getByText(/last updated/i)).toBeInTheDocument();
  });

  it("handles multiple documents independently", () => {
    render(
      <DocumentPanel
        quorumId="q-001"
        documents={[activeDoc, supersededDoc]}
      />
    );

    // Expand first doc
    fireEvent.click(screen.getByTestId("doc-expand-doc-1"));
    expect(screen.getByTestId("doc-content-doc-1")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-content-doc-2")).not.toBeInTheDocument();

    // Expand second doc — first should close (only one expanded at a time)
    fireEvent.click(screen.getByTestId("doc-expand-doc-2"));
    expect(screen.queryByTestId("doc-content-doc-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("doc-content-doc-2")).toBeInTheDocument();
  });
});
