import { test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

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

function deps(
  body: Record<string, unknown>,
  comboName = "test-combo"
): ResolveComboTargetPipelineDeps {
  return {
    body,
    combo: { name: comboName } as ResolveComboTargetPipelineDeps["combo"],
    strategy: "auto",
    config: {} as ResolveComboTargetPipelineDeps["config"],
    apiKeyAllowedConnections: null,
    log: { info() {}, warn() {} } as ResolveComboTargetPipelineDeps["log"],
    resilienceSettings: {} as ResolveComboTargetPipelineDeps["resilienceSettings"],
    handleSingleModelWithTimeout: (() => {}) as unknown as ResolveComboTargetPipelineDeps["handleSingleModelWithTimeout"],
    buildAutoCandidates: (() => {}) as unknown as ResolveComboTargetPipelineDeps["buildAutoCandidates"],
  };
}

test("applyPolicyRank matches modelStr exactly and preserves relative order for ties", () => {
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

  deepStrictEqual(result.map((item) => item.modelStr), [
    "qwen-cloud/qwen3.7-max-2026-06-08",
    "gemini/gemini-3.1-pro-preview",
    "qwen-cloud/qwen3.7-plus",
    "qwen-cloud/qwen3.7-max-2026-06-08-extra",
  ]);
});

test("applyPolicyRank ranks HF accounts only within HF and keeps non-HF ordering intact", () => {
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

  deepStrictEqual(result.map((item) => item.connectionId), [null, "hf-1", "hf-2", null]);
});

test("applyPolicyRank keeps explicit Omni curated model order authoritative at the final stage", () => {
  const targets = [
    target("deepseek/deepseek", "deepseek"),
    target("qwen/qwen3-coder", "hf", "hf-2"),
    target("qwen/qwen3-coder", "hf", "hf-1"),
    target("gemini/gemini-2.5-pro", "gemini"),
  ];

  const result = applyPolicyRank(
    deps({ messages: [{ role: "user", content: "debug this code" }] }, "auto/omni-coding"),
    targets
  );

  deepStrictEqual(result.map((item) => `${item.modelStr}:${item.connectionId ?? "none"}`), [
    "qwen/qwen3-coder:hf-1",
    "qwen/qwen3-coder:hf-2",
    "deepseek/deepseek:none",
    "gemini/gemini-2.5-pro:none",
  ]);
});
