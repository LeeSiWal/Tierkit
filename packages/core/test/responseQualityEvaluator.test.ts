import { describe, it, expect } from "vitest";
import { evaluateResponse } from "../src/model/ResponseQualityEvaluator.js";

const LONG_PROMPT = "x".repeat(200);

describe("ResponseQualityEvaluator", () => {
  it("acceptable when response is non-empty, terminated, no refusal", () => {
    expect(evaluateResponse("Here is the code: def foo(): pass", "stop", LONG_PROMPT))
      .toEqual({ acceptable: true });
  });

  it("flags empty text as 'empty'", () => {
    const v = evaluateResponse("   \n\t", "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "empty" });
  });

  it("flags very-short response to long prompt as 'empty'", () => {
    const v = evaluateResponse("ok", "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "empty" });
  });

  it("does NOT flag short response when prompt is also short", () => {
    expect(evaluateResponse("ok", "stop", "hi")).toEqual({ acceptable: true });
  });

  it("flags refusal at head of response", () => {
    const v = evaluateResponse("I cannot help with that request.", "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "refusal" });
  });

  it("does NOT flag content that quotes a refusal mid-response", () => {
    const text = "Here is what a refusal looks like: 'I cannot help with that'. " +
      "The fix is to retry with a clearer prompt and proper context for the model.";
    expect(evaluateResponse(text, "stop", LONG_PROMPT)).toEqual({ acceptable: true });
  });

  it("flags mid-sentence truncation when finishReason !== 'stop'", () => {
    const v = evaluateResponse("Here is the implementation that handles", "length", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "truncated" });
  });

  it("does NOT flag truncated when finishReason === 'stop' (model chose to stop here)", () => {
    expect(evaluateResponse("Here is the implementation that handles", "stop", LONG_PROMPT))
      .toEqual({ acceptable: true });
  });

  it("does NOT flag length-stop when text ends with sentence-ender", () => {
    expect(evaluateResponse("Here is the answer.", "length", LONG_PROMPT))
      .toEqual({ acceptable: true });
  });

  it("flags repetition loop", () => {
    const looped = "the answer is 42 because " + "yes ".repeat(40);
    const v = evaluateResponse(looped, "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "repetition" });
  });
});
