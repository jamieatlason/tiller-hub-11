import type { Server } from "partyserver";

// ── Env bindings ────────────────────────────────────────────────────

export interface Env {
  CARTOGRAPHER_CHAT: DurableObjectNamespace;
  HUB: DurableObjectNamespace<Server<Env>>;
  TILLER_VOICE: DurableObjectNamespace;
  PLAN_CHAT: DurableObjectNamespace;
  PLANNER_CHAT: DurableObjectNamespace;
  RESEARCH_CHAT: DurableObjectNamespace;
  REVIEWER_CHAT: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace;
  WORKSPACE: DurableObjectNamespace;
  AI: Ai;
  LOADER: WorkerLoader;
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
  ENVS_KV: KVNamespace;
  CF_ACCESS_AUD: string;
  USE_CF_CONTAINERS?: string;
  DEFAULT_RUNNER_BACKEND?: string;
  DEFAULT_TILLER_CLI_VERSION?: string;
  HUB_PUBLIC_URL?: string;
  LOCAL_RUNNER_URL?: string;
  LOCAL_RUNNER_TOKEN?: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_MODEL?: string;
  RESEARCH_RELAY_URL?: string;
  RESEARCH_RELAY_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  GITHUB_TOKEN?: string;
  DO_LOCATION_HINT?: string; // CF locationHint for HubDO — should match container region (e.g. "wnam" for sjc)
}

export type ClaudeAuthMode = "auto" | "subscription" | "api";
export type ResolvedClaudeAuthMode = "subscription" | "api";
export type EnvSyncState = "current" | "behind" | "needs-reconcile" | "conflicted" | "legacy";

// ── Hono context variables ──────────────────────────────────────────

export type HonoEnv = {
  Bindings: Env;
  Variables: {};
};

// ── Stored row types ────────────────────────────────────────────────

export interface StoredSession {
  id: string;
  tag: string;
  machine_id: string | null;
  metadata: string; // JSON
  agent_state: string; // JSON
  todos: string; // JSON
  allowed_tools: string; // JSON array of tool patterns
  active: number; // 0 | 1
  metadata_version: number;
  agent_state_version: number;
  todos_version: number;
  seq: number;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredMachine {
  id: string;
  metadata: string; // JSON
  runner_state: string; // JSON
  active: number; // 0 | 1
  metadata_version: number;
  runner_state_version: number;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface MachineRunnerState {
  runnerUrl?: string;
  relayUrl?: string;
  tunnelType?: "quick" | "named";
  registeredAt?: string;
}

export interface ActiveLocalRunnerConfig {
  runnerUrl: string | null;
  relayUrl: string | null;
}

export interface StoredMessage {
  id: string;
  session_id: string;
  content: string; // JSON
  seq: number;
  local_id: string | null;
  created_at: string;
}

export interface StoredPermission {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: string; // JSON
  status: "pending" | "allowed" | "denied";
  decision_reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ── Environment metadata ────────────────────────────────────────────

export interface EnvMeta {
  slug: string;
  repoUrl: string;
  repoId?: string;
  flyMachineId: string;
  backend?: "cf" | "local";
  runnerId?: string;
  authMode?: ClaudeAuthMode;
  resolvedAuthMode?: ResolvedClaudeAuthMode;
  authWarning?: string;
  createdAt: string;
  status?: string;
  bootMessage?: string;
  cliVersion?: string;
  startupPlanId?: string | null;
  baseRepoVersion?: number | null;
  baseRepoRevisionId?: string | null;
  legacyBaseRevision?: boolean;
  workspaceDirty?: boolean | null;
  syncState?: EnvSyncState;
  conflictedAgainstVersion?: number | null;
  reconcileConflictCount?: number | null;
  staleSinceRevisionId?: string | null;
  error?: string;
  errorAt?: string;
}

export interface RepoMeta {
  repoId: string;
  repoUrl: string;
  currentVersion: number;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
  bootstrappedFromRef: string | null;
  lastCommittedFromEnvSlug?: string | null;
  lastCommittedAt?: string | null;
  envCount?: number;
  hasCurrentApprovedPlan?: boolean;
}

export interface RepoRevisionMeta {
  id: string;
  repoId: string;
  version: number;
  parentRevisionId?: string | null;
  source: "github-bootstrap" | "env-commit";
  sourceEnvSlug?: string | null;
  createdAt: string;
  summary: string;
  treeHash: string;
}

// ── Versioned update result ─────────────────────────────────────────

export type VersionedUpdateResult =
  | { ok: true; version: number }
  | {
      ok: false;
      reason: "not_found" | "version_conflict";
      current_version?: number;
    };

// ── WebSocket protocol types ────────────────────────────────────────

export type WsClientRole = "cli" | "web";

export interface WsConnectionState {
  role?: WsClientRole;
  sessionId?: string;
  machineId?: string;
}

// Client → Hub messages
export type WsClientMessage =
  | { type: "ping" }
  | { type: "reconnect"; lastSeq: number }
  | {
      type: "message";
      id: string;
      sessionId: string;
      content: unknown;
      localId?: string;
    }
  | { type: "session-alive"; sessionId: string }
  | { type: "session-end"; sessionId: string }
  | {
      type: "update-metadata";
      sessionId: string;
      metadata: unknown;
      expectedVersion: number;
    }
  | {
      type: "update-agent-state";
      sessionId: string;
      agentState: unknown;
      expectedVersion: number;
    }
  | {
      type: "update-todos";
      sessionId: string;
      todos: unknown;
      expectedVersion: number;
    }
  | { type: "machine-alive"; machineId: string }
  | {
      type: "machine-update-metadata";
      machineId: string;
      metadata: unknown;
      expectedVersion: number;
    }
  | {
      type: "machine-update-runner-state";
      machineId: string;
      runnerState: unknown;
      expectedVersion: number;
    };

// Hub → Client messages
export type WsServerMessage =
  | { type: "pong" }
  | { type: "error"; message: string }
  | {
      type: "message-received";
      id: string;
      sessionId: string;
      content: unknown;
      seq: number;
      localId?: string;
    }
  | { type: "session-updated"; session: StoredSession }
  | { type: "session-deleted"; sessionId: string }
  | { type: "machine-updated"; machine: StoredMachine }
  | { type: "replay"; events: WsServerMessage[] }
  | { type: "permission-created"; permission: StoredPermission }
  | { type: "permission-resolved"; permission: StoredPermission }
  | { type: "env-status-changed"; slug: string; status: string; message?: string }
  | {
      type: "repo-revision-changed";
      repoId: string;
      repoUrl: string;
      previousVersion: number;
      currentVersion: number;
      previousRevisionId: string;
      currentRevisionId: string;
      sourceEnvSlug?: string | null;
    };
