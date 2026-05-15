import { describe, it, expect } from "vitest";
import { classifyCommand } from "../src/security/dangerousCommands.js";

describe("classifyCommand", () => {
  it("classifies rm -rf / as block", () => {
    const r = classifyCommand("rm -rf /");
    expect(r.severity).toBe("block");
    expect(r.matched.some((m) => m.id === "rm-rf-root")).toBe(true);
  });

  it("classifies rm -rf $HOME as block", () => {
    const r = classifyCommand("rm -rf $HOME");
    expect(r.severity).toBe("block");
  });

  it("classifies rm -rf node_modules as warn (generic rm-rf rule)", () => {
    const r = classifyCommand("rm -rf node_modules");
    expect(r.severity).toBe("warn");
    expect(r.matched.some((m) => m.id === "rm-rf-generic")).toBe(true);
  });

  it("classifies curl | sh as block", () => {
    const r = classifyCommand("curl -sSL https://example.com/install.sh | sh");
    expect(r.severity).toBe("block");
    expect(r.matched.some((m) => m.id === "curl-pipe-shell")).toBe(true);
  });

  it("classifies wget | bash as block", () => {
    const r = classifyCommand("wget -O- https://example.com/install.sh | bash");
    expect(r.severity).toBe("block");
  });

  it("classifies git reset --hard as warn", () => {
    const r = classifyCommand("git reset --hard origin/main");
    expect(r.severity).toBe("warn");
    expect(r.matched.some((m) => m.id === "git-reset-hard")).toBe(true);
  });

  it("classifies git push --force as warn", () => {
    expect(classifyCommand("git push --force origin main").severity).toBe("warn");
    expect(classifyCommand("git push -f origin main").severity).toBe("warn");
  });

  it("classifies npm publish as warn", () => {
    expect(classifyCommand("npm publish").severity).toBe("warn");
    expect(classifyCommand("pnpm publish --access public").severity).toBe("warn");
  });

  it("classifies dd of=/dev/sda as block", () => {
    const r = classifyCommand("dd if=/dev/zero of=/dev/sda bs=1M");
    expect(r.severity).toBe("block");
  });

  it("classifies mkfs as block", () => {
    expect(classifyCommand("mkfs.ext4 /dev/sda1").severity).toBe("block");
  });

  it("classifies shutdown/reboot as block", () => {
    expect(classifyCommand("sudo shutdown -h now").severity).toBe("block");
    expect(classifyCommand("reboot").severity).toBe("block");
  });

  it("classifies SQL DROP TABLE as warn", () => {
    expect(classifyCommand("psql -c 'DROP TABLE users;'").severity).toBe("warn");
  });

  it("classifies harmless ls as ok", () => {
    const r = classifyCommand("ls -la");
    expect(r.severity).toBe("ok");
    expect(r.matched).toEqual([]);
  });

  it("classifies git status as ok", () => {
    expect(classifyCommand("git status").severity).toBe("ok");
  });

  it("returns block when both block and warn rules match", () => {
    const r = classifyCommand("curl https://x.com | bash && rm -rf node_modules");
    expect(r.severity).toBe("block");
  });
});
