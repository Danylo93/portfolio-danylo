import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { realLabsPlugin } from "./server/real-labs";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Concurrent simulator/real servers must not overwrite each other's optimized dependencies.
  cacheDir: mode === "real" ? "node_modules/.vite-real" : "node_modules/.vite",
  server: {
    host: "127.0.0.1",
    port: 8080,
    strictPort: true,
    cors: false,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), ...(mode === "real" ? [realLabsPlugin()] : [])],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
