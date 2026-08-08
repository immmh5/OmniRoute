# Omni Curated Routing

OmniRoute can expose operator-owned deterministic profiles under `auto/omni-*`.
These profiles are intentionally separate from the normal task-aware `auto/*` scorer.

## Available profiles

The fork currently defines:

- `auto/omni-coding`
- `auto/omni-reasoning`
- `auto/omni-fast`
- `auto/omni-chat`

The source of truth is:

```text
config/omni-routing.json
```

## Adding models

Edit the `models` array for the profile. The order is the priority order.
Use the exact OmniRoute model ID, including the provider prefix.

Example:

```json
{
  "profiles": {
    "auto/omni-coding": {
      "models": [
        "qwen/qwen3-coder",
        "deepseek/deepseek",
        "gemini/gemini-2.5-pro"
      ],
      "providerRank": ["hf", "gemini", "integrately"],
      "hfAccountsRank": ["hf-1", "hf-2"]
    }
  }
}
```

To move a model up, move its string up in `models`. No TypeScript change is required.

## What happens when a model is unavailable?

A curated profile never manufactures a fake target. At materialization time it selects
only models that are actually present in the current OmniRoute virtual candidate pool.

- If some configured models are available, only those models are used, in configured order.
- If none of the configured models is currently available, the profile fails open to the
  normal virtual-auto pool instead of producing an empty or guaranteed-auth-failing combo.
- Existing connection/account metadata is preserved, so the normal auth and fallback
  machinery can choose the actual connection.

## Provider and HF-account ordering

The final target stage applies the curated profile lexicographically:

1. exact `modelStr` order from `models`
2. exact provider order from `providerRank`
3. exact HF `connectionId` order from `hfAccountsRank` when both compared targets are HF
4. original relative order for ties

This final-stage enforcement means sticky/affinity/task-aware stages cannot silently
replace the operator's curated model order.

## Changing the order after installation

1. Edit `config/omni-routing.json`.
2. Save it.
3. Restart OmniRoute so the configuration cache is reloaded.
4. Select the corresponding `auto/omni-*` model from your client.

No database migration is required for model-order changes.

## Important distinction

`config/routing-policy.json` controls the normal task levels (`light`, `standard`,
`heavy`, `critical`). `config/omni-routing.json` controls the explicit `auto/omni-*`
profiles. The two policies are deliberately kept separate so changing the generic task
router cannot unexpectedly change a curated Omni profile.
