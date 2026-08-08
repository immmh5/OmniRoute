import fs from "node:fs";
import path from "node:path";

export type RoutingFailureClass =
  | "rate_limit"
  | "quota_exhausted"
  | "auth_error"
  | "permission_denied"
  | "model_not_found"
  | "timeout"
  | "connection_error"
  | "server_error"
  | "stream_error"
  | "empty_response"
  | "overloaded"
  | "bad_request"
  | "unknown";

type CooldownConfig = Partial<Record<RoutingFailureClass, string>>;

type RoutingPolicy = {
  fallback?: {
    enabled?: boolean;
    maxAttemptsPerRequest?: number;
    neverRetrySameModelInRequest?: boolean;
    preferDifferentProviderAfterFailure?: boolean;
    skipCoolingTargets?: boolean;
    cooldown?: CooldownConfig;
  };
};

type CooldownEntry = {
  key: string;
  until: number;
  reason: RoutingFailureClass;
  updatedAt: number;
};

const DEFAULT_COOLDOWNS: Record<RoutingFailureClass, number> = {
  rate_limit: 6 * 60 * 60_000,
  quota_exhausted: 6 * 60 * 60_000,
  auth_error: 24 * 60 * 60_000,
  permission_denied: 24 * 60 * 60_000,
  model_not_found: 24 * 60 * 60_000,
  timeout: 60 * 60_000,
  connection_error: 30 * 60_000,
  server_error: 30 * 60_000,
  stream_error: 30 * 60_000,
  empty_response: 60 * 60_000,
  overloaded: 60 * 60_000,
  bad_request: 15 * 60_000,
  unknown: 15 * 60_000,
};

const memory = new Map<string, CooldownEntry>();
let loaded = false;
let policy: RoutingPolicy = {};

function dataRoot(): string {
  return process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), "data");
}

function statePath(): string {
  const configured = process.env.OMNIROUTE_ROUTING_STATE_PATH?.trim();
  return configured ? path.resolve(configured) : path.join(dataRoot(), "routing", "cooldowns.json");
}

function policyPath(): string {
  const configured = process.env.OMNIROUTE_ROUTING_POLICY_PATH?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), "config/routing-policy.json");
}

function parseDuration(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) return fallback;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.max(0, Math.round(n * multiplier));
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath(), "utf8")) as RoutingPolicy;
  } catch {
    policy = {};
  }
  try {
    const entries = JSON.parse(fs.readFileSync(statePath(), "utf8")) as CooldownEntry[];
    if (Array.isArray(entries)) {
      const now = Date.now();
      for (const entry of entries) {
        if (entry?.key && Number(entry.until) > now) memory.set(entry.key, entry);
      }
    }
  } catch {
    // First run or corrupt state: fail open and rebuild state from future failures.
  }
}

function persist(): void {
  try {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...memory.values()], null, 2) + "\n", "utf8");
  } catch {
    // Routing resilience must never break a request because state persistence failed.
  }
}

function key(provider: string | undefined, model: string, connectionId?: string | null): string {
  return [provider || "unknown", connectionId || "-", model].join("|");
}

export function classifyRoutingFailure(status: number | undefined, message = ""): RoutingFailureClass {
  const text = message.toLowerCase();
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) return "rate_limit";
  if (text.includes("quota") || text.includes("insufficient quota") || text.includes("resource exhausted")) return "quota_exhausted";
  if (status === 401 || text.includes("unauthorized") || text.includes("invalid api key")) return "auth_error";
  if (status === 403 || text.includes("permission denied") || text.includes("forbidden")) return "permission_denied";
  if (status === 404 || text.includes("model not found") || text.includes("unknown model")) return "model_not_found";
  if (text.includes("timeout") || status === 408) return "timeout";
  if (status === 502 || status === 503 || status === 504) return "server_error";
  if (text.includes("stream")) return "stream_error";
  if (text.includes("empty response")) return "empty_response";
  if (status === 400) return "bad_request";
  if (status !== undefined && status >= 500) return "server_error";
  if (text.includes("overloaded") || text.includes("capacity")) return "overloaded";
  if (text.includes("connect") || text.includes("econn")) return "connection_error";
  return "unknown";
}

export function isRoutingTargetCooling(
  provider: string | undefined,
  model: string,
  connectionId?: string | null
): boolean {
  load();
  const entry = memory.get(key(provider, model, connectionId));
  if (!entry) return false;
  if (entry.until <= Date.now()) {
    memory.delete(entry.key);
    persist();
    return false;
  }
  return true;
}

export function recordRoutingFailure(
  provider: string | undefined,
  model: string,
  connectionId: string | undefined | null,
  failure: RoutingFailureClass
): number {
  load();
  const configured = policy.fallback?.cooldown?.[failure];
  const duration = parseDuration(configured, DEFAULT_COOLDOWNS[failure]);
  const now = Date.now();
  const entry: CooldownEntry = { key: key(provider, model, connectionId), until: now + duration, reason: failure, updatedAt: now };
  memory.set(entry.key, entry);
  persist();
  return duration;
}

export function clearRoutingCooldown(provider: string | undefined, model: string, connectionId?: string | null): void {
  load();
  memory.delete(key(provider, model, connectionId));
  persist();
}

export function getRoutingCooldowns(): CooldownEntry[] {
  load();
  const now = Date.now();
  for (const [k, entry] of memory) if (entry.until <= now) memory.delete(k);
  return [...memory.values()].sort((a, b) => a.until - b.until);
}

export function resetRoutingResilienceForTests(): void {
  memory.clear();
  loaded = false;
  policy = {};
}
