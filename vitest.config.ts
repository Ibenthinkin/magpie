import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the unit suite: tests/bun/** runs under `bun test` (bun:sqlite
    // cannot load under vitest — log.md 07-10).
    include: ['tests/unit/**/*.test.ts'],
  },
});
