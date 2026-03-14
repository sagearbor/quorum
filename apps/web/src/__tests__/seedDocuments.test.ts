/**
 * Validates the clinical-trial-documents.json seed file structure and content.
 *
 * These tests ensure:
 * 1. The JSON file is parseable and has the expected top-level shape.
 * 2. Each document has required fields for the agent_documents table.
 * 3. The content envelope follows the schema_version + sections + metadata pattern.
 * 4. Problems are present in each document (the whole point of the seed).
 * 5. Doc types match expected renderers in AgentDocumentDashboard.
 */

import { describe, it, expect } from "vitest";
// Seed file is at repo root /seed/ — 4 directories up from apps/web/src/__tests__/
import seedData from "../../../../seed/clinical-trial-documents.json";

// ---------------------------------------------------------------------------
// Type narrowing helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// ---------------------------------------------------------------------------
// Top-level structure
// ---------------------------------------------------------------------------

describe("clinical-trial-documents.json top-level structure", () => {
  it("is a valid JSON object", () => {
    expect(isRecord(seedData)).toBe(true);
  });

  it("has a documents array", () => {
    expect(Array.isArray(seedData.documents)).toBe(true);
  });

  it("has at least 3 documents", () => {
    expect(seedData.documents.length).toBeGreaterThanOrEqual(3);
  });

  it("has a quorum_id field referencing the seed quorum", () => {
    expect(seedData.quorum_id).toBe("00000000-0000-0000-0000-000000000010");
  });
});

// ---------------------------------------------------------------------------
// Per-document required fields
// ---------------------------------------------------------------------------

describe("each document has required fields for agent_documents table", () => {
  for (const doc of seedData.documents) {
    it(`document '${doc.title}' has required fields`, () => {
      expect(typeof doc.title).toBe("string");
      expect(doc.title.length).toBeGreaterThan(0);

      expect(typeof doc.doc_type).toBe("string");
      expect(doc.doc_type.length).toBeGreaterThan(0);

      expect(typeof doc.format).toBe("string");
      // format must be one of: json | yaml | csv | markdown
      expect(["json", "yaml", "csv", "markdown"]).toContain(doc.format);

      expect(typeof doc.status).toBe("string");
      expect(["active", "superseded", "canceled"]).toContain(doc.status);

      expect(isStringArray(doc.tags)).toBe(true);
      expect(doc.tags.length).toBeGreaterThan(0);

      expect(isRecord(doc.content)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Content envelope: schema_version + sections + metadata
// ---------------------------------------------------------------------------

describe("each document content follows the schema envelope", () => {
  for (const doc of seedData.documents) {
    it(`document '${doc.title}' content has schema_version`, () => {
      expect(doc.content.schema_version).toBe("1.0");
    });

    it(`document '${doc.title}' content has sections object`, () => {
      expect(isRecord(doc.content.sections)).toBe(true);
    });

    it(`document '${doc.title}' content has metadata object`, () => {
      expect(isRecord(doc.content.metadata)).toBe(true);
    });

    it(`document '${doc.title}' metadata has problems array`, () => {
      const metadata = doc.content.metadata as Record<string, unknown>;
      expect(isStringArray(metadata.problems)).toBe(true);
    });

    it(`document '${doc.title}' has at least 1 problem for agents to resolve`, () => {
      const metadata = doc.content.metadata as Record<string, unknown>;
      const problems = metadata.problems as string[];
      expect(problems.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Doc-type-specific content validation
// ---------------------------------------------------------------------------

describe("timeline document (Gantt)", () => {
  const doc = seedData.documents.find((d) => d.doc_type === "timeline");

  it("has a timeline document", () => {
    expect(doc).toBeDefined();
  });

  it("sections.tasks is a non-empty array", () => {
    const sections = doc!.content.sections as Record<string, unknown>;
    expect(Array.isArray(sections.tasks)).toBe(true);
    expect((sections.tasks as unknown[]).length).toBeGreaterThan(0);
  });

  it("each task has id, name, start, end, depends_on", () => {
    const sections = doc!.content.sections as Record<string, unknown>;
    const tasks = sections.tasks as Array<Record<string, unknown>>;
    for (const task of tasks) {
      expect(typeof task.id).toBe("string");
      expect(typeof task.name).toBe("string");
      expect(typeof task.start).toBe("string");
      expect(typeof task.end).toBe("string");
      expect(Array.isArray(task.depends_on)).toBe(true);
    }
  });

  it("contains dependency conflict problem", () => {
    const metadata = doc!.content.metadata as Record<string, unknown>;
    const problems = metadata.problems as string[];
    const hasDependencyConflict = problems.some((p) =>
      p.includes("DEPENDENCY CONFLICT"),
    );
    expect(hasDependencyConflict).toBe(true);
  });
});

describe("budget document", () => {
  const doc = seedData.documents.find((d) => d.doc_type === "budget");

  it("has a budget document", () => {
    expect(doc).toBeDefined();
  });

  it("sections.line_items is a non-empty array", () => {
    const sections = doc!.content.sections as Record<string, unknown>;
    expect(Array.isArray(sections.line_items)).toBe(true);
    expect((sections.line_items as unknown[]).length).toBeGreaterThan(0);
  });

  it("each line item has category, planned, actual, variance", () => {
    const sections = doc!.content.sections as Record<string, unknown>;
    const items = sections.line_items as Array<Record<string, unknown>>;
    for (const item of items) {
      expect(typeof item.category).toBe("string");
      expect(typeof item.planned).toBe("number");
      expect(typeof item.actual).toBe("number");
      expect(typeof item.variance).toBe("number");
    }
  });

  it("variance values are arithmetically consistent (planned - actual)", () => {
    // Convention: positive variance = under budget (good), negative = overrun.
    // variance = planned - actual, so actual = planned - variance.
    const sections = doc!.content.sections as Record<string, unknown>;
    const items = sections.line_items as Array<Record<string, unknown>>;
    for (const item of items) {
      const computed = (item.planned as number) - (item.actual as number);
      expect(item.variance as number).toBeCloseTo(computed, 0);
    }
  });

  it("contains budget overrun problem", () => {
    const metadata = doc!.content.metadata as Record<string, unknown>;
    const problems = metadata.problems as string[];
    const hasBudgetOverrun = problems.some((p) =>
      /BUDGET OVERRUN|overrun/i.test(p),
    );
    expect(hasBudgetOverrun).toBe(true);
  });
});

describe("protocol document", () => {
  const doc = seedData.documents.find((d) => d.doc_type === "protocol");

  it("has a protocol document", () => {
    expect(doc).toBeDefined();
  });

  it("sections.amendments is a non-empty array", () => {
    const sections = doc!.content.sections as Record<string, unknown>;
    expect(Array.isArray(sections.amendments)).toBe(true);
    expect((sections.amendments as unknown[]).length).toBeGreaterThan(0);
  });

  it("each amendment has id, title, status, impacts, description", () => {
    const sections = doc!.content.sections as Record<string, unknown>;
    const amendments = sections.amendments as Array<Record<string, unknown>>;
    for (const am of amendments) {
      expect(typeof am.id).toBe("string");
      expect(typeof am.title).toBe("string");
      expect(typeof am.status).toBe("string");
      expect(Array.isArray(am.impacts)).toBe(true);
      expect(typeof am.description).toBe("string");
    }
  });

  it("contains consent problem", () => {
    const metadata = doc!.content.metadata as Record<string, unknown>;
    const problems = metadata.problems as string[];
    const hasConsentProblem = problems.some((p) =>
      /CONSENT/i.test(p),
    );
    expect(hasConsentProblem).toBe(true);
  });

  it("at least one amendment has consent_revised=false", () => {
    const sections = doc!.content.sections as Record<string, unknown>;
    const amendments = sections.amendments as Array<Record<string, unknown>>;
    const hasUnrevisedConsent = amendments.some(
      (am) => am.consent_revised === false,
    );
    expect(hasUnrevisedConsent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-document consistency
// ---------------------------------------------------------------------------

describe("cross-document consistency", () => {
  it("all document titles are unique", () => {
    const titles = seedData.documents.map((d) => d.title);
    const unique = new Set(titles);
    expect(unique.size).toBe(titles.length);
  });

  it("all active documents have at least one tag", () => {
    const active = seedData.documents.filter((d) => d.status === "active");
    for (const doc of active) {
      expect(doc.tags.length).toBeGreaterThan(0);
    }
  });

  it("budget doc and protocol doc share tags indicating cross-document linkage", () => {
    const budget = seedData.documents.find((d) => d.doc_type === "budget");
    const protocol = seedData.documents.find((d) => d.doc_type === "protocol");
    expect(budget).toBeDefined();
    expect(protocol).toBeDefined();
    // Both should have 'budget' or 'irb' in their tags to trigger affinity
    const budgetTags = new Set(budget!.tags);
    const protocolTags = new Set(protocol!.tags);
    const overlap = [...budgetTags].filter((t) => protocolTags.has(t));
    expect(overlap.length).toBeGreaterThan(0);
  });
});
