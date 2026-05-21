import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Build-time version-sync guard.
//
// The extension imports from @tierkit/core, whose dist/index.js bakes in
// TIERKIT_VERSION as a string literal at core's build time (driven by core's
// own package.json via packages/core/tsup.config.ts). Because the vsix uses
// `noExternal: [/@tierkit\//]` it inlines that literal verbatim — esbuild's
// `define` here can't reach into an already-compiled module string. If we ship
// a vsix where vscode-tierkit/package.json was bumped but core was not, the
// runtime VERSION (/v1/health, status bar, GUI_BUILD_VERSION) reports the
// stale core version. This has bitten us twice (0.10.12↔0.11.0, 0.12.3↔0.13.0).
//
// Catch the mismatch here at build time so the vsix is never produced with
// inconsistent versions.
const here = dirname(fileURLToPath(import.meta.url));
const selfPkg = JSON.parse(
  readFileSync(resolve(here, "package.json"), "utf8"),
) as { version: string };
const corePkg = JSON.parse(
  readFileSync(resolve(here, "../core/package.json"), "utf8"),
) as { version: string };

if (selfPkg.version !== corePkg.version) {
  throw new Error(
    `[tierkit-vscode] version mismatch:\n` +
      `  packages/vscode-tierkit/package.json: ${selfPkg.version}\n` +
      `  packages/core/package.json:           ${corePkg.version}\n\n` +
      `These MUST match — the vsix inlines @tierkit/core's compiled\n` +
      `TIERKIT_VERSION string, so a mismatched core version surfaces in\n` +
      `/v1/health, the status bar, and the GUI version banner.\n\n` +
      `Fix: run \`pnpm bump ${selfPkg.version}\` from the repo root to sync\n` +
      `every package.json, then rebuild.`,
  );
}

export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  // VS Code extension host runs CommonJS; we ship CJS even though the rest of the monorepo is ESM.
  outExtension: () => ({ js: ".js" }),
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: false,
  treeshake: true,
  external: ["vscode"],
  // VS Code extensions must ship as a single self-contained file. Inline the workspace
  // packages (@tierkit/core, @tierkit/client) so the .vsix doesn't need a separate
  // node_modules tree — without this, esbuild would treat them as external dependencies
  // and the extension would fail to resolve them at runtime in the .vsix.
  noExternal: [/@tierkit\//],
});
