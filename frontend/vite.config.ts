import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, proxy API + webhook + health calls to the NestJS backend so the app
// can call relative paths (no hardcoded host). Set VITE_API_BASE_URL for prod.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
