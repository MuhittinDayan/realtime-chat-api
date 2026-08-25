import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    include: ["src/**/*.test.ts"],
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
