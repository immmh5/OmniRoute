/**
 * Live Dashboard WebSocket Server
 *
 * Separate process (runs alongside Next.js on port 20132).
 * Forwards EventBus events to subscribed dashboard clients.
 *
 * Protocol:
 *   Client → Server: { type: "subscribe", channels: ["requests", "combo"] }
 *   Server → Client: { type: "event", channel: "requests", event: "request.started", data: {...} }
 *   Client → Server: { type: "ping" }
 *   Server → Client: { type: "pong" }
 *   Server → Client: { type: "welcome", version, sessionId, channels, backlog }
 *   Server → Client: { type: "error", code, message }
 */

import { WebSocketServer, WebSocket } from "ws";
import { jwtVerify } from "jose";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";

import type { WsClientMessage, WsServerMessage, WsEventMessage, WsAuthResult } from "./types";
import { emit, on, onAny, getEventHistory, type HistoryEntry } from "@/lib/events/eventBus";
import type { DashboardEventName, DashboardEventMap, DashboardChannel } from "@/lib/events/types";
import { CHANNEL_EVENTS, getChannelForEvent } from "@/lib/events/types";
import { isAutomatedTestProcess, isBuildProcess } from "@/shared/utils/testProcess";

import {
  buildAllowedOrigins,
  buildAllowedHosts,
  isOriginAllowed as isOriginAllowedPure,
} from "./liveServerAllowList";

const DEFAULT_PORT = 20132;
const DEFAULT_HOST = "127.0.0.1";
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;
const MAX_CLIENTS = 500;
const MAX_EVENTS_PER_SECOND = 100;
const MAX_PENDING_MESSAGES_PER_CLIENT = 32;
const MAX_PENDING_MESSAGE_BYTES = 16_384;

const ALLOWED_ORIGINS = buildAllowedOrigins();
const ALLOWED_HOSTS = buildAllowedHosts();

function isOriginAllowed(origin: string | undefined): boolean {
  return isOriginAllowedPure(origin, process.env, {
    allowedOrigins: ALLOWED_ORIGINS,
    allowedHosts: ALLOWED_HOSTS,
  });
}

interface ClientState {
  ws: WebSocket;
  sessionId: string;
  subscribedChannels: Set<DashboardChannel>;
  lastActivity: number;
  eventCounter: number;
  eventCounterReset: number;
  remoteAddress: string;
}

const clients = new Map<string, ClientState>();
let eventHistoryBacklog: HistoryEntry[] = [];
const BACKLOG_MAX = 500;

function toWebHeaders(headers: import("http").IncomingMessage["headers"]): Headers {
  const webHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      webHeaders.set(name, value);
    } else if (Array.isArray(value)) {
      webHeaders.set(name, name.toLowerCase() === "cookie" ? value.join("; ") : value.join(", "));
    }
  }

  return webHeaders;
}

let authModulePromise: Promise<typeof import("../../sse/services/auth.ts")> | null = null;
function loadAuthModule(): Promise<typeof import("../../sse/services/auth.ts")> {
  if (!authModulePromise) {
    authModulePromise = import("../../sse/services/auth.ts");
  }
  return authModulePromise;
}

async function authorizeConnection(request: import("http").IncomingMessage): Promise<WsAuthResult> {
  const sessionId = randomUUID().slice(0, 8);
  const token = extractBearerToken(request) || extractAltTokenHeader(request);

  if (!token) {
    if (await isDashboardCookieAuthenticated(request)) {
      return { authorized: true, sessionId };
    }
    return { authorized: false, sessionId, error: "Missing token" };
  }

  try {
    const { extractApiKey, isValidApiKey } = await loadAuthModule();
    const apiKey = extractApiKey({ headers: { authorization: `Bearer ${token}` } } as any, {
      allowUrl: false,
    });

    if (!apiKey || !(await isValidApiKey(apiKey))) {
      return { authorized: false, sessionId, error: "Invalid API key" };
    }

    return { authorized: true, sessionId };
  } catch {
    return { authorized: false, sessionId, error: "Auth system unavailable" };
  }
}

function extractAltTokenHeader(request: import("http").IncomingMessage): string | null {
  const raw = request.headers["x-live-ws-token"];
  if (Array.isArray(raw)) return raw[0] || null;
  return typeof raw === "string" ? raw : null;
}

export function getCookieValueFromHeader(
  headers: import("http").IncomingHttpHeaders,
  name: string
): string | null {
  const raw = headers.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join("; ") : raw;
  if (!cookieHeader) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isDashboardCookieAuthenticated(
  request: import("http").IncomingMessage
): Promise<boolean> {
  const token = getCookieValueFromHeader(request.headers, "auth_token");
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

function extractBearerToken(request: import("http").IncomingMessage): string | null {
  const auth = request.headers["authorization"];
  if (!auth || typeof auth !== "string") return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

function handleMessage(clientId: string, raw: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  const now = Date.now();
  if (now - client.eventCounterReset > 1000) {
    client.eventCounter = 0;
    client.eventCounterReset = now;
  }
  client.eventCounter++;
  if (client.eventCounter > MAX_EVENTS_PER_SECOND) {
    sendTo(client.ws, { type: "error", code: "RATE_LIMITED", message: "Too many messages" });
    return;
  }

  let msg: WsClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    sendTo(client.ws, { type: "error", code: "PARSE_ERROR", message: "Invalid JSON" });
    return;
  }

  client.lastActivity = now;

  switch (msg.type) {
    case "subscribe": {
      client.subscribedChannels = new Set(msg.channels);
      const relevantHistory = eventHistoryBacklog.filter((h) => {
        const ch = getChannelForEvent(h.event as DashboardEventName);
        return ch && msg.channels.includes(ch);
      });

      sendTo(client.ws, {
        type: "welcome",
        version: "1.0.0",
        sessionId: client.sessionId,
        serverTime: now,
        channels: msg.channels,
        backlog: relevantHistory.length,
        data: relevantHistory.map((h) => ({
          event: h.event,
          channel: getChannelForEvent(h.event as DashboardEventName),
          data: h.payload,
          timestamp: h.timestamp,
        })),
      } as any);
      break;
    }

    case "ping":
      sendTo(client.ws, { type: "pong" } as WsServerMessage);
      break;
  }
}

function sendTo(ws: WebSocket, msg: WsServerMessage | Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function publishDashboardEvent(
  event: DashboardEventName,
  payload: unknown,
  timestamp = Date.now()
): boolean {
  const channel = getChannelForEvent(event);
  if (!channel) return false;

  eventHistoryBacklog.push({ event, payload, timestamp });
  if (eventHistoryBacklog.length > BACKLOG_MAX) {
    eventHistoryBacklog.shift();
  }

  const msg: WsEventMessage = {
    type: "event",
    channel,
    event,
    data: payload,
  };

  for (const [clientId, client] of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      clients.delete(clientId);
      continue;
    }
    if (client.subscribedChannels.has(channel)) {
      sendTo(client.ws, msg);
    }
  }

  return true;
}

function subscribeToEventBus(): () => void {
  return onAny((event: DashboardEventName, payload: unknown) => {
    publishDashboardEvent(event, payload);
  });
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function handleInternalEventRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "POST" || req.url !== "/__omniroute_event") {
    res.writeHead(404).end();
    return;
  }
  if (!isLoopbackRequest(req)) {
    res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
    return;
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) {
      req.destroy(new Error("Internal event payload too large"));
    }
  });
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(400).end();
  });
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body || "{}");
      const event = parsed.event as DashboardEventName;
      if (!Object.values(CHANNEL_EVENTS).some((events) => events.includes(event))) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
        return;
      }
      const ok = publishDashboardEvent(
        event,
        parsed.payload,
        Number(parsed.timestamp) || Date.now()
      );
      res
        .writeHead(ok ? 202 : 400, { "content-type": "application/json" })
        .end(JSON.stringify({ ok }));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
    }
  });
}

async function seedLatestCompressionRunFromDb(): Promise<void> {
  try {
    const { getLatestCompressionAnalyticsRun } = await import("@/lib/db/compressionAnalytics");
    const row = getLatestCompressionAnalyticsRun();
    if (!row) return;

    const originalTokens = Number(row.original_tokens) || 0;
    const compressedTokens = Number(row.compressed_tokens) || 0;
    const savingsPercent =
      originalTokens > 0
        ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 100)
        : 0;
    const timestamp = Number.isFinite(Date.parse(row.timestamp))
      ? Date.parse(row.timestamp)
      : Date.now();

    publishDashboardEvent(
      "compression.completed",
      {
        requestId: row.request_id || `analytics-${row.id}`,
        comboId: row.compression_combo_id || row.combo_id || null,
        mode: row.mode,
        originalTokens,
        compressedTokens,
        savingsPercent,
        engineBreakdown: [
          {
            engine: row.engine || row.mode || "compression",
            originalTokens,
            compressedTokens,
            savingsPercent,
            techniquesUsed: [],
            rulesApplied: [],
            durationMs: row.duration_ms ?? undefined,
          },
        ],
        validationWarnings: [],
        fallbackApplied: Boolean(row.validation_fallback),
        timestamp,
      },
      timestamp
    );
  } catch (err) {
    console.warn(
      "[LiveWS] Could not seed compression analytics backlog: %s",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function startHeartbeat(server: WebSocketServer): void {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [clientId, client] of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        clients.delete(clientId);
        continue;
      }
      if (now - client.lastActivity > HEARTBEAT_TIMEOUT_MS) {
        client.ws.terminate();
        clients.delete(clientId);
        continue;
      }
      sendTo(client.ws, { type: "pong" } as WsServerMessage);
    }
  }, HEARTBEAT_INTERVAL_MS);
  (interval as { unref?: () => void })?.unref?.();
  server.on("close", () => clearInterval(interval));
}

export async function startLiveDashboardServer(
  port = DEFAULT_PORT,
  host = DEFAULT_HOST
): Promise<import("http").Server> {
  if (!process.env.JWT_SECRET) {
    console.warn(
      "  \x1b[33m⚠ Warning: JWT_SECRET is not set in the environment.\x1b[0m\n" +
        "    Dashboard cookie-based WebSocket authentication will fail.\n" +
        "    Please ensure JWT_SECRET is configured in your .env file."
    );
  }

  const server = createServer((req, res) => {
    handleInternalEventRequest(req, res);
  });
  const wss = new WebSocketServer({ server });

  const unsubscribe = subscribeToEventBus();
  await seedLatestCompressionRunFromDb();
  await loadAuthModule().catch(() => {});

  wss.on("connection", async (ws, request) => {
    const pendingMessages: string[] = [];
    let activeClientId: string | null = null;

    ws.on("message", (data) => {
      const raw = data.toString();
      if (!activeClientId) {
        if (
          pendingMessages.length >= MAX_PENDING_MESSAGES_PER_CLIENT ||
          raw.length > MAX_PENDING_MESSAGE_BYTES
        ) {
          sendTo(ws, { type: "error", code: "RATE_LIMITED", message: "Too many early messages" });
          ws.close(4008, "Too many early messages");
          return;
        }
        pendingMessages.push(raw);
        return;
      }
      handleMessage(activeClientId, raw);
    });

    const origin = request.headers["origin"];
    const originStr = Array.isArray(origin) ? origin[0] : origin;
    if (!isOriginAllowed(originStr)) {
      sendTo(ws, { type: "error", code: "FORBIDDEN_ORIGIN", message: "Origin not allowed" });
      ws.close(4003, "Forbidden origin");
      return;
    }

    if (clients.size >= MAX_CLIENTS) {
      sendTo(ws, { type: "error", code: "SERVER_FULL", message: "Max clients reached" });
      ws.close(1013, "Server full");
      return;
    }

    const auth = await authorizeConnection(request);
    if (!auth.authorized) {
      sendTo(ws, { type: "error", code: "UNAUTHORIZED", message: auth.error || "Unauthorized" });
      ws.close(4001, "Unauthorized");
      return;
    }

    const clientId = auth.sessionId;
    activeClientId = clientId;
    const client: ClientState = {
      ws,
      sessionId: clientId,
      subscribedChannels: new Set(),
      lastActivity: Date.now(),
      eventCounter: 0,
      eventCounterReset: Date.now(),
      remoteAddress: request.socket?.remoteAddress || "unknown",
    };

    clients.set(clientId, client);

    for (const raw of pendingMessages.splice(0)) {
      handleMessage(clientId, raw);
    }

    ws.on("close", () => {
      clients.delete(clientId);
    });

    ws.on("error", (err) => {
      console.error("[LiveWS] Client error %s: %s", clientId, err.message);
      clients.delete(clientId);
    });
  });

  startHeartbeat(wss);

  wss.on("close", () => {
    unsubscribe();
    clients.clear();
  });

  return new Promise((resolve, reject) => {
    wss.once("error", (err: NodeJS.ErrnoException) => {
      unsubscribe();
      clients.clear();
      reject(err);
    });
    server.listen(port, host, () => {
      console.log("[LiveWS] Dashboard WebSocket server listening on %s:%d", host, port);
      resolve(server);
    });
  });
}

function isBuildOrTest(): boolean {
  return isBuildProcess() || isAutomatedTestProcess();
}

export function isLiveWsEnabled(): boolean {
  const v = process.env.OMNIROUTE_ENABLE_LIVE_WS;
  if (v === undefined) return true;
  return v === "1" || v.toLowerCase() === "true";
}

if (!isBuildOrTest() && isLiveWsEnabled()) {
  const port = parseInt(process.env.LIVE_WS_PORT || String(DEFAULT_PORT), 10);
  const host = process.env.LIVE_WS_HOST || DEFAULT_HOST;
  startLiveDashboardServer(port, host).catch((err) => {
    console.error("[LiveWS] Failed to start: %s", err instanceof Error ? err.message : String(err));
  });
}
