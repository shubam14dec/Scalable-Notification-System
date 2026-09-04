import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    fs: { allow: ['..'] }, // allow importing packages/react source (dogfooding)
    proxy: {
      '/v1': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/ops': 'http://localhost:3000',
      // Prod serves the dashboard same-origin behind Caddy with /ws routed to the gateway; this proxy makes dev exercise the identical path.
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
