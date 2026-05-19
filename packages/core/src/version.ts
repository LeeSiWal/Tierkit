/**
 * Single source of truth for the Tierkit version constant.
 *
 * tsup replaces `__TIERKIT_VERSION__` at build time with the value of
 * `packages/core/package.json#version` (see `tsup.config.ts#define`),
 * so the bundled `dist/` and downstream `.vsix` always agree with
 * `package.json`. Previously this constant lived hardcoded in two
 * separate files (`Server.ts`, `gui.ts`) and silently fell behind
 * version bumps; that is what this file replaces.
 *
 * In non-bundled execution paths (vitest, ts-node, direct tsx) the
 * placeholder is not substituted — the `typeof` guard falls back to
 * the literal `"0.0.0-dev"`. Tests do not assert on this value.
 */
declare const __TIERKIT_VERSION__: string;

export const TIERKIT_VERSION: string =
  typeof __TIERKIT_VERSION__ !== "undefined" ? __TIERKIT_VERSION__ : "0.0.0-dev";
