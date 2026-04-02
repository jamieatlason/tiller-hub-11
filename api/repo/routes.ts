import { Hono } from "hono";
import { listApprovedHandoffs } from "../agent-core/handoffs";
import type { HubDO } from "../hub";
import type { HonoEnv, Env, RepoMeta, EnvMeta } from "../types";
import {
  deleteRepoIndex,
  getRepoPlanStoreKey,
  getRepoWorkspaceForRepoId,
  listEnvMetas,
  listRepos,
  normalizeRepoUrl,
  readRepoIndexEntry,
} from "../plan/store";
import { getWorkspaceStub } from "../helpers";
import { destroyEnv } from "../env/routes";
import { integratePlanReviews, runPlanReviewRound } from "../plan/review-service";

const repoRoutes = new Hono<HonoEnv>();

function isCurrentRevisionApproved(repo: RepoMeta, approvedPlans: ReturnType<typeof listApprovedHandoffs>): boolean {
  return approvedPlans.some((handoff) => handoff.repoRevisionId === repo.currentRevisionId && !handoff.legacyRevision);
}

function repoMatchesEnv(repo: RepoMeta, env: EnvMeta): boolean {
  if (env.repoId && repo.repoId) {
    return env.repoId === repo.repoId;
  }
  return normalizeRepoUrl(env.repoUrl) === normalizeRepoUrl(repo.repoUrl);
}

async function augmentRepoMeta(c: {
  env: HonoEnv["Bindings"];
}, repo: RepoMeta): Promise<RepoMeta> {
  const envEntries = await listEnvMetas(c.env);
  const envCount = envEntries.filter((entry) => repoMatchesEnv(repo, entry)).length;
  const repoWorkspace = await getRepoWorkspaceForRepoId(c.env, repo.repoId);
  const approvedPlans = repoWorkspace
    ? listApprovedHandoffs(await repoWorkspace.workspace.listWorkspaceHandoffs())
    : [];
  return {
    ...repo,
    envCount,
    hasCurrentApprovedPlan: isCurrentRevisionApproved(repo, approvedPlans),
  };
}

function ensureDraftIsCurrent(repo: RepoMeta, draft: { repoRevisionId?: string | null; legacyRevision?: boolean }): string | null {
  if (draft.legacyRevision || !draft.repoRevisionId) {
    return "Pre-revision drafts cannot be modified. Start a new draft on the current repo revision.";
  }
  if (draft.repoRevisionId !== repo.currentRevisionId) {
    return `Draft is outdated for this repo revision (${draft.repoRevisionId} vs ${repo.currentRevisionId})`;
  }
  return null;
}

repoRoutes.get("/api/repos", async (c) => {
  const repos = await listRepos(c.env);
  const enriched = await Promise.all(repos.map((repo) => augmentRepoMeta(c, repo)));
  return c.json(enriched);
});

repoRoutes.get("/api/repos/:repoId", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  return c.json(await augmentRepoMeta(c, repo.meta));
});

repoRoutes.get("/api/repos/:repoId/handoffs", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  return c.json(await repo.workspace.listWorkspaceHandoffs());
});

repoRoutes.get("/api/repos/:repoId/approved-plans", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const handoffs = await repo.workspace.listWorkspaceHandoffs();
  return c.json(listApprovedHandoffs(handoffs));
});

repoRoutes.post("/api/repos/:repoId/handoffs/:id/approve", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const handoff = await repo.workspace.readWorkspaceHandoff(c.req.param("id"));
  if (!handoff) {
    return c.json({ error: "Handoff not found" }, 404);
  }
  const revisionError = ensureDraftIsCurrent(repo.meta, handoff);
  if (revisionError) {
    return c.json({ error: revisionError }, 409);
  }
  const approved = await repo.workspace.approveWorkspaceHandoff(c.req.param("id"));
  return c.json({ ok: true, handoff: approved });
});

repoRoutes.post("/api/repos/:repoId/handoffs/:id/discard", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const handoff = await repo.workspace.discardWorkspaceHandoff(c.req.param("id"));
  if (!handoff) {
    return c.json({ error: "Handoff not found" }, 404);
  }
  return c.json({ ok: true, handoff });
});

repoRoutes.post("/api/repos/:repoId/handoffs/:id/review-round", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const draft = await repo.workspace.readWorkspaceHandoff(c.req.param("id"));
  if (!draft) {
    return c.json({ error: "Handoff not found" }, 404);
  }
  const revisionError = ensureDraftIsCurrent(repo.meta, draft);
  if (revisionError) {
    return c.json({ error: revisionError }, 409);
  }
  try {
    return c.json(
      await runPlanReviewRound({
        env: c.env,
        repoPlan: {
          meta: repo.meta,
          planWorkspace: repo.workspace,
        },
        draft,
      }),
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to run plan review round" },
      502,
    );
  }
});

repoRoutes.post("/api/repos/:repoId/handoffs/:id/integrate", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const draft = await repo.workspace.readWorkspaceHandoff(c.req.param("id"));
  if (!draft) {
    return c.json({ error: "Handoff not found" }, 404);
  }
  const revisionError = ensureDraftIsCurrent(repo.meta, draft);
  if (revisionError) {
    return c.json({ error: revisionError }, 409);
  }
  const body = await c.req.json<{ selectedModel?: unknown }>().catch(() => ({}));
  try {
    return c.json(
      await integratePlanReviews({
        env: c.env,
        repoPlan: {
          meta: repo.meta,
          planWorkspace: repo.workspace,
        },
        draft,
        selectedModel: body.selectedModel,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to integrate reviews";
    const status = message === "No review artifacts found for this draft" ? 400 : 502;
    return c.json({ error: message }, status);
  }
});

function getHub(
  env: Env,
): Pick<HubDO, "broadcastEnvStatus"> {
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId) as unknown as Pick<HubDO, "broadcastEnvStatus">;
}

repoRoutes.delete("/api/repos/:repoId", async (c) => {
  const repoId = c.req.param("repoId");
  const indexEntry = await readRepoIndexEntry(c.env, repoId);
  if (!indexEntry) {
    return c.json({ error: "Repo not found" }, 404);
  }

  // Find all attached environments
  const allEnvs = await listEnvMetas(c.env);
  const attachedEnvs = allEnvs.filter((env) => repoMatchesEnv({ repoId, repoUrl: indexEntry.repoUrl } as RepoMeta, env));

  // Broadcast "deleting" status for each env, then delete all KV entries
  // immediately so listRepos cannot rediscover the repo from env metadata.
  const hub = getHub(c.env);
  for (const env of attachedEnvs) {
    await hub.broadcastEnvStatus(env.slug, "deleting");
  }
  for (const env of attachedEnvs) {
    await c.env.ENVS_KV.delete(env.slug);
  }
  await deleteRepoIndex(c.env, repoId);

  // Background cleanup: destroy envs then repo workspace
  c.executionCtx.waitUntil(
    (async () => {
      for (const env of attachedEnvs) {
        try {
          await destroyEnv(c.env, env, hub);
        } catch (err) {
          console.error(`[repos] Failed to destroy env ${env.slug} during repo deletion:`, err);
        }
      }
      try {
        const workspaceStub = getWorkspaceStub(c.env, getRepoPlanStoreKey(indexEntry.repoUrl));
        await workspaceStub.destroyWorkspace();
      } catch (err) {
        console.error(`[repos] Failed to destroy repo workspace for ${repoId}:`, err);
      }
    })(),
  );

  return c.json({
    ok: true,
    repoId,
    deletedEnvSlugs: attachedEnvs.map((e) => e.slug),
  });
});

export default repoRoutes;
