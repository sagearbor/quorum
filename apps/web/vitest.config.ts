import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@quorum/types": path.resolve(__dirname, "../../packages/types/src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    env: {
      NEXT_PUBLIC_API_URL: "http://localhost:8000",
    },
    environmentOptions: {
      jsdom: {
        url: "http://localhost:3000",
      },
    },
  },
});
