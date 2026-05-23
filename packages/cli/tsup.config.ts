import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: false,
  treeshake: true,
  banner: { js: "#!/usr/bin/env node" },
  // v0.20.7: inline every dep so the CLI is one self-contained file. The vsix
  // ships this file and Claude Code spawns it via Electron-as-Node — no global
  // `tierkit` install required on the user's machine.
  noExternal: [/@tierkit\//, /^clipanion/, /^typanion/, /^zod/],
});
