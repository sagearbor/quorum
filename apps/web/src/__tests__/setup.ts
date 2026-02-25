import "@testing-library/jest-dom/vitest";

// Mock ResizeObserver for Recharts ResponsiveContainer
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// Set test mode env
process.env.NEXT_PUBLIC_QUORUM_TEST_MODE = "true";
