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
});
