// Environment CRUD and runner lifecycle.
// Workspace state stays hosted in WorkspaceDO; runners can be Cloudflare containers or local containers.

import { Hono } from "hono";
import { renderHandoffPlanMarkdown } from "../agent-core/handoffs";
import { resolveStartupPlanId } from "../plan/workflow";
import { getWorkspaceStub } from "../helpers";
import type { HubDO } from "../hub";
import type { EnvSyncState, HonoEnv, Env, EnvMeta } from "../types";
import {
  commitRepoRevision,
  ensureRepoWorkspaceFromRepoUrl,
  getEnvBaseRepoVersion,
  getRepoCurrentVersion,
  getRepoWorkspaceForEnvSlug,
  listEnvMetas,
  normalizeRepoUrl,
  readEnvMeta,
  readRepoVersionFromWorkspace,
  readRepoVersionSnapshotFromWorkspace,
  revisionIdFromVersion,
} from "../plan/store";
import { resolveClaudeAuthMode, resolveContainerAuth } from "./container-auth";
import { getSecret } from "../setup/config";
import {
  clearReconcileReport,
  countUnresolvedReconcileConflicts,
  reconcileWorkspaceTarballs,
  writeReconcileReport,
} from "./reconcile";
import { deriveEnvSlugCandidate } from "./slug";
import { normalizeRunnerStatus, resolveEnvStatus } from "./status";
import type { RunnerBackendKind } from "./runner-backend";
import { resolveRunnerBackendKind } from "./runner-backend";
import { getRunnerBackend } from "./runner-backends";

function getHub(
  env: Env,
): Pick<HubDO, "broadcastEnvStatus" | "broadcastRepoRevisionChange" | "addMessage"> {
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId) as unknown as Pick<
    HubDO,
    "broadcastEnvStatus" | "broadcastRepoRevisionChange" | "addMessage"
  >;
}

function getBackendKind(env: Env, options?: { requested?: string | null; stored?: string | null }): RunnerBackendKind {
  return resolveRunnerBackendKind(env, options);
}

async function findAvailableSlug(
  kv: KVNamespace,
  repoUrl: string,
  backend: RunnerBackendKind,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const slug = deriveEnvSlugCandidate(repoUrl, backend, attempt);
    const existing = await kv.get(slug);
    if (!existing) return slug;
  }

  throw new Error("Could not allocate unique environment slug");
}

function clearEnvError(meta: EnvMeta): EnvMeta {
  const next = { ...meta };
  delete next.error;
  delete next.errorAt;
  return next;
}

/**
 * Destroy a single environment: workspace DO, runner backend, KV entry, then broadcast "deleted".
 * Caller is responsible for marking the env as "deleting" beforehand.
 */
export async function destroyEnv(
  env: Env,
  meta: EnvMeta,
  hub: Pick<HubDO, "broadcastEnvStatus">,
): Promise<void> {
  const workspaceStub = getWorkspaceStub(env, meta.slug);
  await workspaceStub.destroyWorkspace();
  const backend = await getRunnerBackend(env, resolveRunnerBackendKind(env, { stored: meta.backend ?? null }));
  await backend.destroy(meta);
  await env.ENVS_KV.delete(meta.slug);
  await hub.broadcastEnvStatus(meta.slug, "deleted");
}

function clearAuthWarning(meta: EnvMeta): EnvMeta {
  const next = { ...meta };
  delete next.authWarning;
  return next;
}

export async function resolveHubPublicUrl(env: Env, requestUrl: string): Promise<string> {
  const configured = (await getSecret(env, "HUB_PUBLIC_URL"))?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return new URL(requestUrl).origin.replace(/\/+$/, "");
}

async function getResolvedStatus(env: Env, meta: EnvMeta): Promise<string> {
  if (meta.error) return "failed";

  try {
    const backend = await getRunnerBackend(env, getBackendKind(env, { stored: meta.backend ?? null }));
    const liveStatus = await backend.getStatus(meta);
    return resolveEnvStatus(meta, liveStatus);
  } catch {
    return resolveEnvStatus(meta);
  }
}

async function resolveSelectedPlanId(
  planWorkspace: ReturnType<typeof getWorkspaceStub>,
  meta: EnvMeta,
  currentRepoRevisionId: string,
  requestedPlanId?: string | null,
): Promise<string | null> {
  const approvedPlans = (await planWorkspace.listWorkspaceHandoffs()).filter(
    (handoff) =>
      handoff.status === "approved" &&
      !handoff.legacyRevision &&
      handoff.repoRevisionId === currentRepoRevisionId,
  );
  const latestApproved = approvedPlans[0] ?? null;
  const selectedPlanId = resolveStartupPlanId({
    requestedPlanId,
    startupPlanId: meta.startupPlanId ?? null,
    approvedPlans: latestApproved ? [latestApproved] : [],
  });

  if (!selectedPlanId) {
    return null;
  }

  const selectedPlan = await planWorkspace.readWorkspaceHandoff(selectedPlanId);
  if (!selectedPlan || selectedPlan.status !== "approved") {
    if (requestedPlanId) {
      throw new Error(`Approved plan not found: ${requestedPlanId}`);
    }
    return latestApproved?.id ?? null;
  }

  if (
    !requestedPlanId &&
    (selectedPlan.legacyRevision || selectedPlan.repoRevisionId !== currentRepoRevisionId)
  ) {
    return latestApproved?.id ?? null;
  }

  return selectedPlan.id;
}

type RepoWorkspaceHandle = Awaited<ReturnType<typeof ensureRepoWorkspaceFromRepoUrl>>;
type WorkspaceHandle = ReturnType<typeof getWorkspaceStub>;

const TREE_HASH_EXCLUDES = ["/.tiller", "/.claude/settings.local.json"];
const SYNC_INSPECTION_STATUSES = new Set(["stopped", "failed", "unknown"]);

function isSyncInspectableStatus(status: string): boolean {
  return SYNC_INSPECTION_STATUSES.has(status);
}

function applyEnvSyncFields(
  meta: EnvMeta,
  repo: RepoWorkspaceHandle,
  fields: {
    baseRepoVersion?: number | null;
    workspaceDirty?: boolean | null;
    syncState: EnvSyncState;
    conflictedAgainstVersion?: number | null;
    reconcileConflictCount?: number | null;
  },
): EnvMeta {
  const baseRepoVersion = fields.baseRepoVersion ?? getEnvBaseRepoVersion(meta);
  return {
    ...meta,
    baseRepoVersion,
    baseRepoRevisionId: baseRepoVersion ? revisionIdFromVersion(baseRepoVersion) : meta.baseRepoRevisionId ?? null,
    workspaceDirty: fields.workspaceDirty ?? null,
    syncState: fields.syncState,
    conflictedAgainstVersion: fields.conflictedAgainstVersion ?? null,
    reconcileConflictCount: fields.reconcileConflictCount ?? null,
    staleSinceRevisionId:
      baseRepoVersion && baseRepoVersion < repo.meta.currentVersion
        ? repo.meta.currentRevisionId
        : null,
  };
}

async function clearReconcileArtifacts(workspace: WorkspaceHandle): Promise<void> {
  await clearReconcileReport(workspace);
}

async function readUnresolvedConflictCount(workspace: WorkspaceHandle): Promise<number> {
  return countUnresolvedReconcileConflicts(workspace);
}

async function deriveEnvSyncMeta(
  env: Env,
  meta: EnvMeta,
  repo: RepoWorkspaceHandle,
  status: string,
): Promise<EnvMeta> {
  const baseRepoVersion = getEnvBaseRepoVersion(meta);
  if (meta.legacyBaseRevision || !baseRepoVersion) {
    return applyEnvSyncFields(meta, repo, {
      baseRepoVersion,
      workspaceDirty: null,
      syncState: "legacy",
    });
  }

  const currentVersion = getRepoCurrentVersion(repo.meta);
  if (!isSyncInspectableStatus(status)) {
    if (meta.syncState === "conflicted" && meta.conflictedAgainstVersion === currentVersion) {
      return applyEnvSyncFields(meta, repo, {
        baseRepoVersion: currentVersion,
        workspaceDirty: true,
        syncState: "conflicted",
        conflictedAgainstVersion: currentVersion,
        reconcileConflictCount: meta.reconcileConflictCount ?? null,
      });
    }
    return applyEnvSyncFields(meta, repo, {
      baseRepoVersion,
      workspaceDirty: null,
      syncState: baseRepoVersion < currentVersion ? "behind" : "current",
      conflictedAgainstVersion: null,
      reconcileConflictCount: null,
    });
  }

  const envWorkspace = getWorkspaceStub(env, meta.slug);
  const envTreeHash = await envWorkspace.computeWorkspaceTreeHash({ excludePrefixes: TREE_HASH_EXCLUDES });
  const currentRepoVersion = await readRepoVersionFromWorkspace(repo.workspace, currentVersion);
  if (currentRepoVersion?.treeHash && envTreeHash === currentRepoVersion.treeHash) {
    return applyEnvSyncFields(meta, repo, {
      baseRepoVersion: currentVersion,
      workspaceDirty: false,
      syncState: "current",
      conflictedAgainstVersion: null,
      reconcileConflictCount: null,
    });
  }

  if (meta.syncState === "conflicted" && baseRepoVersion === currentVersion) {
    const unresolvedConflictCount = await readUnresolvedConflictCount(envWorkspace);
    if (unresolvedConflictCount > 0) {
      return applyEnvSyncFields(meta, repo, {
        baseRepoVersion: currentVersion,
        workspaceDirty: true,
        syncState: "conflicted",
        conflictedAgainstVersion: currentVersion,
        reconcileConflictCount: unresolvedConflictCount,
      });
    }
  }

  const baseRepoSnapshot = await readRepoVersionFromWorkspace(repo.workspace, baseRepoVersion);
  if (!baseRepoSnapshot?.treeHash) {
    return applyEnvSyncFields(meta, repo, {
      baseRepoVersion,
      workspaceDirty: null,
      syncState: "legacy",
      conflictedAgainstVersion: null,
      reconcileConflictCount: null,
    });
  }

  const workspaceDirty = envTreeHash !== baseRepoSnapshot.treeHash;
  return applyEnvSyncFields(meta, repo, {
    baseRepoVersion,
    workspaceDirty,
    syncState:
      baseRepoVersion < currentVersion
        ? (workspaceDirty ? "needs-reconcile" : "behind")
        : "current",
    conflictedAgainstVersion: null,
    reconcileConflictCount: null,
  });
}

async function materializeStartupPlan(
  planWorkspace: ReturnType<typeof getWorkspaceStub>,
  envWorkspace: ReturnType<typeof getWorkspaceStub>,
  meta: EnvMeta,
  currentRepoRevisionId: string,
): Promise<string | null> {
  const startupPlanId = await resolveSelectedPlanId(planWorkspace, meta, currentRepoRevisionId);
  if (startupPlanId) {
    const selectedPlan = await planWorkspace.readWorkspaceHandoff(startupPlanId);
    if (!selectedPlan || selectedPlan.status !== "approved") {
      throw new Error(`Approved plan not found: ${startupPlanId}`);
    }
    await envWorkspace.writeWorkspaceFile("/.tiller/plan.md", renderHandoffPlanMarkdown(selectedPlan));
  } else {
    await envWorkspace.clearWorkspacePlanFile();
  }
  return startupPlanId;
}

async function restoreEnvWorkspaceFromRepo(
  env: Env,
  repo: RepoWorkspaceHandle,
  meta: EnvMeta,
): Promise<EnvMeta> {
  const workspaceStub = getWorkspaceStub(env, meta.slug);
  const repoTar = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
  await workspaceStub.restoreFromTar(repoTar, {
    clearFirst: true,
    preservePrefixes: TREE_HASH_EXCLUDES,
  });
  await clearReconcileArtifacts(workspaceStub);

  const startupPlanId = await materializeStartupPlan(
    repo.workspace,
    workspaceStub,
    meta,
    repo.meta.currentRevisionId,
  );

  return {
    ...meta,
    repoId: repo.meta.repoId,
    startupPlanId,
    baseRepoVersion: repo.meta.currentVersion,
    baseRepoRevisionId: repo.meta.currentRevisionId,
    legacyBaseRevision: false,
    workspaceDirty: false,
    syncState: "current",
    conflictedAgainstVersion: null,
    reconcileConflictCount: null,
    staleSinceRevisionId: null,
  };
}

type ReconcileExecutionResult =
  | {
      action: "merged" | "conflicted";
      conflictCount: number;
      nextMeta: EnvMeta;
    }
  | {
      action: "unsupported";
      unsupportedPaths: string[];
    };

async function reconcileEnvWorkspace(
  env: Env,
  repo: RepoWorkspaceHandle,
  meta: EnvMeta,
): Promise<ReconcileExecutionResult> {
  const baseRepoVersion = getEnvBaseRepoVersion(meta);
  if (!baseRepoVersion) {
    return {
      action: "unsupported",
      unsupportedPaths: [],
    };
  }

  const baseTar = await readRepoVersionSnapshotFromWorkspace(repo.workspace, baseRepoVersion);
  if (!baseTar) {
    return {
      action: "unsupported",
      unsupportedPaths: [],
    };
  }

  const workspaceStub = getWorkspaceStub(env, meta.slug);
  const [localTar, remoteTar] = await Promise.all([
    workspaceStub.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES }),
    repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES }),
  ]);
  const result = await reconcileWorkspaceTarballs({
    baseTar,
    localTar,
    remoteTar,
    localLabel: `env ${meta.slug}`,
    baseLabel: `repo v${baseRepoVersion}`,
    remoteLabel: `repo v${repo.meta.currentVersion}`,
  });
  if (result.unsupportedPaths.length > 0) {
    return {
      action: "unsupported",
      unsupportedPaths: result.unsupportedPaths,
    };
  }

  await workspaceStub.restoreFromTar(result.mergedTar, {
    clearFirst: true,
    preservePrefixes: TREE_HASH_EXCLUDES,
  });

  if (result.conflictPaths.length > 0) {
    await writeReconcileReport(workspaceStub, {
      baseVersion: baseRepoVersion,
      currentVersion: repo.meta.currentVersion,
      conflictPaths: result.conflictPaths,
      createdAt: new Date().toISOString(),
    });
  } else {
    await clearReconcileArtifacts(workspaceStub);
  }

  const startupPlanId = await materializeStartupPlan(
    repo.workspace,
    workspaceStub,
    meta,
    repo.meta.currentRevisionId,
  );

  const nextMeta: EnvMeta = {
    ...meta,
    repoId: repo.meta.repoId,
    startupPlanId,
    baseRepoVersion: repo.meta.currentVersion,
    baseRepoRevisionId: repo.meta.currentRevisionId,
    legacyBaseRevision: false,
    workspaceDirty: result.conflictPaths.length > 0 || !result.mergedEqualsRemote,
    syncState: result.conflictPaths.length > 0 ? "conflicted" : "current",
    conflictedAgainstVersion: result.conflictPaths.length > 0 ? repo.meta.currentVersion : null,
    reconcileConflictCount: result.conflictPaths.length > 0 ? result.conflictPaths.length : null,
    staleSinceRevisionId: null,
  };

  return {
    action: result.conflictPaths.length > 0 ? "conflicted" : "merged",
    conflictCount: result.conflictPaths.length,
    nextMeta,
  };
}

async function maybeFastForwardEnv(
  env: Env,
  meta: EnvMeta,
  status: string,
  repo: RepoWorkspaceHandle,
): Promise<EnvMeta> {
  const syncedMeta = await deriveEnvSyncMeta(env, meta, repo, status);
  if (
    isSyncInspectableStatus(status) &&
    syncedMeta.syncState === "behind" &&
    syncedMeta.workspaceDirty === false
  ) {
    return restoreEnvWorkspaceFromRepo(env, repo, syncedMeta);
  }
  return syncedMeta;
}

async function refreshRepoEnvsAfterPromotion(
  env: Env,
  repo: RepoWorkspaceHandle,
  sourceEnvSlug: string,
): Promise<void> {
  const envMetas = await listEnvMetas(env);
  await Promise.all(
    envMetas.map(async (meta) => {
      if (
        meta.slug === sourceEnvSlug ||
        normalizeRepoUrl(meta.repoUrl) !== normalizeRepoUrl(repo.meta.repoUrl)
      ) {
        return;
      }

      const status = await getResolvedStatus(env, meta);
      const nextMeta = await maybeFastForwardEnv(env, meta, status, repo);
      await env.ENVS_KV.put(meta.slug, JSON.stringify(nextMeta), { metadata: nextMeta });
    }),
  );
}

async function buildContainerLaunchConfig(
  env: Env,
  requestUrl: string,
  slug: string,
  repoUrl: string,
  meta?: EnvMeta,
): Promise<{
  envVars: Record<string, string>;
  meta: Pick<EnvMeta, "authMode" | "resolvedAuthMode" | "authWarning" | "cliVersion">;
}> {
  const backend = getBackendKind(env, { stored: meta?.backend ?? null });
  const runnerId = meta?.runnerId ?? meta?.flyMachineId ?? slug;
  const auth = await resolveContainerAuth(env, { stored: meta?.authMode ?? null });
  const cliVersion = meta?.cliVersion ?? env.DEFAULT_TILLER_CLI_VERSION;
  const hubPublicUrl = await resolveHubPublicUrl(env, requestUrl);
  const githubToken = await getSecret(env, "GITHUB_TOKEN");
  const cfClientId = await getSecret(env, "CF_ACCESS_CLIENT_ID") ?? "";
  const cfClientSecret = await getSecret(env, "CF_ACCESS_CLIENT_SECRET") ?? "";

  return {
    envVars: {
      REPO_SLUG: slug,
      REPO_URL: repoUrl,
      ENV_SLUG: slug,
      RUNNER_BACKEND: backend,
      RUNNER_ID: runnerId,
      FLY_MACHINE_ID: meta?.flyMachineId ?? runnerId,
      HUB_URL: hubPublicUrl,
      CF_ACCESS_CLIENT_ID: cfClientId,
      CF_ACCESS_CLIENT_SECRET: cfClientSecret,
      NODE_OPTIONS: "--dns-result-order=ipv4first --no-network-family-autoselection",
      TILLER_CLAUDE_AUTH_MODE: auth.authMode,
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: auth.resolvedAuthMode,
      ...(auth.authWarning ? { TILLER_CLAUDE_AUTH_WARNING: auth.authWarning } : {}),
      ...auth.envVars,
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
      ...(cliVersion ? { TILLER_CLI_VERSION: cliVersion } : {}),
    },
    meta: {
      authMode: auth.authMode,
      resolvedAuthMode: auth.resolvedAuthMode,
      ...(auth.authWarning ? { authWarning: auth.authWarning } : {}),
      ...(cliVersion ? { cliVersion } : {}),
    },
  };
}

const envRoutes = new Hono<HonoEnv>();

envRoutes.get("/api/envs", async (c) => {
  const entries = await listEnvMetas(c.env);
  const repoCache = new Map<string, Promise<RepoWorkspaceHandle>>();

  const envs = await Promise.all(
    entries.map(async (meta) => {
      const status = await getResolvedStatus(c.env, meta);
      const repoUrl = normalizeRepoUrl(meta.repoUrl);
      let syncedMeta = meta;
      try {
        let repoPromise = repoCache.get(repoUrl);
        if (!repoPromise) {
          repoPromise = ensureRepoWorkspaceFromRepoUrl(c.env, repoUrl);
          repoCache.set(repoUrl, repoPromise);
        }
        const repo = await repoPromise;
        syncedMeta = await deriveEnvSyncMeta(c.env, meta, repo, status);
      } catch (error) {
        console.warn(`[envs] Failed to derive sync state for ${meta.slug}:`, error);
      }
      return { ...syncedMeta, status };
    }),
  );

  return c.json(envs);
});

envRoutes.post("/api/envs", async (c) => {
  const body = await c.req.json<{ repoUrl: string; slug?: string; backend?: string; authMode?: string; planId?: string | null }>();
  if (!body.repoUrl) return c.json({ error: "repoUrl is required" }, 400);
  if (body.backend && body.backend !== "cf" && body.backend !== "local") {
    return c.json({ error: "backend must be 'cf' or 'local'" }, 400);
  }
  if (body.authMode && body.authMode !== "auto" && body.authMode !== "subscription" && body.authMode !== "api") {
    return c.json({ error: "authMode must be 'auto', 'subscription', or 'api'" }, 400);
  }

  const backendKind = getBackendKind(c.env, { requested: body.backend ?? null });
  const authMode = resolveClaudeAuthMode({ requested: body.authMode ?? null });
  const requestedSlug = body.slug?.trim();
  const slug = requestedSlug
    ? requestedSlug
    : await findAvailableSlug(c.env.ENVS_KV, body.repoUrl, backendKind);
  const existing = await c.env.ENVS_KV.get(slug);
  if (existing) return c.json({ error: "Environment already exists", slug }, 409);
  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, body.repoUrl);

  let meta: EnvMeta = {
    slug,
    repoUrl: repo.meta.repoUrl,
    repoId: repo.meta.repoId,
    flyMachineId: slug,
    backend: backendKind,
    runnerId: backendKind === "cf" ? slug : undefined,
    authMode,
    createdAt: new Date().toISOString(),
    status: "creating",
    startupPlanId: null,
    baseRepoVersion: repo.meta.currentVersion,
    baseRepoRevisionId: repo.meta.currentRevisionId,
    legacyBaseRevision: false,
    workspaceDirty: false,
    syncState: "current",
    conflictedAgainstVersion: null,
    reconcileConflictCount: null,
    staleSinceRevisionId: null,
  };
  const planWorkspace = repo.workspace;
  const latestApprovedPlan =
    (await planWorkspace.listWorkspaceHandoffs()).find(
      (handoff) =>
        handoff.status === "approved" &&
        !handoff.legacyRevision &&
        handoff.repoRevisionId === repo.meta.currentRevisionId,
    ) ?? null;
  const selectedStartupPlanId = resolveStartupPlanId({
    requestedPlanId: body.planId,
    approvedPlans: latestApprovedPlan ? [latestApprovedPlan] : [],
  });
  if (selectedStartupPlanId) {
    const selectedPlan = await planWorkspace.readWorkspaceHandoff(selectedStartupPlanId);
    if (!selectedPlan || selectedPlan.status !== "approved") {
      return c.json({ error: `Approved plan not found: ${selectedStartupPlanId}` }, 400);
    }
    meta = {
      ...meta,
      startupPlanId: selectedPlan.id,
    };
  }

  let launchConfig: { envVars: Record<string, string>; meta: Pick<EnvMeta, "authMode" | "resolvedAuthMode" | "authWarning"> };
  try {
    launchConfig = await buildContainerLaunchConfig(c.env, c.req.url, slug, body.repoUrl, meta);
    meta = { ...meta, ...clearAuthWarning(meta), ...launchConfig.meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
  const workspaceStub = getWorkspaceStub(c.env, slug);
  await workspaceStub.destroyWorkspace();

  try {
    const tarBuffer = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
    const result = await workspaceStub.restoreFromTar(tarBuffer, { clearFirst: true });
    meta = { ...meta, bootMessage: `Workspace: ${result.fileCount} files` };

    const startupPlanId = await materializeStartupPlan(planWorkspace, workspaceStub, meta, repo.meta.currentRevisionId);
    meta = { ...meta, startupPlanId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[envs] Workspace init failed for ${slug}:`, message);
    await workspaceStub.destroyWorkspace().catch(() => {});
    return c.json({ error: `Failed to initialize canonical repo workspace: ${message}` }, 502);
  }

  await c.env.ENVS_KV.put(slug, JSON.stringify(meta), { metadata: meta });

  const backend = await getRunnerBackend(c.env, backendKind);
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const updated = await backend.create(meta, launchConfig.envVars);
        const still = await c.env.ENVS_KV.get(slug);
        if (!still) {
          try { await backend.destroy(updated); } catch { /* best effort */ }
          return;
        }
        const nextMeta: EnvMeta = {
          ...updated,
          ...launchConfig.meta,
          status: "started",
        };
        await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to create runner for ${slug}:`, message);
        const failed: EnvMeta = {
          ...meta,
          status: "failed",
          error: message,
          errorAt: new Date().toISOString(),
        };
        await c.env.ENVS_KV.put(slug, JSON.stringify(failed), { metadata: failed });
      }
    })(),
  );

  return c.json(meta, 201);
});

envRoutes.get("/api/envs/:slug", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const status = await getResolvedStatus(c.env, meta);
  return c.json({ ...meta, status });
});

envRoutes.post("/api/envs/:slug/start", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const body: { planId?: string | null } = c.req.header("Content-Type")?.includes("application/json")
    ? await c.req.json<{ planId?: string | null }>().catch(() => ({}))
    : {};

  const meta: EnvMeta = JSON.parse(raw);
  const resolvedStatus = await getResolvedStatus(c.env, meta);
  const backend = await getRunnerBackend(c.env, getBackendKind(c.env, { stored: meta.backend ?? null }));
  let launchConfig: { envVars: Record<string, string>; meta: Pick<EnvMeta, "authMode" | "resolvedAuthMode" | "authWarning"> };
  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, meta.repoUrl);
  const syncedMeta = await maybeFastForwardEnv(c.env, meta, resolvedStatus, repo);
  const workspaceStub = getWorkspaceStub(c.env, slug);
  let startupPlanId: string | null;

  try {
    launchConfig = await buildContainerLaunchConfig(c.env, c.req.url, slug, syncedMeta.repoUrl, syncedMeta);
    startupPlanId = await resolveSelectedPlanId(repo.workspace, syncedMeta, repo.meta.currentRevisionId, body.planId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }

  const planMeta: EnvMeta = {
    ...syncedMeta,
    startupPlanId,
  };
  await materializeStartupPlan(repo.workspace, workspaceStub, planMeta, repo.meta.currentRevisionId);

  const hub = getHub(c.env);

  const startingMeta: EnvMeta = {
    ...clearAuthWarning(clearEnvError(planMeta)),
    ...launchConfig.meta,
    status: "starting",
  };
  await c.env.ENVS_KV.put(slug, JSON.stringify(startingMeta), { metadata: startingMeta });
  await hub.broadcastEnvStatus(slug, "starting");

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const updated = await backend.start(startingMeta, launchConfig.envVars);
        const nextMeta: EnvMeta = {
          ...startingMeta,
          ...launchConfig.meta,
          ...updated,
          status: "started",
        };
        await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });
        await hub.broadcastEnvStatus(slug, "started");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to start runner for ${slug}:`, message);
        const failed: EnvMeta = {
          ...startingMeta,
          status: "failed",
          error: message,
          errorAt: new Date().toISOString(),
        };
        await c.env.ENVS_KV.put(slug, JSON.stringify(failed), { metadata: failed });
        await hub.broadcastEnvStatus(slug, "failed");
      }
    })(),
  );

  return c.json({ ok: true, slug, status: "starting" });
});

envRoutes.post("/api/envs/:slug/stop", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const backend = await getRunnerBackend(c.env, getBackendKind(c.env, { stored: meta.backend ?? null }));

  const hub = getHub(c.env);

  const stoppingMeta: EnvMeta = {
    ...clearEnvError(meta),
    status: "stopping",
  };
  await c.env.ENVS_KV.put(slug, JSON.stringify(stoppingMeta), { metadata: stoppingMeta });
  await hub.broadcastEnvStatus(slug, "stopping");

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await backend.stop(stoppingMeta);
        let nextMeta: EnvMeta = {
          ...stoppingMeta,
          status: "stopped",
        };
        try {
          const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, stoppingMeta.repoUrl);
          nextMeta = await maybeFastForwardEnv(c.env, nextMeta, "stopped", repo);
        } catch (syncError) {
          console.warn(`[envs] Failed to refresh sync state for ${slug} after stop:`, syncError);
        }
        await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });
        await hub.broadcastEnvStatus(slug, "stopped");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to stop runner for ${slug}:`, message);
        const recoveredStatus = normalizeRunnerStatus(await backend.getStatus(stoppingMeta).catch(() => "started"));
        const recoveredMeta: EnvMeta = {
          ...stoppingMeta,
          status: recoveredStatus === "stopped" ? "stopped" : "started",
          error: message,
          errorAt: new Date().toISOString(),
        };
        await c.env.ENVS_KV.put(slug, JSON.stringify(recoveredMeta), { metadata: recoveredMeta });
        await hub.broadcastEnvStatus(slug, recoveredMeta.status ?? "started");
      }
    })(),
  );

  return c.json({ ok: true, slug, status: "stopping" });
});

envRoutes.post("/api/envs/:slug/boot-progress", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ message: string }>();
  if (!body.message) return c.json({ error: "message is required" }, 400);

  const meta: EnvMeta = JSON.parse(raw);
  const nextMeta: EnvMeta = {
    ...meta,
    bootMessage: body.message,
  };
  await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });

  const hub = getHub(c.env);
  await hub.broadcastEnvStatus(slug, "starting", body.message);
  return c.json({ ok: true });
});

envRoutes.patch("/api/envs/:slug/config", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const body = await c.req.json<{ cliVersion?: string | null }>();

  if (body.cliVersion && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(body.cliVersion)) {
    return c.json({ error: "Invalid version format" }, 400);
  }

  if (body.cliVersion === null) {
    delete meta.cliVersion;
  } else if (body.cliVersion) {
    meta.cliVersion = body.cliVersion;
  }

  await c.env.ENVS_KV.put(slug, JSON.stringify(meta), { metadata: meta });
  return c.json({ ok: true, slug, cliVersion: meta.cliVersion ?? null });
});

envRoutes.post("/api/envs/:slug/commit-back", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const status = await getResolvedStatus(c.env, meta);
  if (status !== "stopped") {
    return c.json({ error: "Environment must be stopped before promoting changes to the repo" }, 409);
  }

  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, meta.repoUrl);
  let syncedMeta = await deriveEnvSyncMeta(c.env, meta, repo, status);
  if (syncedMeta.syncState === "legacy") {
    await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
    return c.json({ error: "This workspace must be discarded or recreated before it can promote changes to the repo" }, 409);
  }
  if (syncedMeta.syncState === "behind") {
    const nextMeta = await restoreEnvWorkspaceFromRepo(c.env, repo, syncedMeta);
    await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });
    return c.json({
      ok: true,
      slug,
      repoId: repo.meta.repoId,
      previousVersion: repo.meta.currentVersion,
      currentVersion: repo.meta.currentVersion,
      previousRevisionId: repo.meta.currentRevisionId,
      currentRevisionId: repo.meta.currentRevisionId,
      action: "fast-forwarded",
    });
  }
  if (syncedMeta.syncState === "needs-reconcile") {
    const reconcileResult = await reconcileEnvWorkspace(c.env, repo, syncedMeta);
    if (reconcileResult.action === "unsupported") {
      await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
      return c.json(
        {
          error: reconcileResult.unsupportedPaths.length > 0
            ? `Merge is blocked by ${reconcileResult.unsupportedPaths.length} non-text conflict(s). Discard changes to continue.`
            : "Merge is unavailable because the starting repo snapshot is missing. Discard changes to continue.",
        },
        409,
      );
    }
    syncedMeta = reconcileResult.nextMeta;
    await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
    if (reconcileResult.action === "conflicted") {
      return c.json(
        {
          error: `Merge found ${reconcileResult.conflictCount} conflict(s). Resolve them in the workspace, then promote to the repo again.`,
        },
        409,
      );
    }
  }
  if (syncedMeta.syncState === "conflicted") {
    await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
    return c.json(
      {
        error: `Resolve ${syncedMeta.reconcileConflictCount ?? "all"} merge conflict(s) in the workspace before promoting to the repo.`,
      },
      409,
    );
  }

  const workspaceStub = getWorkspaceStub(c.env, slug);
  const envTreeHash = await workspaceStub.computeWorkspaceTreeHash({ excludePrefixes: TREE_HASH_EXCLUDES });
  const currentRepoVersion = await readRepoVersionFromWorkspace(repo.workspace, repo.meta.currentVersion);
  if (currentRepoVersion?.treeHash && envTreeHash === currentRepoVersion.treeHash) {
    const nextMeta: EnvMeta = {
      ...syncedMeta,
      repoId: repo.meta.repoId,
      baseRepoVersion: repo.meta.currentVersion,
      baseRepoRevisionId: repo.meta.currentRevisionId,
      legacyBaseRevision: false,
      workspaceDirty: false,
      syncState: "current",
      conflictedAgainstVersion: null,
      reconcileConflictCount: null,
      staleSinceRevisionId: null,
    };
    await clearReconcileArtifacts(workspaceStub);
    await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });
    return c.json({
      ok: true,
      slug,
      repoId: repo.meta.repoId,
      previousVersion: repo.meta.currentVersion,
      currentVersion: repo.meta.currentVersion,
      previousRevisionId: repo.meta.currentRevisionId,
      currentRevisionId: repo.meta.currentRevisionId,
      action: "no-changes",
    });
  }

  const codeTar = await workspaceStub.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
  const previousVersion = repo.meta.currentVersion;
  const previousRevisionId = repo.meta.currentRevisionId;
  await repo.workspace.restoreFromTar(codeTar, {
    clearFirst: true,
    preservePrefixes: ["/.tiller"],
  });
  const nextRepoMeta = await commitRepoRevision({
    env: c.env,
    workspace: repo.workspace,
    meta: repo.meta,
    sourceEnvSlug: slug,
    summary: `Committed back from env ${slug}`,
  });

  const nextMeta: EnvMeta = {
    ...syncedMeta,
    repoId: nextRepoMeta.repoId,
    baseRepoVersion: nextRepoMeta.currentVersion,
    baseRepoRevisionId: nextRepoMeta.currentRevisionId,
    legacyBaseRevision: false,
    workspaceDirty: false,
    syncState: "current",
    conflictedAgainstVersion: null,
    reconcileConflictCount: null,
    staleSinceRevisionId: null,
  };
  await clearReconcileArtifacts(workspaceStub);
  await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });
  await refreshRepoEnvsAfterPromotion(c.env, { workspace: repo.workspace, meta: nextRepoMeta }, slug);

  const hub = getHub(c.env);
  await hub.broadcastRepoRevisionChange(
    nextRepoMeta.repoId,
    nextRepoMeta.repoUrl,
    previousVersion,
    nextRepoMeta.currentVersion,
    previousRevisionId,
    nextRepoMeta.currentRevisionId,
    slug,
  );

  return c.json({
    ok: true,
    slug,
    repoId: nextRepoMeta.repoId,
    previousVersion,
    currentVersion: nextRepoMeta.currentVersion,
    previousRevisionId,
    currentRevisionId: nextRepoMeta.currentRevisionId,
    action: "promoted",
  });
});

envRoutes.post("/api/envs/:slug/reconcile", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const status = await getResolvedStatus(c.env, meta);
  if (status !== "stopped") {
    return c.json({ error: "Environment must be stopped before merging changes" }, 409);
  }

  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, meta.repoUrl);
  const syncedMeta = await deriveEnvSyncMeta(c.env, meta, repo, status);
  if (syncedMeta.syncState === "legacy") {
    await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
    return c.json({ error: "This workspace must be discarded or recreated before it can merge changes" }, 409);
  }
  if (syncedMeta.syncState === "behind") {
    const nextMeta = await restoreEnvWorkspaceFromRepo(c.env, repo, syncedMeta);
    await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });
    return c.json({
      ok: true,
      slug,
      repoId: repo.meta.repoId,
      currentVersion: repo.meta.currentVersion,
      currentRevisionId: repo.meta.currentRevisionId,
      action: "fast-forwarded",
      conflictCount: 0,
    });
  }
  if (syncedMeta.syncState === "conflicted") {
    await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
    return c.json(
      {
        error: `Resolve ${syncedMeta.reconcileConflictCount ?? "all"} merge conflict(s) before merging again.`,
      },
      409,
    );
  }
  if (syncedMeta.syncState === "current") {
    await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
    return c.json({
      ok: true,
      slug,
      repoId: repo.meta.repoId,
      currentVersion: repo.meta.currentVersion,
      currentRevisionId: repo.meta.currentRevisionId,
      action: "already-current",
      conflictCount: 0,
    });
  }

  const reconcileResult = await reconcileEnvWorkspace(c.env, repo, syncedMeta);
  if (reconcileResult.action === "unsupported") {
    await c.env.ENVS_KV.put(slug, JSON.stringify(syncedMeta), { metadata: syncedMeta });
    return c.json(
      {
        error: reconcileResult.unsupportedPaths.length > 0
          ? `Merge is blocked by ${reconcileResult.unsupportedPaths.length} non-text conflict(s). Discard changes to continue.`
          : "Merge is unavailable because the starting repo snapshot is missing. Discard changes to continue.",
      },
      409,
    );
  }

  await c.env.ENVS_KV.put(slug, JSON.stringify(reconcileResult.nextMeta), { metadata: reconcileResult.nextMeta });
  return c.json({
    ok: true,
    slug,
    repoId: repo.meta.repoId,
    currentVersion: repo.meta.currentVersion,
    currentRevisionId: repo.meta.currentRevisionId,
    action: reconcileResult.action,
    conflictCount: reconcileResult.conflictCount,
  });
});

envRoutes.post("/api/envs/:slug/reset-to-repo", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const status = await getResolvedStatus(c.env, meta);
  if (status !== "stopped") {
    return c.json({ error: "Environment must be stopped before discarding changes" }, 409);
  }

  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, meta.repoUrl);
  const nextMeta = await restoreEnvWorkspaceFromRepo(c.env, repo, clearEnvError(meta));
  await c.env.ENVS_KV.put(slug, JSON.stringify(nextMeta), { metadata: nextMeta });

  return c.json({
    ok: true,
    slug,
    repoId: repo.meta.repoId,
    currentVersion: repo.meta.currentVersion,
    currentRevisionId: repo.meta.currentRevisionId,
  });
});

envRoutes.post("/api/envs/:slug/sync", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const hub = getHub(c.env);
  await hub.addMessage(crypto.randomUUID(), slug, { type: "sync" }, null);
  return c.json({ ok: true, slug, message: "Sync triggered" });
});

envRoutes.delete("/api/envs/:slug", async (c) => {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const hub = getHub(c.env);
  const deletingMeta: EnvMeta = {
    ...clearEnvError(meta),
    status: "deleting",
  };
  await c.env.ENVS_KV.put(slug, JSON.stringify(deletingMeta), { metadata: deletingMeta });
  await hub.broadcastEnvStatus(slug, "deleting");

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await destroyEnv(c.env, meta, hub);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to delete runner for ${slug}:`, message);
        const failed: EnvMeta = {
          ...deletingMeta,
          status: "failed",
          error: message,
          errorAt: new Date().toISOString(),
        };
        await c.env.ENVS_KV.put(slug, JSON.stringify(failed), { metadata: failed });
        await hub.broadcastEnvStatus(slug, "failed");
      }
    })(),
  );

  return c.json({ ok: true, slug, status: "deleting", message: "Environment deletion started" });
});

async function proxyTerminal(c: {
  env: Env;
  req: { url: string; param(name: string): string; raw: Request };
  json: (object: unknown, status?: number) => Response;
}) {
  const slug = c.req.param("slug");
  const raw = await c.env.ENVS_KV.get(slug);
  if (!raw) return c.json({ error: "Not found" }, 404);

  const meta: EnvMeta = JSON.parse(raw);
  const backend = await getRunnerBackend(c.env, getBackendKind(c.env, { stored: meta.backend ?? null }));

  const url = new URL(c.req.url);
  const prefix = `/api/envs/${slug}/terminal`;
  const path = url.pathname.slice(prefix.length) || "/";
  const subPath = `${path}${url.search}`;

  return backend.proxyTerminal(meta, c.req.raw, subPath);
}

envRoutes.all("/api/envs/:slug/terminal/*", (c) => proxyTerminal(c));
envRoutes.all("/api/envs/:slug/terminal", (c) => proxyTerminal(c));

export default envRoutes;
