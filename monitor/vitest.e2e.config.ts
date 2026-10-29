import {defineConfig} from "vitest/config";

// End-to-end suites start their own anvil node and deploy the contracts, so files run one at a time and every hook
// and test gets enough time for a deployment plus several daemon cycles.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
