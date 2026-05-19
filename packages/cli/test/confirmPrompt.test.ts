import { describe, expect, it } from "vitest";
import { resolveConfirm } from "../src/commands/context/confirmPrompt.js";

describe("resolveConfirm", () => {
  it("TTY without --yes → 'prompt'", () => {
    expect(resolveConfirm({ tty: true, yes: false })).toEqual({ mode: "prompt" });
  });
  it("TTY with --yes → 'skip'", () => {
    expect(resolveConfirm({ tty: true, yes: true })).toEqual({ mode: "skip", note: "--yes" });
  });
  it("non-TTY without --yes → 'refuse'", () => {
    expect(resolveConfirm({ tty: false, yes: false })).toEqual({
      mode: "refuse",
      message: "use --yes to confirm in non-interactive mode",
    });
  });
  it("non-TTY with --yes → 'skip' (non-TTY)", () => {
    expect(resolveConfirm({ tty: false, yes: true })).toEqual({ mode: "skip", note: "--yes, non-TTY" });
  });
});
