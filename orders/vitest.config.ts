import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // The database tests share one schema, so files run one at a time.
    fileParallelism: false,
  },
});
