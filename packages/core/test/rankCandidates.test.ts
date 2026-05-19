import { describe, expect, it } from "vitest";
import { rankCandidates, type CandidateInput } from "../src/context-compression/rankCandidates.js";

const NOW = Date.now();
const day = 86_400_000;

const candidate = (over: Partial<CandidateInput>): CandidateInput => ({
  path: "src/file.ts",
  matchedTerms: ["foo"],
  termHitCount: 1,
  sizeBytes: 1000,
  mtimeMs: NOW,
  ...over,
});

describe("rankCandidates", () => {
  it("returns top-N by score", () => {
    const cands: CandidateInput[] = [
      candidate({ path: "a.ts", termHitCount: 1 }),
      candidate({ path: "b.ts", termHitCount: 5 }),
      candidate({ path: "c.ts", termHitCount: 3 }),
    ];
    const result = rankCandidates({ candidates: cands, keywords: ["foo"], maxFiles: 2, now: NOW });
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("b.ts");
    expect(result[1].path).toBe("c.ts");
  });

  it("termHitScore dominates mtimeBonus (older file with more hits wins)", () => {
    const cands: CandidateInput[] = [
      candidate({ path: "old.ts", termHitCount: 10, mtimeMs: NOW - 365 * day }),
      candidate({ path: "new.ts", termHitCount: 1, mtimeMs: NOW }),
    ];
    const result = rankCandidates({ candidates: cands, keywords: ["foo"], maxFiles: 2, now: NOW });
    expect(result[0].path).toBe("old.ts");
  });

  it("applies pathBonus when any keyword appears in path", () => {
    const cands: CandidateInput[] = [
      candidate({ path: "src/payment-utils.ts", termHitCount: 1, matchedTerms: ["payment"] }),
      candidate({ path: "src/random.ts", termHitCount: 1, matchedTerms: ["payment"] }),
    ];
    const result = rankCandidates({ candidates: cands, keywords: ["payment"], maxFiles: 2, now: NOW });
    const withPath = result.find((r) => r.path === "src/payment-utils.ts")!;
    const without = result.find((r) => r.path === "src/random.ts")!;
    expect(withPath.pathBonus).toBeGreaterThan(0);
    expect(without.pathBonus).toBe(0);
    expect(withPath.score).toBeGreaterThan(without.score);
  });

  it("decays mtimeBonus exponentially with age", () => {
    const cands: CandidateInput[] = [
      candidate({ path: "fresh.ts", mtimeMs: NOW }),
      candidate({ path: "month_old.ts", mtimeMs: NOW - 30 * day }),
      candidate({ path: "year_old.ts", mtimeMs: NOW - 365 * day }),
    ];
    const result = rankCandidates({ candidates: cands, keywords: ["foo"], maxFiles: 3, now: NOW });
    const fresh = result.find((r) => r.path === "fresh.ts")!;
    const monthOld = result.find((r) => r.path === "month_old.ts")!;
    const yearOld = result.find((r) => r.path === "year_old.ts")!;
    expect(fresh.mtimeBonus).toBeGreaterThan(monthOld.mtimeBonus);
    expect(monthOld.mtimeBonus).toBeGreaterThan(yearOld.mtimeBonus);
  });

  it("breaks ties deterministically by path (alphabetical)", () => {
    const cands: CandidateInput[] = [
      candidate({ path: "z.ts", termHitCount: 1, mtimeMs: NOW }),
      candidate({ path: "a.ts", termHitCount: 1, mtimeMs: NOW }),
      candidate({ path: "m.ts", termHitCount: 1, mtimeMs: NOW }),
    ];
    const result = rankCandidates({ candidates: cands, keywords: ["foo"], maxFiles: 3, now: NOW });
    expect(result.map((r) => r.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("sets language from extension", () => {
    const cands: CandidateInput[] = [
      candidate({ path: "a.ts" }),
      candidate({ path: "b.tsx" }),
      candidate({ path: "c.py" }),
      candidate({ path: "d.unknown" }),
    ];
    const result = rankCandidates({ candidates: cands, keywords: ["foo"], maxFiles: 4, now: NOW });
    const byPath = new Map(result.map((r) => [r.path, r]));
    expect(byPath.get("a.ts")?.language).toBe("ts");
    expect(byPath.get("b.tsx")?.language).toBe("tsx");
    expect(byPath.get("c.py")?.language).toBe("py");
    expect(byPath.get("d.unknown")?.language).toBe("other");
  });
});
