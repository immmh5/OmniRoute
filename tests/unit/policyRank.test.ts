import { describe, expect, it, vi } from "vitest";

import { applyPolicyRank } from "../../open-sse/services/combo/policyRank.ts";
import type { ResolveComboTargetPipelineDeps } from "../../open-sse/services/combo/targetResolution.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

function target(
  modelStr: string,
  provider: string,
  connectionId: string | null = null
): ResolvedComboTarget {
  return {
    modelStr,
    provider,
    connectionId,
    executionKey: `${modelStr}:${connectionId ?? "none"}`,
  } as ResolvedComboTarget;
}

function deps(body: Record<string, unknown>): ResolveComboTargetPipelineDeps {
  return {
    body,
    combo: {} as ResolveComboTargetPipelineDeps["combo"],
    strategy: "auto",
    config: {} as ResolveComboTargetPipelineDeps["config"],
    apiKeyAllowedConnections: null,
    log: { info: vi.fn(), warn: vi.fn() } as ResolveComboTargetPipelineDeps["log"],
    resilienceSettings: {} as ResolveComboTargetPipelineDeps["resilienceSettings"],
    handleSingleModelWithTimeout: vi.fn() as unknown as ResolveComboTargetPipelineDeps["handleSingleModelWithTimeout"],
    buildAutoCandidates: vi.fn() as unknown as ResolveComboTargetPipelineDeps["buildAutoCandidates"],
  };
}

describe("applyPolicyRank", () => {
  it("matches modelStr exactly and preserves relative order for ties", () => {
    const targets = [
      target("gemini/gemini-3.1-pro-preview", "gemini"),
      target("qwen-cloud/qwen3.7-max-2026-06-08", "qwen-cloud"),
      target("qwen-cloud/qwen3.7-plus", "qwen-cloud"),
      target("qwen-cloud/qwen3.7-max-2026-06-08-extra", "qwen-cloud"),
    ];

    const result = applyPolicyRank(
      deps({ messages: [{ role: "user", content: "debug this code" }] }),
      targets
    );

    expect(result.map((item) => item.modelStr)).toEqual([
      "qwen-cloud/qwen3.7-max-2026-06-08",
      "gemini/gemini-3.1-pro-preview",
      "qwen-cloud/qwen3.7-plus",
      "qwen-cloud/qwen3.7-max-2026-06-08-extra",
    ]);
  });

  it("ranks HF accounts only within HF and keeps non-HF ordering intact", () => {
    const targets = [
      target("qwen-cloud/qwen3.7-plus", "qwen-cloud"),
      target("hf/Qwen/Qwen2.5-7B-Instruct", "hf", "hf-2"),
      target("hf/Qwen/Qwen2.5-7B-Instruct", "hf", "hf-1"),
      target("deepseek/deepseek-v4-flash", "deepseek"),
    ];

    const result = applyPolicyRank(
      deps({ messages: [{ role: "user", content: "hello" }] }),
      targets
    );

    expect(result.map((item) => item.connectionId)).toEqual([null, "hf-1", "hf-2", null]);
  });
});
