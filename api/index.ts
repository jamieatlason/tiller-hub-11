import { Hono } from "hono";
import { routeAgentRequest } from "agents";
import { partyserverMiddleware } from "hono-party";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HonoEnv, Env } from "./types";
import type { HubDO } from "./hub";
import { parseRpcError } from "./errors";
import { authMiddleware } from "./auth";
import { DEFAULT_OPENAI_MODEL, listHostedAgentMetadata } from "./agent-core";
import { getStatus as getOpenAIStatus, seedTokens } from "./openai-auth";
import setupRoutes from "./setup/routes";
import voiceRoutes from "./voice/routes";
import envRoutes from "./env/routes";
import repoRoutes from "./repo/routes";
import workspaceRoutes from "./workspace/routes";
export { TillerVoice } from "./voice/agent";

// ── DO stub helper ──────────────────────────────────────────────────

type HubStub = Pick<
  HubDO,
  | "createSession"
  | "getSession"
  | "getSessions"
  | "updateSessionMetadata"
  | "updateSessionAgentState"
  | "updateSessionTodos"
  | "deleteSession"
  | "setSessionActive"
  | "getOrCreateMachine"
  | "getMachines"
  | "addMessage"
  | "getMessages"
  | "createPermission"
  | "getPermission"
  | "getPendingPermissions"
  | "resolvePermission"
  | "waitForPermission"
  | "addSessionAllowedTool"
  | "getAllConfig"
  | "setConfig"
>;

function getHub(env: Env): HubStub {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id) as unknown as HubStub;
}

// ── Hono app ────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();

// Error handler
app.onError((err, c) => {
  const { status, message } = parseRpcError(err);
  return c.json({ error: message }, status as ContentfulStatusCode);
});

// Auth middleware (skips /health, /api/setup/status, and WebSocket upgrades)
app.use("/api/*", authMiddleware);

// Setup routes (auth skips these when unconfigured — see auth.ts)
app.route("/", setupRoutes);

// ── Health ──────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true }));

// ── Sessions ────────────────────────────────────────────────────────

app.get("/api/sessions", async (c) => {
  const hub = getHub(c.env);
  return c.json(await hub.getSessions());
});

app.post("/api/sessions", async (c) => {
  const hub = getHub(c.env);
  const body = await c.req.json<{
    id?: string;
    tag: string;
    machine_id?: string;
    metadata?: unknown;
  }>();

  const id = body.id ?? crypto.randomUUID();
  const session = await hub.createSession(
    id,
    body.tag,
    body.machine_id ?? null,
    body.metadata ?? {},
  );
  return c.json(session, 201);
});

app.get("/api/sessions/:id", async (c) => {
  const hub = getHub(c.env);
  const session = await hub.getSession(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

app.patch("/api/sessions/:id", async (c) => {
  const hub = getHub(c.env);
  const id = c.req.param("id");
  const body = await c.req.json<{
    metadata?: unknown;
    agent_state?: unknown;
    todos?: unknown;
    metadata_version?: number;
    agent_state_version?: number;
    todos_version?: number;
  }>();

  const results: Record<string, unknown> = {};

  if (body.metadata !== undefined && body.metadata_version !== undefined) {
    results.metadata = await hub.updateSessionMetadata(
      id,
      body.metadata,
      body.metadata_version,
    );
  }
  if (
    body.agent_state !== undefined &&
    body.agent_state_version !== undefined
  ) {
    results.agent_state = await hub.updateSessionAgentState(
      id,
      body.agent_state,
      body.agent_state_version,
    );
  }
  if (body.todos !== undefined && body.todos_version !== undefined) {
    results.todos = await hub.updateSessionTodos(
      id,
      body.todos,
      body.todos_version,
    );
  }

  return c.json(results);
});

app.delete("/api/sessions/:id", async (c) => {
  const hub = getHub(c.env);
  await hub.deleteSession(c.req.param("id"));
  return c.json({ ok: true });
});

// Session lifecycle actions
app.post("/api/sessions/:id/resume", async (c) => {
  const hub = getHub(c.env);
  await hub.setSessionActive(c.req.param("id"), true);
  const session = await hub.getSession(c.req.param("id"));
  return c.json(session);
});

app.post("/api/sessions/:id/abort", async (c) => {
  const hub = getHub(c.env);
  await hub.setSessionActive(c.req.param("id"), false);
  const session = await hub.getSession(c.req.param("id"));
  return c.json(session);
});

app.post("/api/sessions/:id/archive", async (c) => {
  const hub = getHub(c.env);
  await hub.deleteSession(c.req.param("id"));
  return c.json({ ok: true });
});

// ── Messages ────────────────────────────────────────────────────────

app.get("/api/sessions/:id/messages", async (c) => {
  const hub = getHub(c.env);
  const limitRaw = c.req.query("limit");
  const beforeSeqRaw = c.req.query("before_seq");
  const afterSeqRaw = c.req.query("after_seq");

  let limit = 50;
  if (limitRaw !== undefined) {
    const parsedLimit = Number(limitRaw);
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 1000
    ) {
      return c.json(
        { error: "Invalid limit: must be an integer between 1 and 1000" },
        400,
      );
    }
    limit = parsedLimit;
  }

  if (beforeSeqRaw !== undefined && afterSeqRaw !== undefined) {
    return c.json(
      { error: "Invalid query: provide only one of before_seq or after_seq" },
      400,
    );
  }

  let beforeSeq: number | undefined;
  if (beforeSeqRaw !== undefined) {
    const parsedBeforeSeq = Number(beforeSeqRaw);
    if (!Number.isInteger(parsedBeforeSeq) || parsedBeforeSeq < 0) {
      return c.json(
        { error: "Invalid before_seq: must be a non-negative integer" },
        400,
      );
    }
    beforeSeq = parsedBeforeSeq;
  }

  let afterSeq: number | undefined;
  if (afterSeqRaw !== undefined) {
    const parsedAfterSeq = Number(afterSeqRaw);
    if (!Number.isInteger(parsedAfterSeq) || parsedAfterSeq < 0) {
      return c.json(
        { error: "Invalid after_seq: must be a non-negative integer" },
        400,
      );
    }
    afterSeq = parsedAfterSeq;
  }

  const messages = await hub.getMessages(c.req.param("id"), {
    limit,
    beforeSeq,
    afterSeq,
  });
  return c.json(messages);
});

app.post("/api/sessions/:id/messages", async (c) => {
  const hub = getHub(c.env);
  const body = await c.req.json<{
    id?: string;
    content: unknown;
    local_id?: string;
  }>();

  const id = body.id ?? crypto.randomUUID();
  const result = await hub.addMessage(
    id,
    c.req.param("id"),
    body.content,
    body.local_id ?? null,
  );

  return c.json(result, 201);
});

// ── Permissions ─────────────────────────────────────────────────────

app.post("/api/sessions/:id/permissions", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const body = await c.req.json<{
    id?: string;
    tool_name: string;
    tool_input?: unknown;
  }>();

  const id = body.id ?? crypto.randomUUID();
  const permission = await hub.createPermission(
    id,
    sessionId,
    body.tool_name,
    body.tool_input ?? {},
  );
  return c.json(permission, 201);
});

app.get("/api/sessions/:id/permissions", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const permissions = await hub.getPendingPermissions(sessionId);
  return c.json(permissions);
});

app.get("/api/sessions/:id/permissions/:permId", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const permId = c.req.param("permId");
  const wait = c.req.query("wait") === "true";
  const permission = await hub.getPermission(permId);

  if (!permission || permission.session_id !== sessionId) {
    return c.json({ error: "Permission not found" }, 404);
  }

  if (!wait) {
    return c.json(permission);
  }

  if (permission.status !== "pending") {
    return c.json({
      status: permission.status,
      decision_reason: permission.decision_reason ?? undefined,
    });
  }

  // Long-poll: blocks until resolved or 25s timeout
  const result = await hub.waitForPermission(permId);
  return c.json(result);
});

app.post("/api/sessions/:id/permissions/:permId", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const permId = c.req.param("permId");
  const body = await c.req.json<{
    status: "allowed" | "denied";
    decision_reason?: string;
    allow_for_session?: boolean;
  }>();
  const permission = await hub.getPermission(permId);
  if (!permission || permission.session_id !== sessionId) {
    return c.json({ error: "Permission not found" }, 404);
  }

  const resolvedPermission = await hub.resolvePermission(
    permId,
    body.status,
    body.decision_reason,
    body.allow_for_session,
  );
  if (!resolvedPermission)
    return c.json({ error: "Permission not found or already resolved" }, 404);
  return c.json(resolvedPermission);
});

// ── Machines ────────────────────────────────────────────────────────

app.get("/api/machines", async (c) => {
  const hub = getHub(c.env);
  return c.json(await hub.getMachines());
});

app.post("/api/machines", async (c) => {
  const hub = getHub(c.env);
  const body = await c.req.json<{
    id: string;
    metadata?: unknown;
  }>();

  const machine = await hub.getOrCreateMachine(
    body.id,
    body.metadata ?? {},
  );
  return c.json(machine, 201);
});

// ── Environments (sandbox) ────────────────────────────────────────────

app.post("/api/auth/openai/seed", async (c) => {
  const body = await c.req.json<{
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  }>();

  if (!body.access_token || !body.refresh_token) {
    return c.json({ error: "access_token and refresh_token are required" }, 400);
  }

  const stored = await seedTokens(c.env, {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    id_token: body.id_token,
    expires_in: body.expires_in,
  });

  return c.json({
    authenticated: true,
    expires_at: stored.expires_at,
    account_id: stored.account_id,
    model: c.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
  });
});

app.get("/api/auth/openai/status", async (c) => {
  const status = await getOpenAIStatus(c.env);
  return c.json({
    ...status,
    model: c.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
  });
});

app.get("/api/agents", (c) => {
  return c.json(listHostedAgentMetadata(c.env));
});

app.route("/", envRoutes);
app.route("/", repoRoutes);

// ── Workspace files ──────────────────────────────────────────────────

app.route("/", workspaceRoutes);

// ── Voice session WebSocket ──────────────────────────────────────────

app.route("/", voiceRoutes);

// ── WebSocket upgrade via partyserver ───────────────────────────────

app.use("/parties/*", (c, next) => {
  const hint = c.env.DO_LOCATION_HINT as DurableObjectLocationHint | undefined;
  const middleware = partyserverMiddleware({
    options: hint ? { locationHint: hint } : undefined,
  });
  return middleware(c as never, next as never);
});

// ── SPA fallback ────────────────────────────────────────────────────

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ── Worker export ───────────────────────────────────────────────────

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/agents/")) {
      const agentResp = await routeAgentRequest(req, env);
      if (agentResp) return agentResp;
    }
    const isPartyWs =
      req.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
      url.pathname.startsWith("/parties/");
    if (isPartyWs) {
      const t = Date.now();
      const resp = await app.fetch(req, env, ctx);
      console.log(
        `[Worker] party WS ${url.pathname} → ${resp.status} in ${Date.now() - t}ms`,
      );
      return resp;
    }
    return app.fetch(req, env, ctx);
  },
};

// Export Durable Object classes for wrangler
export { CartographerChatAgent } from "./agents/cartographer-chat-agent";
export { HubDO } from "./hub";
export { PlanChatAgent } from "./agents/plan-chat-agent";
export { PlannerChatAgent } from "./agents/planner-chat-agent";
export { ResearchChatAgent } from "./agents/research-chat-agent";
export { ReviewerChatAgent } from "./agents/reviewer-chat-agent";
export { SandboxDO } from "./sandbox-do";
export { WorkspaceDO } from "./workspace/do";
