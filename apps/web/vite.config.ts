import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately under `wrangler dev` on port 8787.
// In production both are served from the same Cloudflare Worker.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
});
