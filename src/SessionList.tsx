import { useState } from "react";
import type { StoredSession, EnvMeta, RepoMeta } from "../api/types";
import { commitBackEnv, deleteEnv, deleteRepo, reconcileEnv, resetEnvToRepo, stopEnv } from "./api";

interface SessionListProps {
  repos: RepoMeta[];
  sessions: StoredSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  permissionCounts?: Record<string, number>;
  envs?: EnvMeta[];
  hubUrl?: string;
  onPollEnvStatus?: (slug: string) => void;
  onStatusChange?: (slug: string, status: string) => void;
  onEnvSelect?: (slug: string) => void;
  selectedEnvSlug?: string | null;
  onPlanSelect?: (repoId: string, repoUrl: string) => void;
  planRepoId?: string | null;
  onStartRequest?: (slug: string) => void;
  onRefreshData?: () => void;
}

export default function SessionList({
  repos,
  sessions,
  selectedId,
  onSelect,
  permissionCounts = {},
  envs = [],
  hubUrl = "",
  onPollEnvStatus,
  onStatusChange,
  onEnvSelect,
  selectedEnvSlug,
  onPlanSelect,
  planRepoId,
  onStartRequest,
  onRefreshData,
}: SessionListProps) {
  const envSlugs = new Set(envs.map((env) => env.slug));
  const envSessionMap = new Map<string, StoredSession>();
  for (const session of sessions) {
    if (envSlugs.has(session.tag)) {
      envSessionMap.set(session.tag, session);
    }
  }

  const repoGroups = repos.map((repo) => ({
    repo,
    envs: envs.filter((env) => matchesRepo(repo, env)),
  }));

  const standaloneSessions = sessions.filter((session) => !envSlugs.has(session.tag));

  return (
    <div className="flex-1 overflow-y-auto">
      {repoGroups.map(({ repo, envs: repoEnvs }) => (
        <div key={repo.repoId} className="border-b border-[#e1e4e8]">
          <RepoGroupHeader
            repo={repo}
            planRepoId={planRepoId}
            hubUrl={hubUrl}
            envCount={repoEnvs.length}
            onPlanSelect={onPlanSelect}
            onRefreshData={onRefreshData}
          />
          <div className="ml-3 border-l border-[#e1e4e8]">
            {repoEnvs.length === 0 ? (
              <p className="px-3 py-2 text-xs text-[#6e7781]">No environments yet</p>
            ) : (
              repoEnvs.map((env) => {
                const session = envSessionMap.get(env.slug);
                const permCount = session ? (permissionCounts[session.id] || 0) : 0;
                const isSelected =
                  planRepoId === repo.repoId ||
                  (session ? session.id === selectedId : selectedEnvSlug === env.slug);

                return (
                  <EnvCard
                    key={env.slug}
                    env={env}
                    repo={repo}
                    session={session}
                    permCount={permCount}
                    hubUrl={hubUrl}
                    onPollStatus={onPollEnvStatus}
                    onStatusChange={onStatusChange}
                    onSelect={(slug) => {
                      if (session) {
                        onSelect(session.id);
                      } else {
                        onEnvSelect?.(slug);
                      }
                    }}
                    onStartRequest={onStartRequest}
                    onRefreshData={onRefreshData}
                    selected={isSelected}
                  />
                );
              })
            )}
          </div>
        </div>
      ))}

      {standaloneSessions.length > 0 && (
        <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[#57606a] bg-[#f6f8fa] border-b border-[#e1e4e8]">
          Local Sessions
        </div>
      )}
      {standaloneSessions.map((session) => {
        const active = session.active === 1;
        const selected = session.id === selectedId;
        const meta = tryParse(session.metadata);
        const permCount = permissionCounts[session.id] || 0;
        return (
          <button
            key={session.id}
            onClick={() => onSelect(session.id)}
            className={`w-full text-left px-3 py-2.5 border-b border-[#e1e4e8] hover:bg-white transition-colors ${
              selected ? "bg-white border-l-2 border-l-[#0969da]" : "border-l-2 border-l-transparent"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${active ? "bg-green-500" : "bg-[#d0d7de]"}`} />
              <span className="text-sm font-medium truncate flex-1 text-[#24292f]">
                {session.tag}
              </span>
              {permCount > 0 && (
                <span className="flex-shrink-0 bg-amber-100 text-amber-700 text-xs font-medium px-1.5 py-0.5 rounded-full border border-amber-200">
                  {permCount}
                </span>
              )}
            </div>
            {meta?.host && (
              <p className="text-xs text-[#57606a] mt-0.5 ml-4 truncate">
                {meta.host}
                {meta.cwd ? ` : ${meta.cwd}` : ""}
              </p>
            )}
            {meta?.repoUrl && (
              <p className="text-xs text-[#0969da] mt-0.5 ml-4 truncate">{repoLabel(meta.repoUrl)}</p>
            )}
            <p className="text-xs text-[#6e7781] mt-0.5 ml-4">{formatTime(session.updated_at)}</p>
          </button>
        );
      })}

      {repos.length === 0 && sessions.length === 0 && (
        <p className="p-3 text-sm text-[#57606a]">No repositories yet</p>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  started: "bg-green-500",
  running: "bg-green-500",
  starting: "bg-yellow-400 animate-pulse",
  stopping: "bg-yellow-400 animate-pulse",
  creating: "bg-blue-400 animate-pulse",
  deleting: "bg-red-400 animate-pulse",
  stopped: "bg-[#d0d7de]",
  created: "bg-blue-400",
  destroyed: "bg-red-400",
  failed: "bg-red-500",
};

function EnvCard({
  env,
  repo,
  session,
  permCount,
  hubUrl,
  onPollStatus,
  onStatusChange,
  onSelect,
  onStartRequest,
  onRefreshData,
  selected,
}: {
  env: EnvMeta;
  repo: RepoMeta;
  session?: StoredSession;
  permCount: number;
  hubUrl: string;
  onPollStatus?: (slug: string) => void;
  onStatusChange?: (slug: string, status: string) => void;
  onSelect?: (slug: string) => void;
  onStartRequest?: (slug: string) => void;
  onRefreshData?: () => void;
  selected?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const status = env.status || "unknown";
  const hasActiveSession = session && session.active === 1;
  const isCreating = status === "creating";
  const isStarting = status === "starting";
  const isRunning = status === "started" || status === "running";
  const isStopping = status === "stopping";
  const isDeleting = status === "deleting";
  const isFailed = status === "failed";
  const canStart = status === "stopped" || status === "unknown" || isFailed;
  const canRepoAction = status === "stopped";
  const baseRepoVersion = env.baseRepoVersion ?? parseRepoVersion(env.baseRepoRevisionId);
  const syncState = env.syncState
    ?? ((!baseRepoVersion || env.legacyBaseRevision) ? "legacy" : baseRepoVersion < repo.currentVersion ? "behind" : "current");
  const isLegacy = syncState === "legacy";
  const isBehind = syncState === "behind";
  const needsReconcile = syncState === "needs-reconcile";
  const isConflicted = syncState === "conflicted";
  const hasLocalChanges = env.workspaceDirty === true;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      console.error("[tiller] env action failed:", err);
      alert(err instanceof Error ? err.message : "Environment action failed.");
    } finally {
      setBusy(false);
    }
  };

  const dotColor = hasActiveSession && !canStart
    ? "bg-green-500"
    : STATUS_COLORS[status] || "bg-[#d0d7de]";

  let label: string;
  if (isDeleting) label = "Deleting...";
  else if (isCreating) label = "Creating...";
  else if (isStarting) label = "Starting...";
  else if (isStopping) label = "Stopping...";
  else if (isFailed) label = "Failed";
  else if (canStart) label = "Stopped";
  else if (hasActiveSession) label = "Active";
  else if (isRunning) label = "Connecting...";
  else label = status;

  const authBadgeClass = env.resolvedAuthMode === "api"
    ? "border-amber-200 bg-amber-50 text-amber-700"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
  const authLabel = env.resolvedAuthMode === "api"
    ? (env.authMode === "api" ? "api" : "api fallback")
    : "subscription";

  return (
    <div className={`px-3 py-2.5 border-b border-[#e1e4e8] hover:bg-white transition-colors cursor-pointer ${
      selected ? "bg-white border-l-2 border-l-[#0969da]" : "border-l-2 border-l-transparent"
    }`} onClick={() => onSelect?.(env.slug)}>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        <span className="text-sm font-medium truncate flex-1 text-[#24292f]">{env.slug}</span>
        <span className="flex-shrink-0 rounded border border-[#d0d7de] bg-[#f6f8fa] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#57606a]">
          {env.backend || "cf"}
        </span>
        {env.resolvedAuthMode && (
          <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${authBadgeClass}`}>
            {authLabel}
          </span>
        )}
        {permCount > 0 && (
          <span className="flex-shrink-0 bg-amber-100 text-amber-700 text-xs font-medium px-1.5 py-0.5 rounded-full border border-amber-200">
            {permCount}
          </span>
        )}
        <span className="text-xs text-[#6e7781]">{label}</span>
      </div>
      <p className="text-xs text-[#0969da] mt-0.5 ml-4 truncate">
        {repoLabel(env.repoUrl)}
      </p>
      {env.authWarning && <p className="text-[11px] text-amber-700 mt-0.5 ml-4 truncate">{env.authWarning}</p>}
      <p className="text-[11px] text-[#57606a] mt-0.5 ml-4">
        Plan: {env.startupPlanId ? "Selected" : "None"}
      </p>
      <p className="text-[11px] text-[#57606a] mt-0.5 ml-4">
        {isLegacy
          ? "Sync: reset required"
          : isConflicted
            ? "Sync: conflicts to resolve"
          : needsReconcile
            ? "Sync: merge needed"
            : isBehind
              ? "Sync: behind repo"
              : hasLocalChanges
                ? "Sync: current, local changes"
                : "Sync: current"}
      </p>
      {syncDetailText(env, repo) && (
        <p className="text-[11px] text-[#6e7781] mt-0.5 ml-4">
          {syncDetailText(env, repo)}
        </p>
      )}
      <div className="flex gap-1 mt-1.5 ml-4 flex-wrap" onClick={(e) => e.stopPropagation()}>
        {canStart && (
          <button
            onClick={() => onStartRequest?.(env.slug)}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Start
          </button>
        )}
        {isRunning && (
          <button
            onClick={() => run(async () => {
              const res = await stopEnv(hubUrl, env.slug);
              onStatusChange?.(env.slug, res.status);
              onPollStatus?.(env.slug);
            })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Stop
          </button>
        )}
        {canRepoAction && syncState === "current" && hasLocalChanges && (
          <button
            onClick={() => run(async () => {
              await commitBackEnv(hubUrl, env.slug);
              onStatusChange?.(env.slug, "stopped");
              onRefreshData?.();
            })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Promote to Repo
          </button>
        )}
        {canRepoAction && needsReconcile && (
          <button
            onClick={() => run(async () => {
              await reconcileEnv(hubUrl, env.slug);
              onStatusChange?.(env.slug, "stopped");
              onRefreshData?.();
            })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Merge Changes
          </button>
        )}
        {canRepoAction && isBehind && (
          <button
            onClick={() => run(async () => {
              await resetEnvToRepo(hubUrl, env.slug);
              onStatusChange?.(env.slug, "stopped");
              onRefreshData?.();
            })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Update from Repo
          </button>
        )}
        {canRepoAction && (needsReconcile || isLegacy || isConflicted) && (
          <button
            onClick={() => run(async () => {
              await resetEnvToRepo(hubUrl, env.slug);
              onStatusChange?.(env.slug, "stopped");
              onRefreshData?.();
            })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Discard Changes
          </button>
        )}
        {!isDeleting && (
          <button
            onClick={async () => {
              if (confirm(`Delete environment "${env.slug}"? This will destroy the container and wipe R2 storage.`)) {
                setBusy(true);
                try {
                  await deleteEnv(hubUrl, env.slug);
                  onStatusChange?.(env.slug, "deleting");
                } catch (err) {
                  console.error("[tiller] delete failed:", err);
                  alert("Failed to delete environment. Please try again.");
                } finally {
                  setBusy(false);
                }
              }
            }}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-red-200 bg-white hover:bg-red-50 text-red-600 disabled:opacity-40"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function matchesRepo(repo: RepoMeta, env: EnvMeta): boolean {
  if (env.repoId) return env.repoId === repo.repoId;
  return normalizeRepoUrl(env.repoUrl) === normalizeRepoUrl(repo.repoUrl);
}

function tryParse(json: string): { host?: string; cwd?: string; repoUrl?: string } | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "Z");
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function RepoGroupHeader({
  repo,
  planRepoId,
  hubUrl,
  envCount,
  onPlanSelect,
  onRefreshData,
}: {
  repo: RepoMeta;
  planRepoId?: string | null;
  hubUrl: string;
  envCount: number;
  onPlanSelect?: (repoId: string, repoUrl: string) => void;
  onRefreshData?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className={`px-3 py-1.5 text-xs font-semibold text-[#57606a] ${planRepoId === repo.repoId ? "bg-white" : "bg-[#f6f8fa]"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <span className="truncate">{repoLabel(repo.repoUrl)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onPlanSelect?.(repo.repoId, repo.repoUrl)}
            className="rounded border border-[#d8b4fe] bg-white px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#7c3aed] hover:bg-[#faf5ff]"
          >
            Plan
          </button>
          <button
            onClick={async () => {
              const envWarning = envCount > 0
                ? `\n\nThis will also destroy ${envCount} environment(s) and their containers.`
                : "";
              if (!confirm(`Delete repo "${repoLabel(repo.repoUrl)}"?${envWarning}`)) return;
              setBusy(true);
              try {
                await deleteRepo(hubUrl, repo.repoId);
                onRefreshData?.();
              } catch (err) {
                console.error("[tiller] repo delete failed:", err);
                alert(err instanceof Error ? err.message : "Failed to delete repo.");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            {busy ? "..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function repoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

function parseRepoVersion(revisionId?: string | null): number | null {
  if (!revisionId) return null;
  const match = revisionId.match(/^r(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function formatVersion(version?: number | null): string {
  return version ? `v${version}` : "legacy";
}

function formatRepoVersion(repo: RepoMeta): string {
  return formatVersion(repo.currentVersion ?? parseRepoVersion(repo.currentRevisionId));
}

function syncDetailText(env: EnvMeta, repo: RepoMeta): string | null {
  const baseRepoVersion = env.baseRepoVersion ?? parseRepoVersion(env.baseRepoRevisionId);
  const syncState = env.syncState
    ?? ((!baseRepoVersion || env.legacyBaseRevision) ? "legacy" : baseRepoVersion < repo.currentVersion ? "behind" : "current");

  if (syncState === "legacy") {
    return "This workspace needs to be rebuilt from the repo before it can sync normally.";
  }
  if (syncState === "conflicted") {
    const count = env.reconcileConflictCount ?? 0;
    const fileLabel = `${count} conflicted file${count === 1 ? "" : "s"}`;
    return `${fileLabel}. Based on ${formatVersion(baseRepoVersion)} while the repo is ${formatRepoVersion(repo)}.`;
  }
  if (syncState === "needs-reconcile") {
    return `Local changes and repo changes both exist. Based on ${formatVersion(baseRepoVersion)} while the repo is ${formatRepoVersion(repo)}.`;
  }
  if (syncState === "behind") {
    return `This workspace is based on ${formatVersion(baseRepoVersion)} while the repo is ${formatRepoVersion(repo)}.`;
  }
  if (env.workspaceDirty === true) {
    return "Ready to promote when you're done.";
  }
  return null;
}
