import { getWorkspaceStub, repoToTarballUrl } from "../helpers";
import type { Env, EnvMeta, RepoMeta, RepoRevisionMeta } from "../types";
import type { WorkspaceDO } from "../workspace/do";
import { getSecret } from "../setup/config";

const PLAN_STORE_PREFIX = "plan-store:";
const REPO_INDEX_PREFIX = "repo:";
const REPO_META_PATH = "/.tiller/repo/meta.json";
const REPO_REVISIONS_DIR = "/.tiller/repo/revisions";
const REPO_SNAPSHOTS_DIR = "/.tiller/repo/snapshots";
const WORKSPACE_TREE_HASH_EXCLUDES = ["/.tiller", "/.claude/settings.local.json"];

interface RepoIndexEntry {
  repoId: string;
  repoUrl: string;
  updatedAt: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnvMetaRecord(value: unknown): value is EnvMeta {
  return (
    isObjectRecord(value) &&
    typeof value.slug === "string" &&
    typeof value.repoUrl === "string" &&
    typeof value.flyMachineId === "string" &&
    typeof value.createdAt === "string"
  );
}

export function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

export function versionFromRevisionId(revisionId?: string | null): number | null {
  if (!revisionId) return null;
  const match = revisionId.match(/^r(\d+)$/i);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isFinite(version) && version > 0 ? version : null;
}

export function revisionIdFromVersion(version: number): string {
  return `r${version}`;
}

export function getRepoCurrentVersion(meta: Pick<RepoMeta, "currentVersion" | "currentRevisionId">): number {
  return meta.currentVersion ?? versionFromRevisionId(meta.currentRevisionId) ?? 1;
}

export function getEnvBaseRepoVersion(
  meta: Pick<EnvMeta, "baseRepoVersion" | "baseRepoRevisionId">,
): number | null {
  return meta.baseRepoVersion ?? versionFromRevisionId(meta.baseRepoRevisionId) ?? null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveRepoId(repoUrl: string): Promise<string> {
  return sha256Hex(normalizeRepoUrl(repoUrl));
}

export function getRepoPlanStoreKey(repoUrl: string): string {
  return `${PLAN_STORE_PREFIX}${normalizeRepoUrl(repoUrl)}`;
}

function getRepoIndexKey(repoId: string): string {
  return `${REPO_INDEX_PREFIX}${repoId}`;
}

export function getRepoWorkspaceStubFromRepoUrl(
  env: Env,
  repoUrl: string,
): WorkspaceDO {
  return getWorkspaceStub(env, getRepoPlanStoreKey(repoUrl));
}

export const getRepoPlanWorkspaceStubFromRepoUrl = getRepoWorkspaceStubFromRepoUrl;

async function readJsonFile<T>(workspace: WorkspaceDO, path: string): Promise<T | null> {
  const raw = await workspace.readWorkspaceFile(path);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(workspace: WorkspaceDO, path: string, value: unknown): Promise<void> {
  await workspace.writeWorkspaceFile(path, JSON.stringify(value, null, 2));
}

async function hasRepoSnapshot(workspace: WorkspaceDO): Promise<boolean> {
  const rootEntries = await workspace.readWorkspaceDir("/");
  return rootEntries.some((entry) => entry.path !== "/.tiller");
}

export async function readRepoMetaFromWorkspace(workspace: WorkspaceDO): Promise<RepoMeta | null> {
  return readJsonFile<RepoMeta>(workspace, REPO_META_PATH);
}

export async function readRepoRevisionFromWorkspace(
  workspace: WorkspaceDO,
  revisionId: string,
): Promise<RepoRevisionMeta | null> {
  return readJsonFile<RepoRevisionMeta>(workspace, `${REPO_REVISIONS_DIR}/${revisionId}.json`);
}

export async function readRepoVersionFromWorkspace(
  workspace: WorkspaceDO,
  version: number,
): Promise<RepoRevisionMeta | null> {
  return readRepoRevisionFromWorkspace(workspace, revisionIdFromVersion(version));
}

function getRepoRevisionSnapshotPath(revisionId: string): string {
  return `${REPO_SNAPSHOTS_DIR}/${revisionId}.tar`;
}

export async function readRepoRevisionSnapshotFromWorkspace(
  workspace: WorkspaceDO,
  revisionId: string,
): Promise<Uint8Array | null> {
  return workspace.readWorkspaceFileBytes(getRepoRevisionSnapshotPath(revisionId));
}

export async function readRepoVersionSnapshotFromWorkspace(
  workspace: WorkspaceDO,
  version: number,
): Promise<Uint8Array | null> {
  return readRepoRevisionSnapshotFromWorkspace(workspace, revisionIdFromVersion(version));
}

async function writeRepoRevisionSnapshotToWorkspace(
  workspace: WorkspaceDO,
  revisionId: string,
  tarBuffer: Uint8Array,
): Promise<void> {
  await workspace.writeWorkspaceFileBytes(getRepoRevisionSnapshotPath(revisionId), tarBuffer);
}

export async function writeRepoMetaToWorkspace(workspace: WorkspaceDO, meta: RepoMeta): Promise<void> {
  await writeJsonFile(workspace, REPO_META_PATH, meta);
}

export async function writeRepoRevisionToWorkspace(
  workspace: WorkspaceDO,
  revision: RepoRevisionMeta,
): Promise<void> {
  await writeJsonFile(workspace, `${REPO_REVISIONS_DIR}/${revision.id}.json`, revision);
}

async function writeRepoIndex(env: Pick<Env, "ENVS_KV">, entry: RepoIndexEntry): Promise<void> {
  await env.ENVS_KV.put(getRepoIndexKey(entry.repoId), JSON.stringify(entry));
}

export async function deleteRepoIndex(env: Pick<Env, "ENVS_KV">, repoId: string): Promise<void> {
  await env.ENVS_KV.delete(getRepoIndexKey(repoId));
}

export async function readRepoIndexEntry(
  env: Pick<Env, "ENVS_KV">,
  repoId: string,
): Promise<RepoIndexEntry | null> {
  const raw = await env.ENVS_KV.get(getRepoIndexKey(repoId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as RepoIndexEntry;
  } catch {
    return null;
  }
}

async function listRepoIndexEntries(env: Pick<Env, "ENVS_KV">): Promise<RepoIndexEntry[]> {
  const listed = await env.ENVS_KV.list({ prefix: REPO_INDEX_PREFIX });
  const entries = await Promise.all(
    listed.keys.map((key) => env.ENVS_KV.get(key.name)),
  );
  return entries.flatMap((raw) => {
    if (!raw) return [];
    try {
      return [JSON.parse(raw) as RepoIndexEntry];
    } catch {
      return [];
    }
  });
}

export async function readEnvMeta(
  env: Pick<Env, "ENVS_KV">,
  slug: string,
): Promise<EnvMeta | null> {
  const raw = await env.ENVS_KV.get(slug);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isEnvMetaRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function listEnvMetas(
  env: Pick<Env, "ENVS_KV">,
): Promise<EnvMeta[]> {
  const listed = await env.ENVS_KV.list<EnvMeta>();
  // KV list metadata can lag behind recent puts. Re-read each value so repo
  // revision bookkeeping uses the latest env record.
  const entries = await Promise.all(listed.keys.map((key) => readEnvMeta(env, key.name)));
  return entries.filter((entry): entry is EnvMeta => !!entry);
}

function buildInitialRepoMeta(args: {
  repoId: string;
  repoUrl: string;
  version: number;
  revisionId: string;
  createdAt: string;
  bootstrappedFromRef: string | null;
}): RepoMeta {
  return {
    repoId: args.repoId,
    repoUrl: args.repoUrl,
    currentVersion: args.version,
    currentRevisionId: args.revisionId,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
    bootstrappedFromRef: args.bootstrappedFromRef,
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
  };
}

async function ensureRepoIndex(env: Pick<Env, "ENVS_KV">, meta: RepoMeta): Promise<void> {
  await writeRepoIndex(env, {
    repoId: meta.repoId,
    repoUrl: meta.repoUrl,
    updatedAt: meta.updatedAt,
  });
}

function normalizeRepoMeta(meta: RepoMeta): RepoMeta {
  const currentVersion = getRepoCurrentVersion(meta);
  const currentRevisionId = meta.currentRevisionId || revisionIdFromVersion(currentVersion);
  if (meta.currentVersion === currentVersion && meta.currentRevisionId === currentRevisionId) {
    return meta;
  }
  return {
    ...meta,
    currentVersion,
    currentRevisionId,
  };
}

async function ensureCurrentRepoRevisionMetadata(
  env: Pick<Env, "ENVS_KV">,
  workspace: WorkspaceDO,
  meta: RepoMeta,
): Promise<RepoMeta> {
  const normalizedMeta = normalizeRepoMeta(meta);
  const currentVersion = normalizedMeta.currentVersion;
  const currentRevisionId = normalizedMeta.currentRevisionId;
  const currentRevision = await readRepoRevisionFromWorkspace(workspace, currentRevisionId);
  const currentTreeHash = await workspace.computeWorkspaceTreeHash({ excludePrefixes: WORKSPACE_TREE_HASH_EXCLUDES });

  if (
    !currentRevision ||
    currentRevision.version !== currentVersion ||
    typeof currentRevision.treeHash !== "string" ||
    currentRevision.treeHash.length === 0 ||
    currentRevision.treeHash !== currentTreeHash
  ) {
    const nextRevision: RepoRevisionMeta = {
      id: currentRevisionId,
      repoId: normalizedMeta.repoId,
      version: currentVersion,
      parentRevisionId: currentRevision?.parentRevisionId ?? (currentVersion > 1 ? revisionIdFromVersion(currentVersion - 1) : null),
      source: currentRevision?.source ?? "github-bootstrap",
      sourceEnvSlug: currentRevision?.sourceEnvSlug ?? null,
      createdAt: currentRevision?.createdAt ?? normalizedMeta.updatedAt,
      summary: currentRevision?.summary ?? "Bootstrap canonical repo state from GitHub HEAD",
      treeHash: currentTreeHash,
    };
    await writeRepoRevisionToWorkspace(workspace, nextRevision);
  }

  const currentSnapshot = await readRepoRevisionSnapshotFromWorkspace(workspace, currentRevisionId);
  if (!currentSnapshot) {
    const snapshotTar = await workspace.downloadTar({ excludePrefixes: WORKSPACE_TREE_HASH_EXCLUDES });
    await writeRepoRevisionSnapshotToWorkspace(workspace, currentRevisionId, snapshotTar);
  }

  if (normalizedMeta !== meta) {
    await writeRepoMetaToWorkspace(workspace, normalizedMeta);
  }

  await ensureRepoIndex(env, normalizedMeta);
  return normalizedMeta;
}

export async function ensureRepoWorkspaceFromRepoUrl(
  env: Env,
  repoUrl: string,
): Promise<{ workspace: WorkspaceDO; meta: RepoMeta }> {
  const normalizedRepoUrl = normalizeRepoUrl(repoUrl);
  const workspace = getRepoWorkspaceStubFromRepoUrl(env, normalizedRepoUrl);
  const existingMeta = await readRepoMetaFromWorkspace(workspace);
  if (existingMeta) {
    const meta = await ensureCurrentRepoRevisionMetadata(env, workspace, existingMeta);
    return { workspace, meta };
  }

  const now = new Date().toISOString();
  const repoId = await deriveRepoId(normalizedRepoUrl);
  const version = 1;
  const revisionId = revisionIdFromVersion(version);

  if (!(await hasRepoSnapshot(workspace))) {
    const githubToken = await getSecret(env, "GITHUB_TOKEN");
    const tarball = repoToTarballUrl(normalizedRepoUrl, "HEAD", githubToken);
    if (!tarball) {
      throw new Error(`Unsupported repo URL: ${normalizedRepoUrl}`);
    }
    await workspace.initFromTarball(tarball.tarballUrl, tarball.headers);
  }

  const meta = buildInitialRepoMeta({
    repoId,
    repoUrl: normalizedRepoUrl,
    version,
    revisionId,
    createdAt: now,
    bootstrappedFromRef: "HEAD",
  });
  const treeHash = await workspace.computeWorkspaceTreeHash({ excludePrefixes: WORKSPACE_TREE_HASH_EXCLUDES });
  const snapshotTar = await workspace.downloadTar({ excludePrefixes: WORKSPACE_TREE_HASH_EXCLUDES });
  const revision: RepoRevisionMeta = {
    id: revisionId,
    repoId,
    version,
    parentRevisionId: null,
    source: "github-bootstrap",
    sourceEnvSlug: null,
    createdAt: now,
    summary: "Bootstrap canonical repo state from GitHub HEAD",
    treeHash,
  };

  await writeRepoRevisionToWorkspace(workspace, revision);
  await writeRepoRevisionSnapshotToWorkspace(workspace, revisionId, snapshotTar);
  await writeRepoMetaToWorkspace(workspace, meta);
  await ensureRepoIndex(env, meta);

  return { workspace, meta };
}

export async function ensureRepoPlanWorkspaceFromRepoUrl(env: Env, repoUrl: string): Promise<WorkspaceDO> {
  const repo = await ensureRepoWorkspaceFromRepoUrl(env, repoUrl);
  return repo.workspace;
}

export async function getRepoWorkspaceForRepoId(
  env: Env,
  repoId: string,
): Promise<{ workspace: WorkspaceDO; meta: RepoMeta } | null> {
  const indexEntry = await readRepoIndexEntry(env, repoId);
  if (!indexEntry) return null;
  return ensureRepoWorkspaceFromRepoUrl(env, indexEntry.repoUrl);
}

export async function getRepoWorkspaceForEnvSlug(
  env: Env,
  slug: string,
): Promise<{ envMeta: EnvMeta; workspace: WorkspaceDO; meta: RepoMeta } | null> {
  const envMeta = await readEnvMeta(env, slug);
  if (!envMeta) return null;
  const repo = await ensureRepoWorkspaceFromRepoUrl(env, envMeta.repoUrl);
  return { envMeta, ...repo };
}

export async function getRepoPlanWorkspaceStub(
  env: Env,
  slug: string,
): Promise<{ meta: EnvMeta; planWorkspace: WorkspaceDO } | null> {
  const repo = await getRepoWorkspaceForEnvSlug(env, slug);
  if (!repo) return null;
  return {
    meta: repo.envMeta,
    planWorkspace: repo.workspace,
  };
}

export async function listRepos(env: Env): Promise<RepoMeta[]> {
  const entries = await listRepoIndexEntries(env);
  const envMetas = await listEnvMetas(env);
  const candidateRepoUrls = new Set<string>();
  for (const entry of entries) {
    candidateRepoUrls.add(entry.repoUrl);
  }
  for (const meta of envMetas) {
    candidateRepoUrls.add(normalizeRepoUrl(meta.repoUrl));
  }

  const repos = (
    await Promise.all(
      Array.from(candidateRepoUrls).map(async (repoUrl) => {
        try {
          const repo = await ensureRepoWorkspaceFromRepoUrl(env, repoUrl);
          return repo.meta;
        } catch (error) {
          console.warn(`[repo-store] Failed to load repo ${repoUrl}:`, error);
          return null;
        }
      }),
    )
  ).filter((repo): repo is RepoMeta => !!repo);

  const deduped = new Map<string, RepoMeta>();
  for (const repo of repos) {
    deduped.set(repo.repoId, repo);
  }
  return Array.from(deduped.values()).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function commitRepoRevision(args: {
  env: Env;
  workspace: WorkspaceDO;
  meta: RepoMeta;
  sourceEnvSlug?: string | null;
  summary: string;
}): Promise<RepoMeta> {
  const currentVersion = getRepoCurrentVersion(args.meta);
  const currentRevisionId = args.meta.currentRevisionId || revisionIdFromVersion(currentVersion);
  const nextVersion = currentVersion + 1;
  const nextRevisionId = revisionIdFromVersion(nextVersion);
  const now = new Date().toISOString();
  const treeHash = await args.workspace.computeWorkspaceTreeHash({ excludePrefixes: WORKSPACE_TREE_HASH_EXCLUDES });
  const snapshotTar = await args.workspace.downloadTar({ excludePrefixes: WORKSPACE_TREE_HASH_EXCLUDES });
  const nextMeta: RepoMeta = {
    ...args.meta,
    currentVersion: nextVersion,
    currentRevisionId: nextRevisionId,
    updatedAt: now,
    lastCommittedFromEnvSlug: args.sourceEnvSlug ?? null,
    lastCommittedAt: args.sourceEnvSlug ? now : args.meta.lastCommittedAt ?? null,
  };
  const revision: RepoRevisionMeta = {
    id: nextRevisionId,
    repoId: args.meta.repoId,
    version: nextVersion,
    parentRevisionId: currentRevisionId,
    source: args.sourceEnvSlug ? "env-commit" : "github-bootstrap",
    sourceEnvSlug: args.sourceEnvSlug ?? null,
    createdAt: now,
    summary: args.summary,
    treeHash,
  };

  await writeRepoRevisionToWorkspace(args.workspace, revision);
  await writeRepoRevisionSnapshotToWorkspace(args.workspace, nextRevisionId, snapshotTar);
  await writeRepoMetaToWorkspace(args.workspace, nextMeta);
  await ensureRepoIndex(args.env, nextMeta);
  return nextMeta;
}
