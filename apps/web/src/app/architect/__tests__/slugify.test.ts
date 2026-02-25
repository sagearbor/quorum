import { describe, it, expect } from "vitest";
import { slugify } from "@/lib/slugify";

describe("slugify", () => {
  it("converts a simple string to lowercase slug", () => {
    expect(slugify("Duke Expo 2026")).toBe("duke-expo-2026");
  });

  it("replaces multiple spaces with a single hyphen", () => {
    expect(slugify("hello   world")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(slugify("Hello! @World #2026")).toBe("hello-world-2026");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  --hello-- ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles underscores by replacing with hyphens", () => {
    expect(slugify("my_event_name")).toBe("my-event-name");
  });

  it("collapses multiple hyphens into one", () => {
    expect(slugify("a---b---c")).toBe("a-b-c");
  });

  it("handles mixed case and special chars", () => {
    expect(slugify("DCRI Phase III — Trial")).toBe("dcri-phase-iii-trial");
  });
});
