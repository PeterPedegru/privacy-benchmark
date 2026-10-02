import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DB_PATH: ":memory:",
      ADMIN_PASSWORD: "test-password",
      SESSION_SECRET: "test-secret",
      ANTHROPIC_API_KEY: "",
      VERSION_CHECK_INTERVAL_HOURS: "0",
      VERSION_MODEL: "",
      EVAL_MODEL: "",
      MODEL_GATHER: "",
      MODEL_WRITE: "",
      MODEL_REASON: "",
    },
    testTimeout: 30_000,
  },
});
