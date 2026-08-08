import fs from "node:fs";
import path from "node:path";
import type { ResolvedComboTarget } from "../combo/types.ts";

type CuratedProfile = {
  models?: string[];
  providerRank?: string[];
  hfAccountsRank?: string[];
};

type CuratedConfig = {
  profiles?: Record<string, CuratedProfile>;
};

let cachedConfig: CuratedConfig | null | undefined;

function loadConfig(): CuratedConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  try {
    const file = path.resolve(process.cwd(), "config/omni-routing.json");
    cachedConfig = JSON.parse(fs.readFileSync(file, "utf8")) as CuratedConfig;
  } catch {
    cachedConfig = null;
  }
  return cachedConfig;
}

export function getCuratedProfile(profileId: string): CuratedProfile | null {
  return loadConfig()?.profiles?.[profileId] ?? null;
}

function rankOf(values: string[] | undefined, value: string | undefined): number {
  if (!values || !value) return Number.POSITIVE_INFINITY;
  const index = values.indexOf(value);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/**
 * Applies the operator-owned exact model allowlist/order for one curated auto id.
 *
 * Matching is deliberately exact. Unknown live models are retained only when the
 * curated profile has no matching models, so a stale profile cannot turn routing
 * into an empty pool. Stable ordering is preserved for ties.
 */
export function applyCuratedProfile(
  profileId: string,
  targets: ResolvedComboTarget[]
): ResolvedComboTarget[] {
  const profile = getCuratedProfile(profileId);
  if (!profile || targets.length < 2) return targets;

  const modelSet = new Set(profile.models ?? []);
  const matching = targets.filter((target) => modelSet.has(target.modelStr));

  // Fail open if the configured model IDs are not currently available.
  if (matching.length === 0) return targets;

  const ordered = [...targets].sort((a, b) => {
    const aModel = rankOf(profile.models, a.modelStr);
    const bModel = rankOf(profile.models, b.modelStr);
    if (aModel !== bModel) return aModel - bModel;

    const aProvider = rankOf(profile.providerRank, a.provider);
    const bProvider = rankOf(profile.providerRank, b.provider);
    if (aProvider !== bProvider) return aProvider - bProvider;

    if (a.provider === "hf" && b.provider === "hf") {
      const aAccount = rankOf(profile.hfAccountsRank, a.connectionId ?? undefined);
      const bAccount = rankOf(profile.hfAccountsRank, b.connectionId ?? undefined);
      if (aAccount !== bAccount) return aAccount - bAccount;
    }

    return 0;
  });

  return ordered;
}
