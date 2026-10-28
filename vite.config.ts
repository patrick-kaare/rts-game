import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The game server (npm run server) listens on 8787.
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // The deploy box is a small home server that also runs the game; the AI
    // sims and socket tests are CPU-bound and blow vitest's 5s default there.
    testTimeout: 30_000,
  },
} as any);
