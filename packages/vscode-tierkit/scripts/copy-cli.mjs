/**
 * Copy the self-contained Tierkit CLI bundle into the extension folder so it
 * ships inside the .vsix.
 *
 * Why this exists:
 *   - Claude Code spawns each MCP server as a child process. The MCP entry we
 *     write into ~/.claude.json (or .mcp.json) names a `command` to run.
 *   - If we name `"tierkit"`, the user must have `npm i -g @tierkit/cli` first
 *     — which the average user hasn't done. The spawn fails with ENOENT and
 *     Claude Code shows `tierkit ✗ Failed` in /mcp.
 *   - Bundling the CLI inside the .vsix means the extension always has a
 *     reachable absolute path to a working `tierkit mcp serve` entry point —
 *     no global install required.
 *
 * Pairs with `extension.ts` which surfaces context.extensionPath/cli/index.js
 * to the daemon so the MCP entry uses it as the spawn target via Electron-as-
 * Node (process.execPath + ELECTRON_RUN_AS_NODE=1).
 */
import { copyFile, mkdir, rm, stat, chmod } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliSrc = path.resolve(extensionDir, "../cli/dist/index.js");
const cliDest = path.join(extensionDir, "cli", "index.js");

async function main() {
  // Refuse to ship a vsix without the CLI bundle — better to fail the build
  // than to ship a connect button that always shows "Failed" in /mcp.
  let s;
  try {
    s = await stat(cliSrc);
  } catch (err) {
    console.error(`[copy-cli] CLI bundle missing at ${cliSrc}.`);
    console.error("  Run \`pnpm -F @tierkit/cli build\` before packaging the vsix.");
    process.exit(1);
  }
  if (!s.isFile()) {
    console.error(`[copy-cli] ${cliSrc} is not a regular file. Aborting.`);
    process.exit(1);
  }
  // Sanity check size — a stale-pre-noExternal CLI is ~80 KB; the self-
  // contained bundle is ~750 KB+. Fail loud if we'd ship a broken thin one
  // (it would crash at runtime trying to require @tierkit/core).
  if (s.size < 300_000) {
    console.error(`[copy-cli] CLI bundle at ${cliSrc} is only ${s.size} bytes —`);
    console.error("  expected a self-contained bundle ≥ 300 KB. The CLI's");
    console.error("  tsup.config.ts must have \`noExternal\` set for the");
    console.error("  workspace packages. Aborting to prevent shipping a broken vsix.");
    process.exit(1);
  }

  await rm(path.dirname(cliDest), { recursive: true, force: true });
  await mkdir(path.dirname(cliDest), { recursive: true });
  await copyFile(cliSrc, cliDest);
  // Mark executable so a future direct `cliPath` spawn (without node) works.
  // The Electron-as-Node path doesn't need this, but it doesn't hurt.
  await chmod(cliDest, 0o755);
  console.log(`[copy-cli] ${(s.size / 1024).toFixed(1)} KB → cli/index.js`);
}

await main();
