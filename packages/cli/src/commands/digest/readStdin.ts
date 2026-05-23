import fs from "node:fs/promises";

/**
 * Read text from a positional arg, --file path, or stdin (in that order).
 * Returns `undefined` if none of the three produces non-empty content.
 *
 * Stdin is consumed only when it's not a TTY (the user piped something in).
 * Reading from a TTY would block forever, so we skip it explicitly.
 */
export async function readTextInput(
  positional: string | undefined,
  filePath: string | undefined,
  stdin: NodeJS.ReadableStream,
): Promise<string | undefined> {
  if (positional !== undefined && positional.length > 0) return positional;
  if (filePath !== undefined && filePath.length > 0) {
    return await fs.readFile(filePath, "utf8");
  }
  // process.stdin.isTTY is `true` when attached to a terminal, `undefined` when piped.
  // Read stdin only when it's not a TTY (piped / redirected).
  if (!(stdin as { isTTY?: boolean }).isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return undefined;
    return Buffer.concat(chunks).toString("utf8");
  }
  return undefined;
}
