import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BottomBar } from "./BottomBar";
import { useQuorumStore } from "@/store/quorumStore";
import { quorum1Roles } from "@/lib/mockData";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "duke-expo-2026" }),
  useSearchParams: () => ({
    get: (key: string) => (key === "station" ? "2" : null),
  }),
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("BottomBar", () => {
  beforeEach(() => {
    useQuorumStore.setState({
      currentRole: null,
      pendingContributions: [],
    });
  });

  it("renders All Quorums link with station param", () => {
    render(<BottomBar />);
    const link = screen.getByTestId("all-quorums-link");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "/event/duke-expo-2026?station=2"
    );
    expect(link).toHaveTextContent("All Quorums");
  });

  it("shows 'No role selected' when no role is active", () => {
    render(<BottomBar />);
    expect(screen.getByText("No role selected")).toBeInTheDocument();
  });

  it("shows role chip when a role is selected", () => {
    useQuorumStore.setState({ currentRole: quorum1Roles[0] });
    render(<BottomBar />);
    const chip = screen.getByTestId("role-chip");
    expect(chip).toHaveTextContent("IRB Chair");
  });

  it("shows pending badge when there are queued contributions", () => {
    useQuorumStore.setState({
      pendingContributions: [
        {
          id: "temp-1",
          quorum_id: "q-001",
          role_id: "r-001",
          user_token: "test",
          content: "test",
          structured_fields: {},
          tier_processed: 1,
          created_at: new Date().toISOString(),
        },
      ],
    });
    render(<BottomBar />);
    expect(screen.getByTestId("pending-badge")).toHaveTextContent("1 pending");
  });
});
