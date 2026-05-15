import { defineConfig } from "tsup";

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
