import fs from "node:fs";
import path from "node:path";

import { classifyTask } from "../taskAwareRouting.ts";
import { getCuratedProfile } from "../autoCombo/curatedRouting.ts";
import type { ResolvedComboTarget } from "./types.ts";
import type { ResolveComboTargetPipelineDeps } from "./targetResolution.ts";

type RoutingPolicyLevel = {
  modelRank?: string[];
  providerRank?: string[];
  hfAccountsRank?: string[];
};

type RoutingPolicy = Record<string, RoutingPolicyLevel>;

let cachedPolicy: RoutingPolicy | null | undefined;

function getPolicy(): RoutingPolicy | null {
  if (cachedPolicy !== undefined) return cachedPolicy;

  try {
    const configuredPath = process.env.OMNIROUTE_ROUTING_POLICY_PATH?.trim();
    const policyPath = configuredPath
      ? path.resolve(configuredPath)
      : path.resolve(process.cwd(), "config/routing-policy.json");
    const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as unknown;
    cachedPolicy = parsed && typeof parsed === "object" ? (parsed as RoutingPolicy) : null;
  } catch {
    cachedPolicy = null;
  }

  return cachedPolicy;
}

function rankOf(values: string[] | undefined, value: string | undefined): number {
  if (!Array.isArray(values) || !value) return Number.POSITIVE_INFINITY;
  const index = values.indexOf(value);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function rankTargets(
  targets: ResolvedComboTarget[],
  modelRank: string[] | undefined,
  providerRank: string[] | undefined,
  hfAccountsRank: string[] | undefined
): ResolvedComboTarget[] {
  return targets
    .map((target, index) => ({
      target,
      index,
      modelRank: rankOf(modelRank, target.modelStr),
      providerRank: rankOf(providerRank, target.provider),
      connectionRank:
        target.provider === "hf"
          ? rankOf(hfAccountsRank, target.connectionId ?? undefined)
          : Number.POSITIVE_INFINITY,
    }))
    .sort(
      (a, b) =>
        a.modelRank - b.modelRank ||
        a.providerRank - b.providerRank ||
        a.connectionRank - b.connectionRank ||
        a.index - b.index
    )
    .map(({ target }) => target);
}

/**
 * Apply the operator's exact-match ranking policy.
 *
 * Normal auto/combos use the task-level policy. `auto/omni-*` uses its own curated
 * profile at this same final pipeline stage, which makes the curated model order
 * authoritative even if an earlier stage (sticky/affinity/etc.) changed ordering.
 *
 * Priority is lexicographic: modelStr, provider, then HF connectionId.
 * Unlisted values receive Infinity and ties keep their original relative order.
 */
export function applyPolicyRank(
  deps: ResolveComboTargetPipelineDeps,
  targets: ResolvedComboTarget[]
): ResolvedComboTarget[] {
  if (!Array.isArray(targets) || targets.length <= 1) return targets;

  const comboName = typeof deps.combo?.name === "string" ? deps.combo.name : "";

  if (comboName.startsWith("auto/omni-")) {
    const curated = getCuratedProfile(comboName);
    if (!curated?.models?.length) return targets;

    const ranked = rankTargets(
      targets,
      curated.models,
      curated.providerRank,
      curated.hfAccountsRank
    );
    deps.log.info(
      "POLICY",
      `Curated ${comboName} | exact model order applied to ${ranked.length} targets`
    );
    return ranked;
  }

  const policy = getPolicy();
  if (!policy) return targets;

  const task = classifyTask(deps.body);
  const taskPolicy = policy[task.level];
  if (!taskPolicy) return targets;

  const ranked = rankTargets(
    targets,
    taskPolicy.modelRank,
    taskPolicy.providerRank,
    taskPolicy.hfAccountsRank
  );

  deps.log.info(
    "POLICY",
    `Task: ${task.level} | Policy Rank applied to ${ranked.length} targets`
  );
  return ranked;
}

/** Internal test helper: clear the cached policy between isolated test cases. */
export function resetPolicyRankCacheForTests(): void {
  cachedPolicy = undefined;
}
