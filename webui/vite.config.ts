import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API server (api_server.py) defaults to http://localhost:8000.
// In dev we proxy /api (REST + WebSocket) to it so the SPA can use
// same-origin relative URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
