import fs from "node:fs";
import path from "node:path";

import { classifyTask } from "../taskAwareRouting.ts";
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

/**
 * Apply the operator's exact-match ranking policy.
 *
 * Priority is lexicographic: modelStr, provider, then HF connectionId.
 * Unlisted values receive Infinity. The original relative order is retained for
 * ties, including all unranked targets. HF account ranking is intentionally scoped
 * to HF-vs-HF comparisons so account policy never changes another provider's order.
 *
 * `auto/omni-*` is intentionally excluded: those profiles are already an explicit,
 * operator-owned model order and must remain authoritative rather than being
 * reordered by the task-level fallback policy.
 */
export function applyPolicyRank(
  deps: ResolveComboTargetPipelineDeps,
  targets: ResolvedComboTarget[]
): ResolvedComboTarget[] {
  if (!Array.isArray(targets) || targets.length <= 1) return targets;

  const comboName = typeof deps.combo?.name === "string" ? deps.combo.name : "";
  if (comboName.startsWith("auto/omni-")) return targets;

  const policy = getPolicy();
  if (!policy) return targets;

  const task = classifyTask(deps.body);
  const taskPolicy = policy[task.level];
  if (!taskPolicy) return targets;

  const ranked = targets
    .map((target, index) => ({
      target,
      index,
      modelRank: rankOf(taskPolicy.modelRank, target.modelStr),
      providerRank: rankOf(taskPolicy.providerRank, target.provider),
      connectionRank:
        target.provider === "hf"
          ? rankOf(taskPolicy.hfAccountsRank, target.connectionId ?? undefined)
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
