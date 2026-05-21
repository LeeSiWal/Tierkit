#!/usr/bin/env node
// Bump version across the entire monorepo atomically.
//
// Usage:  pnpm bump <new-version>
// Example: pnpm bump 0.13.0
//
// Writes the new version to:
//   - <root>/package.json
//   - packages/*/package.json  (every workspace package)
//
// Rationale: the .vsix bundle inlines @tierkit/core (with `noExternal`) which
// bakes TIERKIT_VERSION as a string literal at core's build time. If the
// extension's package.json is bumped but core's is not, the surfaced runtime
// version (/v1/health, status bar, GUI banner) lags behind. This has bitten
// us twice (0.10.12↔0.11.0, 0.12.3↔0.13.0). vscode-tierkit's tsup.config.ts
// fails the build on mismatch — this script is the way to keep them in sync.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

const newVersion = process.argv[2];
if (!newVersion) {
  fail("missing <new-version> argument. Usage: pnpm bump <new-version>");
}
if (!SEMVER_RE.test(newVersion)) {
  fail(`"${newVersion}" is not a valid semver string`);
}

function loadPkg(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writePkg(path, pkg, originalText) {
  // Preserve trailing newline if the original had one (npm convention).
  const trailingNewline = originalText.endsWith("\n") ? "\n" : "";
  writeFileSync(path, JSON.stringify(pkg, null, 2) + trailingNewline, "utf8");
}

const targets = [];

// Root
const rootPath = join(REPO_ROOT, "package.json");
targets.push({ path: rootPath, label: "<root>" });

// All workspace packages
for (const name of readdirSync(PACKAGES_DIR).sort()) {
  const dir = join(PACKAGES_DIR, name);
  if (!statSync(dir).isDirectory()) continue;
  const pkgPath = join(dir, "package.json");
  try {
    statSync(pkgPath);
  } catch {
    continue; // no package.json in this dir
  }
  targets.push({ path: pkgPath, label: `packages/${name}` });
}

let changed = 0;
let skipped = 0;
for (const t of targets) {
  const text = readFileSync(t.path, "utf8");
  const pkg = JSON.parse(text);
  const before = pkg.version;
  if (before === newVersion) {
    console.log(`  =  ${t.label}: already ${newVersion}`);
    skipped++;
    continue;
  }
  pkg.version = newVersion;
  writePkg(t.path, pkg, text);
  console.log(`  ✓  ${t.label}: ${before} → ${newVersion}`);
  changed++;
}

console.log(`\nDone. ${changed} updated, ${skipped} already at ${newVersion}.`);

if (changed > 0) {
  console.log(`\nNext steps:`);
  console.log(`  pnpm -F @tierkit/core build`);
  console.log(`  pnpm -F tierkit-vscode build`);
  console.log(`  pnpm -F tierkit-vscode package`);
  console.log(`  # then commit:`);
  console.log(`  git add -A && git commit -m "chore(release): ${newVersion}"`);
}
