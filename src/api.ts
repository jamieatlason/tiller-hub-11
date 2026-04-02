import type { StoredSession, StoredMessage, StoredPermission, WsServerMessage, EnvMeta, RepoMeta } from "../api/types";
import type { HandoffArtifact, HostedAgentMetadata } from "../api/agent-core/types";

function normalizeEnvStatus(status?: string): string {
  switch (status) {
    case "running":
      return "started";
    default:
      return status ?? "unknown";
  }
}

function normalizeEnvMeta<T extends EnvMeta>(env: T): T {
  return {
    ...env,
    status: normalizeEnvStatus(env.status),
  };
}

// ── REST helpers ──────────────────────────────────────────────────

export async function fetchSessions(hubUrl: string): Promise<StoredSession[]> {
  const res = await fetch(`${hubUrl}/api/sessions`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return res.json();
}

export async function fetchMessages(
  hubUrl: string,
  sessionId: string,
  opts: { limit?: number; beforeSeq?: number; afterSeq?: number } = {},
): Promise<StoredMessage[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.beforeSeq != null) params.set("before_seq", String(opts.beforeSeq));
  if (opts.afterSeq != null) params.set("after_seq", String(opts.afterSeq));
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/messages${qs}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
  return res.json();
}

export async function fetchPendingPermissions(hubUrl: string, sessionId: string): Promise<StoredPermission[]> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch permissions: ${res.status}`);
  return res.json();
}

export async function resolvePermission(
  hubUrl: string,
  sessionId: string,
  permId: string,
  status: string,
  allowForSession = false,
): Promise<StoredPermission> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions/${permId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status, allow_for_session: allowForSession }),
  });
  if (!res.ok) throw new Error(`Failed to resolve permission: ${res.status}`);
  return res.json();
}

// ── Environment (sandbox) helpers ─────────────────────────────────

export type { EnvMeta, RepoMeta } from "../api/types";

export async function fetchEnvs(hubUrl: string): Promise<EnvMeta[]> {
  const res = await fetch(`${hubUrl}/api/envs`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch envs: ${res.status}`);
  const envs = await res.json<EnvMeta[]>();
  return envs.map((env) => normalizeEnvMeta(env));
}

export async function createEnv(
  hubUrl: string,
  repoUrl: string,
  backend?: "cf" | "local",
  authMode?: "auto" | "subscription" | "api",
  planId?: string | null,
): Promise<EnvMeta> {
  const res = await fetch(`${hubUrl}/api/envs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ repoUrl, backend, authMode, planId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to create env: ${res.status}`);
  }
  const env = await res.json<EnvMeta>();
  return normalizeEnvMeta(env);
}

export async function startEnv(
  hubUrl: string,
  slug: string,
  options?: { planId?: string | null },
): Promise<{ ok: boolean; slug: string; status: string }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) throw new Error(`Failed to start env: ${res.status}`);
  return res.json();
}

export async function stopEnv(hubUrl: string, slug: string): Promise<{ ok: boolean; slug: string; status: string }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/stop`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to stop env: ${res.status}`);
  return res.json();
}

export async function syncEnv(hubUrl: string, slug: string): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/sync`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to sync env: ${res.status}`);
}

export async function commitBackEnv(
  hubUrl: string,
  slug: string,
): Promise<{
  ok: boolean;
  slug: string;
  repoId: string;
  previousVersion: number;
  currentVersion: number;
  previousRevisionId: string;
  currentRevisionId: string;
  action?: "fast-forwarded" | "no-changes" | "promoted";
}> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/commit-back`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to commit back env: ${res.status}`);
  }
  return res.json();
}

export async function reconcileEnv(
  hubUrl: string,
  slug: string,
): Promise<{
  ok: boolean;
  slug: string;
  repoId: string;
  currentVersion: number;
  currentRevisionId: string;
  action: "fast-forwarded" | "already-current" | "merged" | "conflicted";
  conflictCount: number;
}> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/reconcile`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to reconcile env: ${res.status}`);
  }
  return res.json();
}

export async function resetEnvToRepo(
  hubUrl: string,
  slug: string,
): Promise<{ ok: boolean; slug: string; repoId: string; currentVersion: number; currentRevisionId: string }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/reset-to-repo`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to reset env to repo: ${res.status}`);
  }
  return res.json();
}

export async function fetchEnvStatus(hubUrl: string, slug: string): Promise<string> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch env status: ${res.status}`);
  const data: EnvMeta & { status: string } = await res.json();
  return normalizeEnvStatus(data.status);
}

export async function deleteEnv(hubUrl: string, slug: string): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to delete env: ${res.status}`);
}

export async function deleteRepo(hubUrl: string, repoId: string): Promise<void> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to delete repo: ${res.status}`);
  }
}

export async function fetchAgentMetadata(
  hubUrl: string,
): Promise<HostedAgentMetadata[]> {
  const res = await fetch(`${hubUrl}/api/agents`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch agent metadata: ${res.status}`);
  return res.json();
}

export async function fetchRepoHandoffs(
  hubUrl: string,
  repoId: string,
): Promise<HandoffArtifact[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/handoffs`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch handoffs: ${res.status}`);
  return res.json();
}

export async function fetchApprovedPlansForRepo(
  hubUrl: string,
  repoId: string,
): Promise<HandoffArtifact[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/approved-plans`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to fetch approved plans: ${res.status}`);
  }
  return res.json();
}

export async function fetchRepos(hubUrl: string): Promise<RepoMeta[]> {
  const res = await fetch(`${hubUrl}/api/repos`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
  return res.json();
}

export async function fetchRepo(hubUrl: string, repoId: string): Promise<RepoMeta> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch repo: ${res.status}`);
  return res.json();
}

export async function materializeHandoffPlan(
  hubUrl: string,
  slug: string,
  id: string,
): Promise<{ ok: true; path: string; handoff: HandoffArtifact }> {
  const res = await fetch(`${hubUrl}/api/workspace/${slug}/handoffs/${id}/plan`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to materialize handoff: ${res.status}`);
  }
  return res.json();
}

export async function approveHandoff(
  hubUrl: string,
  repoId: string,
  id: string,
): Promise<{ ok: true; handoff: HandoffArtifact }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/handoffs/${id}/approve`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to approve handoff: ${res.status}`);
  }
  return res.json();
}

export async function discardHandoff(
  hubUrl: string,
  repoId: string,
  id: string,
): Promise<{ ok: true; handoff: HandoffArtifact }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/handoffs/${id}/discard`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to discard handoff: ${res.status}`);
  }
  return res.json();
}

export async function runPlanReviewRound(
  hubUrl: string,
  repoId: string,
  id: string,
): Promise<{
  ok: true;
  draftId: string;
  reviews: Array<{
    id: string;
    model?: string;
    summary: string;
    reviewIssueStats?: HandoffArtifact["reviewIssueStats"];
    reviewMeta?: HandoffArtifact["reviewMeta"];
  }>;
}> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/handoffs/${id}/review-round`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to run review round: ${res.status}`);
  }
  return res.json();
}

export async function integratePlanReviews(
  hubUrl: string,
  repoId: string,
  id: string,
  options: { selectedModel?: string },
): Promise<{
  ok: true;
  skipped?: boolean;
  groundedIssueCount: number;
  droppedIssueCount: number;
  handoff?: HandoffArtifact;
  reply: string;
}> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/handoffs/${id}/integrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to integrate reviews: ${res.status}`);
  }
  return res.json();
}

// ── Setup / Settings helpers ─────────────────────────────────────

export interface SetupStatus {
  needsSetup: boolean;
  keys: Record<string, "configured" | "missing">;
}

export async function fetchSetupStatus(hubUrl: string): Promise<SetupStatus> {
  const res = await fetch(`${hubUrl}/api/setup/status`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch setup status: ${res.status}`);
  return res.json();
}

export async function submitSetup(
  hubUrl: string,
  secrets: Record<string, string>,
): Promise<{ ok: boolean; saved?: string[]; error?: string }> {
  const res = await fetch(`${hubUrl}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ secrets }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Setup failed: ${res.status}`);
  return body;
}

// ── WebSocket helper ──────────────────────────────────────────────

const BACKOFF_STEPS = [1, 2, 5, 10, 30]; // seconds

/** Minimal message shape forwarded to the live callback and SessionView. */
export type LiveMessage = {
  sessionId: string;
  content: unknown;
  seq?: number;
};

export interface WsHandlers {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onReconnectExhausted?: () => void;
  onMessage?: (msg: Extract<WsServerMessage, { type: "message-received" }>) => void;
  onSessionUpdated?: (session: StoredSession) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onPermissionCreated?: (permission: StoredPermission) => void;
  onPermissionResolved?: (permission: StoredPermission) => void;
  onEnvStatusChanged?: (slug: string, status: string, message?: string) => void;
  onRepoRevisionChanged?: (
    repoId: string,
    repoUrl: string,
    previousVersion: number,
    currentVersion: number,
    previousRevisionId: string,
    currentRevisionId: string,
    sourceEnvSlug?: string | null,
  ) => void;
  onError?: (err: Error) => void;
}

export interface ReconnectingWebSocket {
  close(): void;
  send(data: unknown): void;
  reconnect(): void;
}

/**
 * Manages a WebSocket connection with exponential backoff reconnection.
 */
export function createReconnectingWebSocket(
  hubUrl: string,
  handlers: WsHandlers,
): ReconnectingWebSocket {
  let retryCount = 0;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  let currentSocket: { close: () => void; send: (data: unknown) => void } | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  function connect() {
    const wsUrl = hubUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const ws = new WebSocket(`${wsUrl}/parties/hub/hub`);

    ws.addEventListener("open", () => {
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
      retryCount = 0;
      handlers.onConnected?.();
    });

    ws.addEventListener("message", (event) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(event.data as string) as WsServerMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case "message-received":
          handlers.onMessage?.(msg);
          break;
        case "session-updated":
          handlers.onSessionUpdated?.(msg.session);
          break;
        case "session-deleted":
          handlers.onSessionDeleted?.(msg.sessionId);
          break;
        case "permission-created":
          handlers.onPermissionCreated?.(msg.permission);
          break;
        case "permission-resolved":
          handlers.onPermissionResolved?.(msg.permission);
          break;
        case "env-status-changed":
          handlers.onEnvStatusChanged?.(msg.slug, msg.status, msg.message);
          break;
        case "repo-revision-changed":
          handlers.onRepoRevisionChanged?.(
            msg.repoId,
            msg.repoUrl,
            msg.previousVersion,
            msg.currentVersion,
            msg.previousRevisionId,
            msg.currentRevisionId,
            msg.sourceEnvSlug,
          );
          break;
        case "error":
          handlers.onError?.(new Error(msg.message));
          break;
      }
    });

    ws.addEventListener("close", (event) => {
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = null;
      currentSocket = null;
      handlers.onDisconnected?.();
      if (!active) return;
      // 4001 = server-side auth rejection; retrying with same credentials won't help
      if (event.code === 4001) {
        handlers.onReconnectExhausted?.();
        return;
      }
      if (retryCount >= 15) {
        handlers.onReconnectExhausted?.();
        return;
      }
      const step = BACKOFF_STEPS[Math.min(retryCount, BACKOFF_STEPS.length - 1)];
      const delay = step * (0.5 + Math.random() * 0.5) * 1000;
      retryCount++;
      retryTimeout = setTimeout(connect, delay);
    });

    currentSocket = {
      close: () => ws.close(),
      send: (data) => ws.send(JSON.stringify(data)),
    };
  }

  connect();

  return {
    close() {
      active = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      currentSocket?.close();
      currentSocket = null;
    },
    send(data) {
      currentSocket?.send(data);
    },
    reconnect() {
      active = true;
      retryCount = 0;
      if (retryTimeout) clearTimeout(retryTimeout);
      currentSocket?.close();
      currentSocket = null;
      connect();
    },
  };
}
