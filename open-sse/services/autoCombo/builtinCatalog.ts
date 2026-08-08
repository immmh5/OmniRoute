import type { AutoVariant } from "./autoPrefix";
import { VALID_VARIANTS } from "./autoPrefix";
import { parseAutoSuffix } from "./suffixComposition";
import { isValidModelFamily, AUTO_FAMILY_IDS } from "./modelFamily";
import { getCuratedProfile } from "./curatedRouting.ts";

export { AUTO_FAMILY_IDS };

/**
 * Built-in `auto/*` catalog → AutoVariant resolution.
 *
 * The dashboard advertises a zero-setup `auto/*` catalog (e.g. `auto/best-coding`).
 * Each catalog id maps to a router variant and is materialized into a virtual
 * auto-combo on demand via `createVirtualAutoCombo`, without requiring persisted DB
 * combo rows. Extracted from `chatHelpers.ts` so that handler stays under the
 * file-size cap and the catalog lives alongside the rest of the autoCombo service.
 */

export const VALID_AUTO_VARIANTS = new Set<AutoVariant>(VALID_VARIANTS);

export const AUTO_TEMPLATE_VARIANTS: Record<string, AutoVariant | undefined> = {
  "auto/best-coding": "coding",
  "auto/best-reasoning": "smart",
  "auto/best-fast": "fast",
  "auto/best-vision": "smart",
  "auto/best-chat": undefined,
  "auto/best-coding-fast": "fast",
  "auto/pro-coding": "coding",
  "auto/pro-reasoning": "smart",
  "auto/pro-vision": "smart",
  "auto/pro-chat": undefined,
  "auto/pro-fast": "fast",
  "auto/coding": "coding",
  "auto/fast": "fast",
  "auto/chat": undefined,
  // Omni curated profiles: same stable virtual-auto machinery, but with an
  // operator-owned exact model allowlist/order and deterministic dispatch.
  "auto/omni-coding": "coding",
  "auto/omni-reasoning": "smart",
  "auto/omni-fast": "fast",
  "auto/omni-chat": undefined,
  // #4235 Phase A: these are valid variants (parseAutoPrefix accepts them) and
  // the README advertises them, but they were missing from this catalog so
  // `/v1/models` + the dashboard never listed them. Surface them explicitly.
  "auto/cheap": "cheap",
  "auto/offline": "offline",
  "auto/smart": "smart",
  "auto/claude-opus": "smart",
  "auto/claude-sonnet": "coding",
  "auto/best-free": "cheap",
  // Chaos mode — parallel dispatch to top-N stable models
  "auto/best-chaos": "chaos",
  "auto/chaos": "chaos",
};

/**
 * #4235 Phase B — curated `auto/<category>[:<tier>]` combos advertised in `/v1/models`
 * and the dashboard. ANY valid `auto/<category>[:<tier>]` resolves on demand (so clients
 * can ask for combinations not listed here); this curated set keeps the advertised
 * catalog from exploding into the full category × tier matrix.
 */
export const AUTO_SUFFIX_VARIANTS: string[] = [
  "auto/coding:fast",
  "auto/coding:cheap",
  "auto/coding:free",
  "auto/coding:pro",
  "auto/coding:reliable",
  "auto/reasoning",
  "auto/reasoning:pro",
  "auto/vision",
  "auto/multimodal",
];

type ResolvedAutoVariant =
  { recognized: true; variant: AutoVariant | undefined } | { recognized: false };

export function resolveAutoVariant(modelStr: string, suffix: string): ResolvedAutoVariant {
  if (Object.prototype.hasOwnProperty.call(AUTO_TEMPLATE_VARIANTS, modelStr)) {
    return { recognized: true, variant: AUTO_TEMPLATE_VARIANTS[modelStr] };
  }
  if (VALID_AUTO_VARIANTS.has(suffix as AutoVariant)) {
    return { recognized: true, variant: suffix as AutoVariant };
  }
  return { recognized: false };
}

/**
 * Recognize any built-in `auto/*` id: a flat-variant template (legacy) OR a
 * `auto/<category>[:<tier>]` suffix (#4235 Phase B). Used by the chat handler to
 * decide whether an `auto/` model is a valid built-in before materializing it.
 */
export function isRecognizedBuiltinAuto(modelStr: string, suffix: string): boolean {
  return (
    resolveAutoVariant(modelStr, suffix).recognized ||
    parseAutoSuffix(suffix).valid ||
    isValidModelFamily(suffix)
  );
}

/**
 * #6328 (follow-up to #6495 / #6512): recognize built-in `auto/*` ids whose
 * intent is paid-tier only, so callers can REMOVE — not just hide — them from
 * advertised catalogs when the operator opts into `hidePaidModels`.
 *
 * Two shapes qualify as paid-tier:
 *   - flat variants prefixed `auto/pro-*` (e.g. `auto/pro-coding`)
 *   - suffix variants with the `:pro` tier (e.g. `auto/coding:pro`)
 *
 * Non-`pro` `auto/*` ids (auto/coding, auto/best-*, auto/coding:free, …) keep
 * their advertised status; the candidate-pool filter in `virtualFactory` (#6512)
 * already excludes paid backends from them at request time. `auto/<family>` ids
 * are unaffected — the family is a backend selector, not a tier.
 */
export function isPaidTierAutoId(autoId: string): boolean {
  if (typeof autoId !== "string" || !autoId.startsWith("auto/")) return false;
  const suffix = autoId.slice("auto/".length);
  if (suffix.startsWith("pro-")) return true;
  const parsed = parseAutoSuffix(suffix);
  return parsed.valid && parsed.tier === "pro";
}

function applyCuratedProfileToVirtualCombo(
  modelStr: string,
  virtualCombo: Awaited<ReturnType<typeof import("./virtualFactory.ts").createVirtualAutoCombo>>
) {
  const profile = getCuratedProfile(modelStr);
  if (!profile?.models?.length) return virtualCombo;

  const existingByModel = new Map(
    virtualCombo.models.map((entry) => [String((entry as Record<string, unknown>).model ?? ""), entry])
  );
  const models = profile.models.map((model, index) => {
    const existing = existingByModel.get(model);
    if (existing) return existing;

    const providerId = model.split("/", 1)[0] || "unknown";
    return {
      id: `omni-curated-${index + 1}-${providerId}`,
      kind: "model" as const,
      model,
      providerId,
      connectionId: null,
      weight: 1,
      label: providerId,
    };
  });

  // Curated profiles intentionally bypass the probabilistic auto scorer. The
  // attempt loop gets an exact, deterministic model order and can still fall back
  // through the remaining configured models when an upstream target fails.
  virtualCombo.models = models;
  virtualCombo.strategy = "priority";
  virtualCombo.routerStrategy = "rules";
  virtualCombo.explorationRate = 0;
  virtualCombo.candidatePool = [
    ...new Set(profile.models.map((model) => model.split("/", 1)[0]).filter(Boolean)),
  ];
  virtualCombo.autoConfig = {
    ...(virtualCombo.autoConfig || {}),
    candidatePool: virtualCombo.candidatePool,
    routerStrategy: "rules",
    explorationRate: 0,
  };
  virtualCombo.config = {
    ...(virtualCombo.config || {}),
    auto: virtualCombo.autoConfig,
  };
  return virtualCombo;
}

export async function createBuiltinAutoCombo(modelStr: string, suffix: string) {
  const { createVirtualAutoCombo } = await import("./virtualFactory.ts");

  const resolved = resolveAutoVariant(modelStr, suffix);
  if (resolved.recognized) {
    const spec = modelStr === "auto/best-free" ? { tier: "free" as const } : undefined;
    const virtualCombo = await createVirtualAutoCombo(resolved.variant, spec);
    virtualCombo.name = modelStr;
    virtualCombo.id = modelStr;
    return applyCuratedProfileToVirtualCombo(modelStr, virtualCombo);
  }

  // #4235 Phase B: `auto/<category>[:<tier>]` (e.g. auto/coding:fast, auto/vision).
  const parsed = parseAutoSuffix(suffix);
  if (parsed.valid) {
    const virtualCombo = await createVirtualAutoCombo(undefined, {
      category: parsed.category,
      tier: parsed.tier,
    });
    virtualCombo.name = modelStr;
    virtualCombo.id = modelStr;
    return virtualCombo;
  }

  // #6453: `auto/<family>` (e.g. auto/glm, auto/minimax, auto/zai, auto/mimo,
  // auto/gemma, auto/llama, auto/gemini) — spans whatever installed backends
  // currently expose that model family, degrading gracefully as backends rotate.
  if (isValidModelFamily(suffix)) {
    const virtualCombo = await createVirtualAutoCombo(undefined, { family: suffix });
    virtualCombo.name = modelStr;
    virtualCombo.id = modelStr;
    return virtualCombo;
  }

  throw new Error(`Unknown built-in auto combo: ${modelStr}`);
}
