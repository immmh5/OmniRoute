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
    "qwen/qwen3-coder",
    "deepseek/deepseek",
    "gemini/gemini-2.5-pro",
  ]);
});

test("curated Omni routing uses only configured live models and orders them exactly", () => {
  const targets = [
    target("other/model", "other"),
    target("gemini/gemini-2.5-pro", "gemini"),
    target("qwen/qwen3-coder", "hf", "hf-1"),
    target("deepseek/deepseek", "deepseek"),
  ];

  const result = applyCuratedProfile("auto/omni-coding", targets);

  deepStrictEqual(result.map((item) => item.modelStr), [
    "qwen/qwen3-coder",
    "deepseek/deepseek",
    "gemini/gemini-2.5-pro",
  ]);
});

test("curated Omni routing keeps multiple HF connections for the same configured model", () => {
  const targets = [
    target("qwen/qwen3-coder", "hf", "hf-2"),
    target("qwen/qwen3-coder", "hf", "hf-1"),
    target("deepseek/deepseek", "deepseek"),
  ];

  const result = applyCuratedProfile("auto/omni-coding", targets);

  deepStrictEqual(result.map((item) => `${item.modelStr}:${item.connectionId}`), [
    "qwen/qwen3-coder:hf-1",
    "qwen/qwen3-coder:hf-2",
    "deepseek/deepseek:null",
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
