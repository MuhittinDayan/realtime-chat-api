import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/generated/**"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/chat_test",
      FRONTEND_ORIGIN: "http://localhost:3000",
      JWT_ACCESS_SECRET: "test-only-secret-with-at-least-32-bytes",
      JWT_ISSUER: "chat-api-test",
      JWT_AUDIENCE: "chat-web-test",
      LOG_LEVEL: "silent",
    },
  },
});
