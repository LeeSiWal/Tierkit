import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface RunChildOptions extends Omit<SpawnOptions, "shell" | "env"> {
  /**
   * Caller-supplied env overrides. Merged on top of process.env with
   * `undefined` values stripped — neither base undefined nor caller undefined
   * is propagated to the child.
   */
  callerEnv?: Record<string, string | undefined>;
}

/**
 * v0.17: cmd.exe-friendly quoting for Windows `shell:true` spawns. Quotes the
 * string only when it contains a shell-meaningful character; embedded quotes
 * are doubled per cmd.exe convention. Returns the input unchanged when no
 * quoting is needed.
 *
 * Used internally by runChild() when process.platform === "win32" so paths
 * like `C:\Program Files\Node\node.exe` survive the cmd.exe parse. macOS/Linux
 * passthrough is unchanged (shell:false there, so no quoting is needed).
 */
export function quoteForWindowsShell(s: string): string {
  if (!/[\s&|<>^"]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Cross-platform child-process spawn used by Tierkit's subscription-CLI provider
 * and the model viability health probe.
 *
 * On Windows, npm-installed CLIs like `claude` ship as `.cmd` shims. Node's
 * direct `spawn(command, args)` does NOT consult PATHEXT and refuses to launch
 * `.cmd` shims, returning ENOENT. We route through cmd.exe (`shell: true`) only
 * on Windows so PATHEXT resolution kicks in. On macOS/Linux we keep the direct
 * spawn — adding `/bin/sh -c` there would change quoting/escaping for command
 * values we don't fully control (user config), introducing more risk than it
 * solves.
 *
 * v0.17: on Windows we additionally apply `quoteForWindowsShell` to the command
 * and each argument so paths/values containing spaces (e.g.
 * `C:\Program Files\Node\node.exe`) reach the resolved binary intact. The
 * helper is a no-op for plain strings, so simple invocations like
 * `runChild("claude", ["--version"])` are unaffected.
 */
export function runChild(
  command: string,
  args: string[],
  opts: RunChildOptions = {},
): ChildProcess {
  const isWin = process.platform === "win32";
  const cmd = isWin ? quoteForWindowsShell(command) : command;
  const finalArgs = isWin ? args.map(quoteForWindowsShell) : args;
  return spawn(cmd, finalArgs, {
    ...opts,
    shell: isWin,
    env: mergeEnv(process.env, opts.callerEnv),
  });
}

/**
 * Merge `extra` over `base`, dropping any key whose final value is `undefined`.
 *
 * Why this matters: Node's child_process.spawn accepts `ProcessEnv` which allows
 * `undefined` in its TypeScript signature, but at runtime a stray `undefined` in
 * the env object can surface as the literal string `"undefined"` to the child.
 * Stripping at merge time keeps the child's env clean.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string") merged[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string") merged[k] = v;
      else if (v === undefined) delete merged[k];
    }
  }
  return merged;
}
