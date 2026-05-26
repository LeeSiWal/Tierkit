import { describe, expect, it } from "vitest";
import {
  bypassedErrorGatewayTransformationMetric,
  transformAnthropicGatewayRequest,
} from "../src/runtime/gatewayTransformations.js";
import type { GatewayTransformationsConfig } from "../src/config/TierkitConfig.js";

const offConfig: GatewayTransformationsConfig = {
  mode: "off",
  toolResultEnvelope: {
    allowlistedToolNames: [],
    minInputUtf8Bytes: 20,
    preservedHeadUtf8Bytes: 8,
    preservedTailUtf8Bytes: 8,
  },
};

function config(mode: "off" | "observe" | "envelope", allowlistedToolNames: string[] = ["SyntheticRead"]): GatewayTransformationsConfig {
  return {
    mode,
    toolResultEnvelope: {
      allowlistedToolNames,
      minInputUtf8Bytes: 20,
      preservedHeadUtf8Bytes: 12,
      preservedTailUtf8Bytes: 12,
    },
  };
}

function request(content: unknown = "한글 head\n" + "x".repeat(2000) + "\ncode tail") {
  return {
    model: "claude-test",
    max_tokens: 10,
    system: "do not touch system",
    tools: [{ name: "SyntheticRead", input_schema: { type: "object" } }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "SyntheticRead", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] },
    ],
  };
}

function buf(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

describe("gatewayTransformations", () => {
  it("preserves body identity in off mode", () => {
    const raw = buf(request());
    const result = transformAnthropicGatewayRequest(raw, offConfig);
    expect(result.body).toBe(raw);
    expect(result.changed).toBe(false);
    expect(result.metric.outcome).toBe("disabled");
    expect(result.metric.inputUtf8BytesBefore).toBeNull();
  });

  it("observes eligible candidates without rewriting", () => {
    const raw = buf(request());
    const result = transformAnthropicGatewayRequest(raw, config("observe"));
    expect(result.body).toBe(raw);
    expect(result.changed).toBe(false);
    expect(result.metric).toMatchObject({
      mode: "observe",
      outcome: "observed",
      eligibleToolResultCount: 1,
      transformedToolResultCount: 0,
      reducedUtf8Bytes: 0,
    });
  });

  it("rewrites only allowlisted tool results above threshold", () => {
    const raw = buf(request());
    const result = transformAnthropicGatewayRequest(raw, config("envelope"));
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(result.body.toString("utf8"));
    const content = parsed.messages[1].content[0].content as string;
    expect(content).toContain("[TIERKIT_TOOL_RESULT_ENVELOPE_V1]");
    expect(content).toContain("tool: SyntheticRead");
    expect(content).toContain("original_utf8_bytes:");
    expect(content).toContain("content_sha256:");
    expect(content).toContain("preserved_head:");
    expect(content).toContain("preserved_tail:");
    expect(content).toContain("omitted_utf8_bytes:");
    expect(content).not.toContain("x".repeat(2000));
    expect(result.metric.outcome).toBe("transformed");
    expect(result.metric.transformedToolResultCount).toBe(1);
    expect(result.metric.inputUtf8BytesBefore! - result.metric.inputUtf8BytesAfter!).toBe(result.metric.reducedUtf8Bytes);
  });

  it("does not rewrite when allowlist is empty or does not include the tool", () => {
    const raw = buf(request());
    const result = transformAnthropicGatewayRequest(raw, config("envelope", []));
    expect(result.body).toBe(raw);
    expect(result.metric.outcome).toBe("bypassed_ineligible");
    expect(result.metric.eligibleToolResultCount).toBe(1);
  });

  it("does not rewrite when tool name correlation is unavailable", () => {
    const raw = buf({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "x".repeat(2000) }] }] });
    const result = transformAnthropicGatewayRequest(raw, config("envelope"));
    expect(result.body).toBe(raw);
    expect(result.metric.eligibleToolResultCount).toBe(0);
  });

  it("does not rewrite short, error, or unsupported structured results", () => {
    const short = transformAnthropicGatewayRequest(buf(request("short")), config("envelope"));
    expect(short.body.toString("utf8")).toBe(buf(request("short")).toString("utf8"));

    const errReq = request("x".repeat(2000));
    (errReq.messages[1].content[0] as any).is_error = true;
    expect(transformAnthropicGatewayRequest(buf(errReq), config("envelope")).changed).toBe(false);

    const imageReq = request([{ type: "image", source: { type: "base64", data: "abc" } }]);
    expect(transformAnthropicGatewayRequest(buf(imageReq), config("envelope")).changed).toBe(false);
  });

  it("rewrites only eligible entries among multiple tool_results", () => {
    const multi = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "SyntheticRead", input: {} },
            { type: "tool_use", id: "toolu_2", name: "OtherTool", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "A".repeat(2000) },
            { type: "tool_result", tool_use_id: "toolu_2", content: "B".repeat(2000) },
          ],
        },
      ],
    };
    const result = transformAnthropicGatewayRequest(buf(multi), config("envelope", ["SyntheticRead"]));
    const parsed = JSON.parse(result.body.toString("utf8"));
    expect(parsed.messages[1].content[0].content).toContain("[TIERKIT_TOOL_RESULT_ENVELOPE_V1]");
    expect(parsed.messages[1].content[1].content).toBe("B".repeat(2000));
    expect(result.metric.eligibleToolResultCount).toBe(2);
    expect(result.metric.transformedToolResultCount).toBe(1);
  });

  it("preserves UTF-8 character boundaries and is deterministic", () => {
    const raw = buf(request("가나다라마바".repeat(400) + "\nfunction hello() { return 1; }\n"));
    const a = transformAnthropicGatewayRequest(raw, config("envelope"));
    const b = transformAnthropicGatewayRequest(raw, config("envelope"));
    expect(a.body.toString("utf8")).toBe(b.body.toString("utf8"));
    const content = JSON.parse(a.body.toString("utf8")).messages[1].content[0].content as string;
    expect(content).toContain("가나다라");
    expect(content).not.toContain("\uFFFD");
  });

  it("can produce a safe fail-open metric for caller catch blocks", () => {
    expect(bypassedErrorGatewayTransformationMetric("envelope")).toEqual({
      mode: "envelope",
      outcome: "bypassed_error",
      ruleId: "tool_result_envelope_v1",
      eligibleToolResultCount: 0,
      transformedToolResultCount: 0,
      inputUtf8BytesBefore: null,
      inputUtf8BytesAfter: null,
      reducedUtf8Bytes: null,
    });
  });
});
