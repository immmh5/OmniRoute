# OmniRoute routing policy

`config/routing-policy.json` is the human-editable source of truth for our routing preferences.

## 1. Model ordering

Each task level (`light`, `standard`, `heavy`, `critical`) has three ranking layers:

1. `modelRank` — exact model preference. Lower position = higher priority.
2. `providerRank` — tie-breaker when models have equal rank.
3. `hfAccountsRank` — final tie-breaker for Hugging Face connections.

Models not listed in `modelRank` are still eligible; they simply sort after explicitly ranked models. This is intentional so a provider/model being newly discovered does not disappear just because we forgot to add it to the file.

### Example

```json
"standard": {
  "modelRank": [
    "if/qwen3-coder-plus",
    "gemini-cli/gemini-3-flash-preview"
  ],
  "providerRank": ["if", "gemini-cli", "cc"],
  "hfAccountsRank": ["hf-1", "hf-2"]
}
```

To change the preferred order, edit only the arrays. No TypeScript change should be necessary.

## 2. Fallback philosophy

The fallback section describes the behavior we want when a target fails:

- Do not retry the same model repeatedly inside one request.
- Prefer another provider after a failure when an equivalent target exists.
- Skip targets that are currently cooling down.
- Keep a hard attempt limit so a broken request cannot loop forever.

The important distinction is **request-level fallback vs persistent cooldown**:

- Request-level fallback immediately moves to another eligible target.
- Persistent cooldown records that the failed target should not be selected again until its cooldown expires.

The cooldown does **not** mean OmniRoute sleeps for six hours. It means the failed target is temporarily removed from the candidate set and other healthy targets can be tried.

## 3. Failure classes

The current policy intentionally separates failures by severity:

| Failure | Default cooldown | Intended behavior |
| --- | ---: | --- |
| rate limit | 6h | Avoid the target for a long period; use another provider/account. |
| quota exhausted | 6h | Treat as a resource problem, not a transient retry. |
| auth error | 24h | Avoid repeatedly hammering a bad credential. |
| permission denied | 24h | Avoid until credentials/permissions change. |
| model not found | 24h | Avoid until the registry/config changes. |
| timeout | 1h | Prefer another target, then reconsider later. |
| connection error | 30m | Likely transient infrastructure failure. |
| server error | 30m | Give the provider time to recover. |
| stream error | 30m | Avoid repeated broken streams. |
| empty response | 1h | Protect the request path from known unstable targets. |
| overloaded | 1h | Prefer another provider while load is high. |
| bad request | 15m | Short cooldown; the request may have been malformed for this target. |
| unknown | 15m | Conservative temporary quarantine. |

These are policy defaults, not claims that every failure has exactly the same root cause.

## 4. Backoff

`backoff` is for repeated transient failures during one request. It is separate from the persistent target cooldown.

- Base: 30 seconds.
- Maximum: 5 minutes.
- Jitter: enabled.

The goal is to prevent synchronized retry storms while still failing over quickly when another healthy target is available.

## 5. How to tune it

The normal workflow should be:

1. Add/remove/reorder models in `modelRank`.
2. Adjust provider preference in `providerRank` only when necessary.
3. Change cooldown durations only after observing real failure patterns in logs.
4. Keep `neverRetrySameModelInRequest` enabled unless there is a specific reason to override it.
5. Keep `maxAttemptsPerRequest` bounded.

Do **not** put API keys, tokens, cookies, or other credentials in this file.

## 6. Runtime integration status

The policy file now contains both ordering and the intended resilience rules. The existing ordering integration can safely continue reading the ranking arrays. The `fallback` section is configuration for the next runtime integration step; adding these fields alone must not change existing retry behavior until the fallback engine explicitly consumes them.
