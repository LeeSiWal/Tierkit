import readline from "node:readline";

export type ConfirmDecision =
  | { mode: "prompt" }
  | { mode: "skip"; note: string }
  | { mode: "refuse"; message: string };

export function resolveConfirm(opts: { tty: boolean; yes: boolean }): ConfirmDecision {
  if (opts.tty && !opts.yes) return { mode: "prompt" };
  if (opts.tty && opts.yes) return { mode: "skip", note: "--yes" };
  if (!opts.tty && opts.yes) return { mode: "skip", note: "--yes, non-TTY" };
  return { mode: "refuse", message: "use --yes to confirm in non-interactive mode" };
}

/** Read a single line from stdin and return true on /^y(es)?$/i. */
export function readYesNo(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin as NodeJS.ReadableStream, output: stdout as NodeJS.WritableStream });
    rl.question("Continue? [y/N] ", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
