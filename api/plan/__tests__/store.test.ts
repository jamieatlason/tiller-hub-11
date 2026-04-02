import { describe, expect, it, vi } from "vitest";
import {
  getEnvBaseRepoVersion,
  getRepoCurrentVersion,
  listEnvMetas,
  readEnvMeta,
  revisionIdFromVersion,
  versionFromRevisionId,
} from "../store";

describe("repo store env metadata helpers", () => {
  it("converts between numeric versions and revision ids", () => {
    expect(versionFromRevisionId("r7")).toBe(7);
    expect(versionFromRevisionId("not-a-revision")).toBeNull();
    expect(revisionIdFromVersion(12)).toBe("r12");
  });

  it("prefers explicit numeric repo/env versions when present", () => {
    expect(
      getRepoCurrentVersion({
        currentVersion: 5,
        currentRevisionId: "r4",
      }),
    ).toBe(5);
    expect(
      getEnvBaseRepoVersion({
        baseRepoVersion: 3,
        baseRepoRevisionId: "r2",
      }),
    ).toBe(3);
  });

  it("falls back to legacy revision ids when numeric versions are missing", () => {
    expect(
      getRepoCurrentVersion({
        currentVersion: undefined as never,
        currentRevisionId: "r4",
      }),
    ).toBe(4);
    expect(
      getEnvBaseRepoVersion({
        baseRepoVersion: undefined,
        baseRepoRevisionId: "r2",
      }),
    ).toBe(2);
  });

  it("ignores repo index entries when reading env metadata", async () => {
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            repoId: "repo-123",
            repoUrl: "https://github.com/paperwing-dev/example",
            updatedAt: "2026-03-30T00:00:00.000Z",
          }),
        ),
      },
    } as any;

    await expect(readEnvMeta(env, "repo:repo-123")).resolves.toBeNull();
  });

  it("lists only valid env entries when repo index keys share the same backing namespace", async () => {
    const env = {
      ENVS_KV: {
        list: vi.fn().mockResolvedValue({
          keys: [
            {
              name: "env-1",
            },
            {
              name: "repo:repo-123",
            },
          ],
        }),
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === "repo:repo-123") {
            return JSON.stringify({
              repoId: "repo-123",
              repoUrl: "https://github.com/paperwing-dev/example",
              updatedAt: "2026-03-30T00:00:00.000Z",
            });
          }
          return JSON.stringify({
            slug: "env-1",
            repoUrl: "https://github.com/paperwing-dev/example",
            flyMachineId: "env-1",
            createdAt: "2026-03-30T00:00:00.000Z",
          });
        }),
      },
    } as any;

    await expect(listEnvMetas(env)).resolves.toEqual([
      {
        slug: "env-1",
        repoUrl: "https://github.com/paperwing-dev/example",
        flyMachineId: "env-1",
        createdAt: "2026-03-30T00:00:00.000Z",
      },
    ]);
  });

  it("re-reads KV values instead of trusting stale list metadata", async () => {
    const env = {
      ENVS_KV: {
        list: vi.fn().mockResolvedValue({
          keys: [
            {
              name: "env-1",
              metadata: {
                slug: "env-1",
                repoUrl: "https://github.com/paperwing-dev/example",
                flyMachineId: "env-1",
                createdAt: "2026-03-30T00:00:00.000Z",
                baseRepoRevisionId: "r1",
              },
            },
          ],
        }),
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            slug: "env-1",
            repoUrl: "https://github.com/paperwing-dev/example",
            flyMachineId: "env-1",
            createdAt: "2026-03-30T00:00:00.000Z",
            baseRepoRevisionId: "r2",
          }),
        ),
      },
    } as any;

    await expect(listEnvMetas(env)).resolves.toEqual([
      {
        slug: "env-1",
        repoUrl: "https://github.com/paperwing-dev/example",
        flyMachineId: "env-1",
        createdAt: "2026-03-30T00:00:00.000Z",
        baseRepoRevisionId: "r2",
      },
    ]);
  });
});
