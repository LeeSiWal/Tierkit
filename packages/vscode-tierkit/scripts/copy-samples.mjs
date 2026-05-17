/**
 * Copy the bundled superpowers sample plugins into the extension folder so they
 * land inside the .vsix.
 *
 * Why this exists:
 *   - tsup bundles JS dependencies into dist/extension.js, but directory data
 *     files (the plugins' manifest + .md commands) can't be inlined into JS.
 *   - We package the .vsix with `vsce --no-dependencies`, so node_modules
 *     (and therefore the workspace symlink to @tierkit/plugin-superpowers) is
 *     NOT in the .vsix.
 *   - Without these files, the extension's loadBundledSamples() returns []
 *     in production → no Install dropdown rows, no first-run bootstrap.
 *
 * This script runs from `package.json` build/package scripts and produces a
 * `samples/` directory at the extension root. `.vscodeignore` whitelists it.
 */
import { cp, rm, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samplesSrc = path.resolve(extensionDir, "../plugin-superpowers/plugins");
const samplesDest = path.join(extensionDir, "samples");

async function main() {
  // Guard: refuse if the source isn't where we expect — better to fail loudly than
  // silently ship an extension with no bundled samples.
  let s;
  try {
    s = await stat(samplesSrc);
  } catch {
    console.error(`[copy-samples] source not found: ${samplesSrc}`);
    process.exit(1);
  }
  if (!s.isDirectory()) {
    console.error(`[copy-samples] source is not a directory: ${samplesSrc}`);
    process.exit(1);
  }

  await rm(samplesDest, { recursive: true, force: true });
  await cp(samplesSrc, samplesDest, { recursive: true });

  // Print a small summary so packaging logs make it obvious the samples are in.
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(samplesDest, { withFileTypes: true });
  const sampleIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  console.log(`[copy-samples] copied ${sampleIds.length} sample(s) → ${path.relative(process.cwd(), samplesDest)}`);
  for (const id of sampleIds) {
    const manifestPath = path.join(samplesDest, id, "tierkit.plugin.json");
    try {
      const m = JSON.parse(await readFile(manifestPath, "utf8"));
      console.log(`  - ${m.id} (${m.freedom?.level ?? "?"}) — ${m.name ?? id}`);
    } catch {
      console.log(`  - ${id} (no manifest readable)`);
    }
  }
}

main().catch((err) => {
  console.error(`[copy-samples] failed: ${err.message}`);
  process.exit(1);
});
