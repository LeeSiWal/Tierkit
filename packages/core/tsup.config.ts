import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: false,
  treeshake: true,
  define: {
    // Replaced verbatim by esbuild at build time. Consumed by
    // src/version.ts → exported as TIERKIT_VERSION → embedded into
    // Server.ts (/v1/health) and gui.ts (GUI_BUILD_VERSION).
    __TIERKIT_VERSION__: JSON.stringify(pkg.version),
  },
});
