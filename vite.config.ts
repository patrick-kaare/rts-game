import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The game server (npm run server) listens on 8787.
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] },
} as any);
