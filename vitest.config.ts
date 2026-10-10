import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The framework isn't on npm here; alias `cortico/*` to the sibling checkout's src so vitest and
// the editor resolve the same files the runtime module hook maps to in a real install.
const FRAMEWORK_SRC = fileURLToPath(new URL('../../Coo/vendor/cortico/src/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^cortico\//, replacement: FRAMEWORK_SRC }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
  },
});
