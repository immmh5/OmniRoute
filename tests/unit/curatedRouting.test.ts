import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";

import { applyCuratedProfile, getCuratedProfile } from "../../open-sse/services/autoCombo/curatedRouting.ts";
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

test("curated Omni routing loads the operator-owned coding profile", () => {
  const profile = getCuratedProfile("auto/omni-coding");

  deepStrictEqual(profile?.models, [
    "if/qwen3-coder-plus",
    "cc/claude-sonnet-4-6",
    "gemini-cli/gemini-3-flash-preview",
    "if/deepseek-v3.2",
  ]);
});

test("curated Omni routing uses only configured live models and orders them exactly", () => {
  const targets = [
    target("other/model", "other"),
    target("gemini-cli/gemini-3-flash-preview", "gemini-cli"),
    target("if/qwen3-coder-plus", "if"),
    target("if/deepseek-v3.2", "if"),
  ];

  const result = applyCuratedProfile("auto/omni-coding", targets);

  deepStrictEqual(result.map((item) => item.modelStr), [
    "if/qwen3-coder-plus",
    "gemini-cli/gemini-3-flash-preview",
    "if/deepseek-v3.2",
  ]);
});

test("curated Omni routing keeps multiple HF connections for the same configured model", () => {
  const targets = [
    target("if/qwen3-coder-plus", "hf", "hf-2"),
    target("if/qwen3-coder-plus", "hf", "hf-1"),
    target("if/deepseek-v3.2", "if"),
  ];

  // This fixture intentionally uses HF as the provider to exercise the account
  // ranking independently from the provider prefix used by the curated model ID.
  const result = applyCuratedProfile("auto/omni-coding", targets);

  deepStrictEqual(result.map((item) => `${item.modelStr}:${item.connectionId}`), [
    "if/qwen3-coder-plus:hf-1",
    "if/qwen3-coder-plus:hf-2",
    "if/deepseek-v3.2:null",
  ]);
});

test("curated Omni routing fails open when none of the configured models is available", () => {
  const targets = [
    target("other/model-a", "other"),
    target("other/model-b", "other"),
  ];

  const result = applyCuratedProfile("auto/omni-coding", targets);

  strictEqual(result, targets);
  deepStrictEqual(result.map((item) => item.modelStr), [
    "other/model-a",
    "other/model-b",
  ]);
});
