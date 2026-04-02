import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname);

function resolveModule(specifier: string): string {
  return require.resolve(specifier, { paths: [packageRoot] });
}

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: [
      {
        find: /^agents$/,
        replacement: resolveModule("agents"),
      },
      {
        find: /^zod$/,
        replacement: resolveModule("zod"),
      },
      {
        find: /^zod\/v4$/,
        replacement: resolveModule("zod/v4"),
      },
      {
        find: /^zod\/v3$/,
        replacement: resolveModule("zod/v3"),
      },
    ],
  },
});
