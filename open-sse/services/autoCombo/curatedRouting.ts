import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

function resolveConfigPath(): string {
  const configured = process.env.OMNIROUTE_OMNI_ROUTING_CONFIG_PATH?.trim();
  if (configured) return path.resolve(configured);

  const cwdPath = path.resolve(process.cwd(), "config/omni-routing.json");
  if (fs.existsSync(cwdPath)) return cwdPath;

  // `process.cwd()` is not guaranteed to be the repository root in Next.js
  // standalone/packaged execution. Resolve from this module as a source-tree fallback.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "../../../config/omni-routing.json");
}

function loadConfig(): CuratedConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  try {
    cachedConfig = JSON.parse(fs.readFileSync(resolveConfigPath(), "utf8")) as CuratedConfig;
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
 * Matching is deliberately exact. When at least one configured model is live,
 * unlisted models are excluded from the curated result. If none of the configured
 * models is live, the function fails open to the original targets so stale config
 * cannot turn routing into an empty pool. Stable ordering is preserved for ties.
 */
export function applyCuratedProfile(
  profileId: string,
  targets: ResolvedComboTarget[]
): ResolvedComboTarget[] {
  const profile = getCuratedProfile(profileId);
  if (!profile || targets.length === 0) return targets;

  const modelSet = new Set(profile.models ?? []);
  const matching = targets.filter((target) => modelSet.has(target.modelStr));

  if (matching.length === 0) return targets;

  return [...matching].sort((a, b) => {
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
}

/** Internal test helper: force the next profile read from disk. */
export function resetCuratedRoutingConfigCacheForTests(): void {
  cachedConfig = undefined;
}
