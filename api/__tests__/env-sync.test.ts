import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readTarEntries } from "../workspace/tar";
import { buildTar } from "../workspace/tar";
import type { HonoEnv } from "../types";

const mocks = vi.hoisted(() => ({
  getWorkspaceStub: vi.fn(),
  ensureRepoWorkspaceFromRepoUrl: vi.fn(),
  listEnvMetas: vi.fn(),
  readEnvMeta: vi.fn(),
  readRepoVersionFromWorkspace: vi.fn(),
  readRepoVersionSnapshotFromWorkspace: vi.fn(),
  commitRepoRevision: vi.fn(),
  getRunnerBackend: vi.fn(),
}));

vi.mock("../helpers", () => ({
  getWorkspaceStub: mocks.getWorkspaceStub,
}));

vi.mock("../plan/store", async () => {
  const actual = await vi.importActual<typeof import("../plan/store")>("../plan/store");
  return {
    ...actual,
    ensureRepoWorkspaceFromRepoUrl: mocks.ensureRepoWorkspaceFromRepoUrl,
    listEnvMetas: mocks.listEnvMetas,
    readEnvMeta: mocks.readEnvMeta,
    readRepoVersionFromWorkspace: mocks.readRepoVersionFromWorkspace,
    readRepoVersionSnapshotFromWorkspace: mocks.readRepoVersionSnapshotFromWorkspace,
    commitRepoRevision: mocks.commitRepoRevision,
  };
});

vi.mock("../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

const { default: envRoutes } = await import("../env/routes");

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.use("*", async (_c, next) => {
    await next();
  });
  app.route("/", envRoutes);
  return app;
}

function createEnvBinding(envMeta: Record<string, unknown>, put = vi.fn().mockResolvedValue(undefined)) {
  return {
    DEFAULT_RUNNER_BACKEND: "cf",
    ENVS_KV: {
      get: vi.fn().mockResolvedValue(JSON.stringify(envMeta)),
      put,
    },
    HUB: {
      idFromName: vi.fn().mockReturnValue("hub-id"),
      get: vi.fn().mockReturnValue({
        broadcastEnvStatus: vi.fn(),
        broadcastRepoRevisionChange: vi.fn(),
        addMessage: vi.fn(),
      }),
    },
  };
}

describe("env sync flow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listEnvMetas.mockResolvedValue([]);
    mocks.commitRepoRevision.mockResolvedValue(undefined);
    mocks.getRunnerBackend.mockReturnValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
      create: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      proxyTerminal: vi.fn(),
    });
  });

  it("fast-forwards a clean behind env on commit-back", async () => {
    const envMeta = {
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      flyMachineId: "demo-env",
      createdAt: "2026-03-30T00:00:00.000Z",
      baseRepoVersion: 1,
      baseRepoRevisionId: "r1",
      status: "stopped",
    };
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(envMeta, put);
    const envWorkspace = {
      computeWorkspaceTreeHash: vi.fn().mockResolvedValue("tree-v1"),
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 3 }),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      deleteWorkspaceFile: vi.fn().mockResolvedValue(true),
      batchReadWorkspaceFiles: vi.fn().mockResolvedValue([]),
      readWorkspaceFile: vi.fn().mockResolvedValue(null),
      downloadTar: vi.fn(),
    };
    const repoWorkspace = {
      downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
      readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
    };

    mocks.getWorkspaceStub.mockReturnValue(envWorkspace);
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: repoWorkspace,
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        currentVersion: 2,
        currentRevisionId: "r2",
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.readRepoVersionFromWorkspace.mockImplementation(async (_workspace: unknown, version: number) => {
      if (version === 1) return { treeHash: "tree-v1" };
      if (version === 2) return { treeHash: "tree-v2" };
      return null;
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env/commit-back", { method: "POST" }, env as any);
    const body = await res.json() as { error: string };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      action: "fast-forwarded",
      previousVersion: 2,
      currentVersion: 2,
    });
    expect(envWorkspace.restoreFromTar).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toContain('"syncState":"current"');
    expect(envWorkspace.computeWorkspaceTreeHash).toHaveBeenCalledWith({
      excludePrefixes: ["/.tiller", "/.claude/settings.local.json"],
    });
  });

  it("reconciles a behind dirty env with a clean merge", async () => {
    const envMeta = {
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      flyMachineId: "demo-env",
      createdAt: "2026-03-30T00:00:00.000Z",
      baseRepoVersion: 1,
      baseRepoRevisionId: "r1",
      status: "stopped",
    };
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(envMeta, put);
    const envWorkspace = {
      computeWorkspaceTreeHash: vi.fn().mockResolvedValue("tree-local"),
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 1 }),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      deleteWorkspaceFile: vi.fn().mockResolvedValue(true),
      batchReadWorkspaceFiles: vi.fn().mockResolvedValue([]),
      readWorkspaceFile: vi.fn().mockResolvedValue(null),
      downloadTar: vi.fn(),
    };
    const baseTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("hello\nbase\n") },
    ]);
    const localTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("hello\nlocal\nbase\n") },
    ]);
    const remoteTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("hello\nbase\nremote\n") },
    ]);
    envWorkspace.downloadTar.mockResolvedValue(localTar);

    const repoWorkspace = {
      downloadTar: vi.fn().mockResolvedValue(remoteTar),
      listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
      readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
    };

    mocks.getWorkspaceStub.mockReturnValue(envWorkspace);
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: repoWorkspace,
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        currentVersion: 2,
        currentRevisionId: "r2",
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.readRepoVersionFromWorkspace.mockImplementation(async (_workspace: unknown, version: number) => {
      if (version === 1) return { treeHash: "tree-v1" };
      if (version === 2) return { treeHash: "tree-v2" };
      return null;
    });
    mocks.readRepoVersionSnapshotFromWorkspace.mockResolvedValue(baseTar);

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env/reconcile", { method: "POST" }, env as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      action: "merged",
      conflictCount: 0,
      currentVersion: 2,
    });
    expect(envWorkspace.restoreFromTar).toHaveBeenCalledTimes(1);
    const restoredTar = envWorkspace.restoreFromTar.mock.calls[0][0] as Uint8Array;
    const restoredReadme = new TextDecoder().decode(readTarEntries(restoredTar).get("/README.md")!);
    expect(restoredReadme).toBe("hello\nlocal\nbase\nremote\n");
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toContain('"syncState":"current"');
    expect(put.mock.calls[0][1]).toContain('"workspaceDirty":true');
    expect(envWorkspace.deleteWorkspaceFile).toHaveBeenCalled();
    expect(envWorkspace.downloadTar).toHaveBeenCalledWith({
      excludePrefixes: ["/.tiller", "/.claude/settings.local.json"],
    });
  });

  it("marks the env conflicted when reconcile hits overlapping text changes", async () => {
    const envMeta = {
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      flyMachineId: "demo-env",
      createdAt: "2026-03-30T00:00:00.000Z",
      baseRepoVersion: 1,
      baseRepoRevisionId: "r1",
      status: "stopped",
    };
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(envMeta, put);
    const envWorkspace = {
      computeWorkspaceTreeHash: vi.fn().mockResolvedValue("tree-local"),
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 1 }),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      deleteWorkspaceFile: vi.fn().mockResolvedValue(true),
      batchReadWorkspaceFiles: vi.fn().mockResolvedValue([]),
      readWorkspaceFile: vi.fn().mockResolvedValue(null),
      downloadTar: vi.fn(),
    };
    const baseTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("hello\nbase\n") },
    ]);
    const localTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("hello\nlocal\n") },
    ]);
    const remoteTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("hello\nremote\n") },
    ]);
    envWorkspace.downloadTar.mockResolvedValue(localTar);

    const repoWorkspace = {
      downloadTar: vi.fn().mockResolvedValue(remoteTar),
      listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
      readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
    };

    mocks.getWorkspaceStub.mockReturnValue(envWorkspace);
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: repoWorkspace,
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        currentVersion: 2,
        currentRevisionId: "r2",
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.readRepoVersionFromWorkspace.mockImplementation(async (_workspace: unknown, version: number) => {
      if (version === 1) return { treeHash: "tree-v1" };
      if (version === 2) return { treeHash: "tree-v2" };
      return null;
    });
    mocks.readRepoVersionSnapshotFromWorkspace.mockResolvedValue(baseTar);

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env/commit-back", { method: "POST" }, env as any);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("Merge found 1 conflict");
    expect(envWorkspace.restoreFromTar).toHaveBeenCalledTimes(1);
    const restoredTar = envWorkspace.restoreFromTar.mock.calls[0][0] as Uint8Array;
    const restoredReadme = new TextDecoder().decode(readTarEntries(restoredTar).get("/README.md")!);
    expect(restoredReadme).toContain("<<<<<<< env demo-env");
    expect(restoredReadme).toContain(">>>>>>> repo v2");
    expect(envWorkspace.writeWorkspaceFile).toHaveBeenCalledWith(
      "/.tiller/reconcile.json",
      expect.stringContaining("\"conflictPaths\""),
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toContain('"syncState":"conflicted"');
  });
});
