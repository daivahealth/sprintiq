import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, proxy API + webhook + health calls to the NestJS backend so the app
// can call relative paths (no hardcoded host). Set VITE_API_BASE_URL for prod.
export default defineConfig({
  plugins: [react()],
  // Opt-in: a checkout under OneDrive turns node_modules/.vite into cloud
  // placeholders Vite cannot delete (EPERM on rmdir). Point VITE_CACHE_DIR at a
  // folder outside OneDrive to keep the dependency cache there instead.
  ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
  server: {
    // Respect an externally assigned port (e.g. preview tooling); default 5173.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
