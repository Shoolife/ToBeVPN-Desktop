import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Keep the source styles readable while making every real application text
// style react to the same font-scale / bold variables used by Android. Vite
// runs this for all local CSS modules before bundling, including dialogs and
// sheets, so accessibility settings are genuinely app-wide rather than a
// Settings-screen-only imitation.
function accessibleTypographyVariables(): Plugin {
  const scalePxTokens = (value: string) =>
    value.replace(/(-?\d*\.?\d+)px\b/g, "calc($1px * var(--app-font-scale, 1))");

  return {
    name: "tobevpn-accessible-typography",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?", 1)[0].endsWith(".css")) return null;
      let transformed = code.replace(
        /((?:font-size|line-height)\s*:\s*)([^;}]+)(?=[;}])/g,
        (_match, prefix: string, value: string) => `${prefix}${scalePxTokens(value)}`,
      );
      transformed = transformed.replace(
        /(font-weight\s*:\s*)(\d+)(?=\s*[;}])/g,
        (_match, prefix: string, value: string) =>
          `${prefix}clamp(100, calc(${value} + var(--app-font-weight-boost, 0)), 1000)`,
      );
      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}

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
    plugins: [accessibleTypographyVariables(), react()],

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
