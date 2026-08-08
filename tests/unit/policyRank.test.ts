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
    target("if/qwen3-coder-plus", "if"),
    target("gemini-cli/gemini-3.1-flash-lite-preview", "gemini-cli"),
    target("if/deepseek-v3.2", "if"),
    target("gemini-cli/gemini-3.1-flash-lite-preview-extra", "gemini-cli"),
  ];

  const result = applyPolicyRank(
    deps({ messages: [{ role: "user", content: "hello" }] }),
    targets
  );

  deepStrictEqual(result.map((item) => item.modelStr), [
    "gemini-cli/gemini-3.1-flash-lite-preview",
    "if/qwen3-coder-plus",
    "if/deepseek-v3.2",
    "gemini-cli/gemini-3.1-flash-lite-preview-extra",
  ]);
});

test("applyPolicyRank ranks HF accounts only within HF and keeps non-HF ordering intact", () => {
  const targets = [
    target("if/qwen3-coder-plus", "if"),
    target("if/qwen3-coder-plus", "hf", "hf-2"),
    target("if/qwen3-coder-plus", "hf", "hf-1"),
    target("if/deepseek-v3.2", "if"),
  ];

  const result = applyPolicyRank(
    deps({ messages: [{ role: "user", content: "hello" }] }),
    targets
  );

  deepStrictEqual(result.map((item) => item.connectionId), [null, "hf-1", "hf-2", null]);
});

test("applyPolicyRank keeps explicit Omni curated model order authoritative at the final stage", () => {
  const targets = [
    target("if/deepseek-v3.2", "if"),
    target("if/qwen3-coder-plus", "hf", "hf-2"),
    target("if/qwen3-coder-plus", "hf", "hf-1"),
    target("gemini-cli/gemini-3-flash-preview", "gemini-cli"),
  ];

  const result = applyPolicyRank(
    deps({ messages: [{ role: "user", content: "debug this code" }] }, "auto/omni-coding"),
    targets
  );

  deepStrictEqual(result.map((item) => `${item.modelStr}:${item.connectionId ?? "none"}`), [
    "if/qwen3-coder-plus:hf-1",
    "if/qwen3-coder-plus:hf-2",
    "gemini-cli/gemini-3-flash-preview:none",
    "if/deepseek-v3.2:none",
  ]);
});
