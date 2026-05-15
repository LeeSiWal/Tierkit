import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  startSession,
  getCurrentSession,
  advanceSession,
  approvePlan,
  abandonSession,
  SessionError,
} from "../src/usecases/session.js";

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-session-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(
    path.join(root, "tierkit.config.json"),
    JSON.stringify({ version: "0.1", modelProfiles: {} }),
  );
  return root;
}

describe("session usecases", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("startSession creates a planning-state session and persists it", async () => {
    root = await makeProject();
    const r = await startSession({ cwd: root, task: "refactor auth" });
    expect(r.session.state).toBe("planning");
    expect(r.session.task).toBe("refactor auth");
    expect(r.replacedPrevious).toBe(false);

    const cur = await getCurrentSession({ cwd: root });
    expect(cur.session?.id).toBe(r.session.id);
  });

  it("starting a new session abandons the previous one", async () => {
    root = await makeProject();
    const first = await startSession({ cwd: root, task: "a" });
    const second = await startSession({ cwd: root, task: "b" });
    expect(second.replacedPrevious).toBe(true);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("advanceSession transitions state + records history", async () => {
    root = await makeProject();
    await startSession({ cwd: root, task: "x" });
    const s = await advanceSession({ cwd: root, toState: "implementing", reason: "ready" });
    expect(s.state).toBe("implementing");
    expect(s.history[s.history.length - 1]?.to).toBe("implementing");
    expect(s.history[s.history.length - 1]?.reason).toBe("ready");
  });

  it("advanceSession to done clears the current pointer", async () => {
    root = await makeProject();
    await startSession({ cwd: root, task: "x" });
    await advanceSession({ cwd: root, toState: "implementing" });
    await advanceSession({ cwd: root, toState: "reviewing" });
    await advanceSession({ cwd: root, toState: "done" });
    const cur = await getCurrentSession({ cwd: root });
    expect(cur.session).toBeUndefined();
  });

  it("approvePlan flips planApproved=true", async () => {
    root = await makeProject();
    await startSession({ cwd: root, task: "x" });
    const s = await approvePlan({ cwd: root });
    expect(s.planApproved).toBe(true);
  });

  it("approvePlan rejects when state is not planning", async () => {
    root = await makeProject();
    await startSession({ cwd: root, task: "x" });
    await advanceSession({ cwd: root, toState: "implementing" });
    await expect(approvePlan({ cwd: root })).rejects.toBeInstanceOf(SessionError);
  });

  it("abandonSession clears the pointer and records history", async () => {
    root = await makeProject();
    await startSession({ cwd: root, task: "x" });
    const s = await abandonSession({ cwd: root, reason: "stale" });
    expect(s?.state).toBe("abandoned");
    expect(s?.history[s.history.length - 1]?.reason).toBe("stale");
    const cur = await getCurrentSession({ cwd: root });
    expect(cur.session).toBeUndefined();
  });

  it("abandonSession on no current returns undefined", async () => {
    root = await makeProject();
    const s = await abandonSession({ cwd: root });
    expect(s).toBeUndefined();
  });

  it("advanceSession with no current session throws SessionError(no-session)", async () => {
    root = await makeProject();
    await expect(advanceSession({ cwd: root, toState: "implementing" })).rejects.toMatchObject({
      name: "SessionError",
      code: "no-session",
    });
  });
});
