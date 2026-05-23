import { describe, expect, it } from "vitest";
import { compressCommand } from "../src/digest/command.js";

describe("compressCommand", () => {
  it("extracts a title from the first sentence", async () => {
    const d = await compressCommand("Add a save button to the admin menu form. It should call POST /api/save.");
    expect(d.taskTitle).toContain("Add a save button");
  });

  it("identifies requirements with action verbs", async () => {
    const d = await compressCommand([
      "Add CRUD for AdminMenuForm.",
      "Implement category tab rendering.",
      "Render empty state when no categories exist.",
    ].join(" "));
    expect(d.requirements.length).toBeGreaterThanOrEqual(2);
    const all = d.requirements.join(" ");
    expect(all).toMatch(/Add|Implement|Render/);
  });

  it("extracts constraints with 'must/should/do not/keep'", async () => {
    const d = await compressCommand(
      "Add the feature. Do not modify existing routes. Keep the current state machine intact. The output must be JSON.",
    );
    const all = d.constraints.join(" ");
    expect(all).toMatch(/Do not modify/i);
    expect(all).toMatch(/Keep the current/i);
    expect(all).toMatch(/must be JSON/i);
  });

  it("handles Korean constraints", async () => {
    const d = await compressCommand(
      "관리자 메뉴에 탭을 추가해. 기존 구조는 그대로 유지하고 타입 에러가 발생하지 않게 해.",
    );
    expect(d.constraints.length).toBeGreaterThan(0);
  });

  it("identifies likely focus identifiers", async () => {
    const d = await compressCommand(
      "Refactor AdminMenuForm to use a new categoryStore from src/store/menuStore.ts",
    );
    expect(d.likelyFocus).toContain("AdminMenuForm");
    expect(d.likelyFocus).toContain("categoryStore");
    expect(d.likelyFocus).toContain("menuStore");
  });

  it("flags uncertainty hints", async () => {
    const d = await compressCommand("Maybe add a button somewhere?? I'm not sure how it should look.");
    expect(d.uncertainty.length).toBeGreaterThan(0);
  });

  it("compresses verbose input to shorter brief", async () => {
    const verbose = Array.from({ length: 50 }, () =>
      "And another thing, the form should really not break and ideally we keep all current behavior intact.",
    ).join(" ");
    const d = await compressCommand(`Add CRUD. ${verbose}`);
    expect(d.stats.afterChars).toBeLessThan(d.stats.beforeChars);
    expect(d.stats.savedTokens).toBeGreaterThan(0);
  });

  it("uses refine callback when provided", async () => {
    const d = await compressCommand("Add CRUD for menus.", {
      refine: async () => "## Task: refined brief\n- shorter requirement",
    });
    expect(d.compressed).toContain("refined brief");
    expect(d.provider).toBe("ollama");
  });

  it("falls back to rule output when refine throws", async () => {
    const d = await compressCommand("Add CRUD for menus.", {
      refine: async () => {
        throw new Error("ollama unreachable");
      },
    });
    expect(d.compressed).toContain("Task:");
    expect(d.provider).toBe("rule");
    expect(d.uncertainty.some((u) => /LLM refinement failed/.test(u))).toBe(true);
  });

  it("does not adopt refine result if it explodes in length", async () => {
    const d = await compressCommand("Add a button.", {
      refine: async () => "x".repeat(100000),
    });
    expect(d.compressed.length).toBeLessThan(50000);
    expect(d.provider).toBe("rule");
  });

  it("returns verdict not-evaluated", async () => {
    const d = await compressCommand("Add x");
    expect(d.verdict).toBe("not-evaluated");
  });
});
