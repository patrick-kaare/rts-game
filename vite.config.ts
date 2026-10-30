import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

function commitHash() {
  try {
    // "<short hash> - <commit date as YYYY-MM-DD>"
    return execSync("git log -1 --format='%h - %cs'", { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  define: { __COMMIT__: JSON.stringify(commitHash()) },
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
