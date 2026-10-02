import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const api = process.env.API_URL ?? "http://localhost:8787";

/**
 * motion/react re-exports framer-motion through a top-level `const motion = fm.motion`. While any lazy chunk
 * imports `motion`, that read keeps the full component (every animation, gesture and layout feature, ~115 kB)
 * as a static dependency of every chunk that imports motion/react, the main chunk included, which defeats
 * LazyMotion. framer-motion's own ESM entry (the exact package instance motion/react wraps, so React contexts
 * are shared) exports the same API with plain re-exports, so unused features tree-shake again.
 */
const require = createRequire(import.meta.url);
const motionDir = dirname(require.resolve("motion/package.json"));
const framerMotionEsm = join(dirname(require.resolve("framer-motion/package.json", { paths: [motionDir] })), "dist/es/index.mjs");

/**
 * Writes `.br` and `.gz` siblings for built JS, CSS, SVG and JSON so the server can send them precompressed
 * (max quality, once, at build time). index.html is skipped: the server rewrites its meta tags per request.
 */
function precompress(): Plugin {
  const br = promisify(brotliCompress);
  const gz = promisify(gzip);
  return {
    name: "pb-precompress",
    apply: "build",
    async writeBundle(options, bundle) {
      const dir = options.dir ?? "dist";
      const files = Object.keys(bundle).filter((f) => /\.(js|css|svg|json)$/.test(f));
      await Promise.all(
        files.map(async (f) => {
          const path = join(dir, f);
          const raw = await readFile(path);
          if (raw.length < 1024) return;
          const [b, g] = await Promise.all([
            br(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
            gz(raw, { level: 9 }),
          ]);
          await Promise.all([writeFile(`${path}.br`, b), writeFile(`${path}.gz`, g)]);
        }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      { find: /^motion\/react$/, replacement: framerMotionEsm },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/og": { target: api, changeOrigin: false },
      "/c/": { target: api, changeOrigin: false },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
