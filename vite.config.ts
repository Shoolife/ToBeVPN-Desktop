import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // Pull VITE_BOT_API_URL from .env (gitignored on dev machines, set as a
  // secret in CI). The dev-server proxy below uses it to forward /api/* to
  // the real backend. We deliberately do NOT hardcode the URL here — public
  // source must not contain production domains.
  // @ts-expect-error process is a nodejs global
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const proxyTarget = env.VITE_BOT_API_URL || "https://your-backend.example/";

  return {
    plugins: [react()],

    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          secure: true,
        },
      },
    },
  };
});
