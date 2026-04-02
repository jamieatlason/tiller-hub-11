// Shared helpers used across env/routes.ts and workspace/routes.ts

import type { Env } from "./types";
import type { SandboxDO } from "./sandbox-do";
import type { WorkspaceDO } from "./workspace/do";

export function getSandboxStub(env: Env, slug: string): SandboxDO {
  const id = env.SANDBOX.idFromName(slug);
  return env.SANDBOX.get(id) as unknown as SandboxDO;
}

export function getWorkspaceStub(env: Env, slug: string): WorkspaceDO {
  const id = env.WORKSPACE.idFromName(slug);
  return env.WORKSPACE.get(id) as unknown as WorkspaceDO;
}

/** Convert a GitHub repo URL to a tarball API URL */
export function repoToTarballUrl(
  repoUrl: string,
  ref = "HEAD",
  githubToken?: string,
): { tarballUrl: string; headers: Record<string, string> } | null {
  const match = repoUrl.replace(/\.git$/, "").match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  const [, owner, repo] = match;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tiller-hub",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  return {
    tarballUrl: `https://api.github.com/repos/${owner}/${repo}/tarball/${ref}`,
    headers,
  };
}
