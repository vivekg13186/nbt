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
    // antd is one ~930 kB vendor chunk we can't split meaningfully (gzips to
    // ~290 kB); everything heavier is lazy-loaded, so this limit just silences
    // the warning for that single unavoidable chunk.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // split big vendors into cacheable chunks; combined with lazy-loaded
        // views, codemirror/xterm/litegraph stay out of the initial bundle.
        manualChunks: {
          react: ["react", "react-dom"],
          antd: ["antd"],
          codemirror: [
            "@uiw/react-codemirror",
            "@codemirror/lang-json",
            "@codemirror/lang-html",
            "@codemirror/lang-javascript",
            "@codemirror/lang-python",
            "@uiw/codemirror-theme-vscode",
            "@uiw/codemirror-theme-github",
            "@uiw/codemirror-theme-material",
          ],
          xterm: ["@xterm/xterm", "@xterm/addon-fit"],
          litegraph: ["litegraph.js"],
        },
      },
    },
  },
});
