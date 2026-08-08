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
  // Omni curated profiles: same virtual-auto machinery, but with an
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
 * already excludes paid backends from them at request time. Default behavior is
 * fail-open when a curated profile has no currently available model.
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
  if (!profile?.models?.length || virtualCombo.models.length === 0) return virtualCombo;

  const availableByModel = new Map(
    virtualCombo.models.map((entry) => [String((entry as Record<string, unknown>).model ?? ""), entry])
  );

  // Never manufacture a target for a configured model that is not currently
  // connected. Only real candidates from the virtual factory may enter the curated
  // combo. This is critical for OAuth/API-key rotation and prevents a stale config
  // from creating guaranteed auth failures.
  const selectedModels = profile.models
    .map((model) => availableByModel.get(model))
    .filter((entry): entry is (typeof virtualCombo.models)[number] => Boolean(entry));

  // Fail open: if none of our configured models is currently available, keep the
  // normal OmniRoute virtual-auto pool rather than returning an empty combo.
  if (selectedModels.length === 0) return virtualCombo;

  virtualCombo.models = selectedModels;
  virtualCombo.strategy = "priority";
  virtualCombo.routerStrategy = "rules";
  virtualCombo.explorationRate = 0;

  const providerPool = [...new Set(selectedModels.map((entry) => entry.providerId).filter(Boolean))];
  virtualCombo.candidatePool = providerPool;
  virtualCombo.autoConfig = {
    ...(virtualCombo.autoConfig || {}),
    candidatePool: providerPool,
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
