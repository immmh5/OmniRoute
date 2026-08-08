import { describe, expect, it } from "vitest";

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

describe("curated Omni routing", () => {
  it("loads the operator-owned coding profile", () => {
    const profile = getCuratedProfile("auto/omni-coding");

    expect(profile?.models).toEqual([
      "qwen/qwen3-coder",
      "deepseek/deepseek",
      "gemini/gemini-2.5-pro",
    ]);
  });

  it("orders configured models exactly and keeps unknown live targets as fallback", () => {
    const targets = [
      target("other/model", "other"),
      target("gemini/gemini-2.5-pro", "gemini"),
      target("qwen/qwen3-coder", "hf", "hf-1"),
      target("deepseek/deepseek", "deepseek"),
    ];

    const result = applyCuratedProfile("auto/omni-coding", targets);

    expect(result.map((item) => item.modelStr)).toEqual([
      "qwen/qwen3-coder",
      "deepseek/deepseek",
      "gemini/gemini-2.5-pro",
      "other/model",
    ]);
  });

  it("fails open when none of the configured models is currently available", () => {
    const targets = [
      target("other/model-a", "other"),
      target("other/model-b", "other"),
    ];

    const result = applyCuratedProfile("auto/omni-coding", targets);

    expect(result.map((item) => item.modelStr)).toEqual([
      "other/model-a",
      "other/model-b",
    ]);
  });
});
