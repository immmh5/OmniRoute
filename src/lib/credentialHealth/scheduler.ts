/**
 * Credential Health Check Scheduler
 *
 * Background scheduler that periodically tests provider credential health.
 * Follows the pattern from localHealthCheck.ts — runs on a configurable
 * interval with exponential backoff on failure.
 *
 * Reuses the existing testSingleConnection() infrastructure so all 20+
 * provider-specific validators work automatically.
 *
 * Schedule:
 *   - Initial delay: 30s after server boot
 *   - Interval: configurable via CREDENTIAL_HEALTH_CHECK_INTERVAL (default 5 min)
 *   - OAuth connections: tested less frequently (2x interval)
 *   - Backoff on failure: 5min -> 10min -> 30min -> max 2h
 *   - Resets to default on success
 */

import { testSingleConnection } from "@/app/api/providers/[id]/test/route";
import { getProviderConnections } from "@/lib/localDb";
import {
  setCredentialHealth,
  removeCredentialHealth,
  initCredentialCache,
} from "@/lib/credentialHealth/cache";
import { emit } from "@/lib/events/eventBus";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";

const BACKOFF_SCHEDULE = [300_000, 600_000, 1_800_000, 7_200_000];
const INITIAL_DELAY_MS = 30_000;
const OAUTH_INTERVAL_MULTIPLIER = 2;
const CONCURRENCY_LIMIT = 5;
const LOG_PREFIX = "[CredentialHealth]";
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

declare global {
  var __omnirouteCredentialHC:
    | {
        initialized: boolean;
        sweepTimer: ReturnType<typeof setTimeout> | null;
        sweepInProgress: boolean;
        failureCounts: Map<string, number>;
        perConnTiming: Map<string, { lastAttemptAt: number; nextAttemptAt: number }>;
      }
    | undefined;
}

function getSchedulerState() {
  if (!globalThis.__omnirouteCredentialHC) {
    globalThis.__omnirouteCredentialHC = {
      initialized: false,
      sweepTimer: null,
      sweepInProgress: false,
      failureCounts: new Map(),
      perConnTiming: new Map(),
    };
  }
  return globalThis.__omnirouteCredentialHC;
}

function isBuildProcess(): boolean {
  return typeof process !== "undefined" && process.env.NEXT_PHASE === "phase-production-build";
}

function isCredentialHealthCheckDisabled(): boolean {
  if (isBuildProcess() || isAutomatedTestProcess()) return true;
  const val = process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK;
  return val ? TRUE_ENV_VALUES.has(val.trim().toLowerCase()) : false;
}

function getSweepInterval(): number {
  const envVal = process.env.CREDENTIAL_HEALTH_CHECK_INTERVAL;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed >= 10_000) return parsed;
  }
  return 300_000;
}

function getNextBackoff(connectionId: string): number {
  const state = getSchedulerState();
  const failures = state.failureCounts.get(connectionId) ?? 0;
  return BACKOFF_SCHEDULE[Math.min(failures, BACKOFF_SCHEDULE.length - 1)];
}

async function testConnection(
  connectionId: string,
  provider: string,
  isOAuth: boolean
): Promise<void> {
  const startTime = Date.now();

  let oldStatus: string | undefined;
  try {
    const { getCredentialHealth } = await import("@/lib/credentialHealth/cache");
    const prev = getCredentialHealth(connectionId);
    oldStatus = prev?.status;
  } catch {}

  try {
    const result = await testSingleConnection(connectionId);
    const latencyMs = Date.now() - startTime;
    const state = getSchedulerState();

    if (result.valid) {
      state.failureCounts.delete(connectionId);
      state.perConnTiming.delete(connectionId);
      setCredentialHealth(
        connectionId,
        provider,
        "active",
        undefined,
        undefined,
        undefined,
        latencyMs
      );
      emit("credential.health.changed", {
        connectionId,
        provider,
        oldStatus: oldStatus || "unknown",
        newStatus: "active",
        timestamp: Date.now(),
      });
    } else {
      const currentFailures = (state.failureCounts.get(connectionId) ?? 0) + 1;
      state.failureCounts.set(connectionId, currentFailures);
      const nextBackoff = getNextBackoff(connectionId);
      state.perConnTiming.set(connectionId, {
        lastAttemptAt: startTime,
        nextAttemptAt: Date.now() + nextBackoff,
      });

      const diagnosis = result.diagnosis as { type?: string; source?: string } | undefined;

      setCredentialHealth(
        connectionId,
        provider,
        "error",
        result.error || "Unknown error",
        diagnosis?.type || "unknown",
        diagnosis?.source || "unknown",
        latencyMs
      );
      emit("credential.health.changed", {
        connectionId,
        provider,
        oldStatus: oldStatus || "unknown",
        newStatus: "error",
        timestamp: Date.now(),
      });

      // Routine repeats stay silent; only the transition into an unhealthy state
      // is logged. The detailed state remains available through the health cache/UI.
      if (oldStatus !== "error") {
        console.warn(
          LOG_PREFIX,
          `⚠️ ${provider}/${connectionId} became unhealthy — ${result.error || "Connection failed"}` +
            ` [${latencyMs}ms] (retry in ${Math.round(nextBackoff / 1000)}s)`
        );
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Scheduler error";
    const latencyMs = Date.now() - startTime;
    const state = getSchedulerState();

    const currentFailures = (state.failureCounts.get(connectionId) ?? 0) + 1;
    state.failureCounts.set(connectionId, currentFailures);
    const nextBackoff = getNextBackoff(connectionId);
    state.perConnTiming.set(connectionId, {
      lastAttemptAt: startTime,
      nextAttemptAt: Date.now() + nextBackoff,
    });

    setCredentialHealth(connectionId, provider, "error", message);

    if (oldStatus !== "error") {
      console.warn(
        LOG_PREFIX,
        `⚠️ ${provider}/${connectionId} became unhealthy — ${message}` +
          ` [${latencyMs}ms] (retry in ${Math.round(nextBackoff / 1000)}s)`
      );
    }
  }
}

export async function sweep(): Promise<void> {
  const state = getSchedulerState();
  if (state.sweepInProgress) return;
  state.sweepInProgress = true;

  try {
    let connections: Array<{
      id: string;
      provider: string;
      authType?: string;
    }>;

    try {
      const raw = await getProviderConnections({ isActive: true });
      connections = (Array.isArray(raw) ? raw : []).filter(
        (conn: any) => conn && conn.id && (conn.authType === "apikey" || conn.authType === "oauth")
      ) as Array<{
        id: string;
        provider: string;
        authType?: string;
      }>;
    } catch (err) {
      console.error(LOG_PREFIX, "Failed to load provider connections:", err);
      return;
    }

    if (connections.length === 0) return;

    const now = Date.now();
    const dueConnections = connections.filter((conn) => {
      const timing = getSchedulerState().perConnTiming.get(conn.id);
      if (!timing) return true;
      return now >= timing.nextAttemptAt;
    });

    if (dueConnections.length === 0) return;

    const batches: Array<typeof dueConnections> = [];
    for (let i = 0; i < dueConnections.length; i += CONCURRENCY_LIMIT) {
      batches.push(dueConnections.slice(i, i + CONCURRENCY_LIMIT));
    }

    for (const batch of batches) {
      await Promise.allSettled(
        batch.map((conn) => testConnection(conn.id, conn.provider, conn.authType === "oauth"))
      );
    }
  } finally {
    state.sweepInProgress = false;
    scheduleSweep();
  }
}

function scheduleSweep(): void {
  const state = getSchedulerState();
  if (!state.initialized) return;
  if (state.sweepTimer) clearTimeout(state.sweepTimer);
  state.sweepTimer = setTimeout(sweep, getSweepInterval());
}

export function initCredentialHealthCheck(): void {
  const state = getSchedulerState();
  if (state.initialized || isCredentialHealthCheckDisabled()) return;
  state.initialized = true;
  initCredentialCache();

  state.sweepTimer = setTimeout(() => {
    sweep().catch((err) => console.error(LOG_PREFIX, "Initial sweep failed:", err));
  }, INITIAL_DELAY_MS);
}

export function stopCredentialHealthCheck(): void {
  const state = getSchedulerState();
  if (state.sweepTimer) {
    clearTimeout(state.sweepTimer);
    state.sweepTimer = null;
  }
  state.initialized = false;
}

export async function forceSweep(): Promise<void> {
  const state = getSchedulerState();
  state.initialized = true;
  initCredentialCache();
  await sweep();
}

initCredentialHealthCheck();
