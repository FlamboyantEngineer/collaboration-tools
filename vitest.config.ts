import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Each file runs in its own worker with a fresh module graph, so room registries and timers in
    // one file never reach another.
    pool: 'threads',
    isolate: true,
    // Four workers by default; pass `--maxWorkers` to use more or fewer.
    maxWorkers: 4,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
