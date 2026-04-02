import { describe, it, expect } from "vitest";
import { applyEnvStatusChange, mergeEnvsPreservingBootMessages } from "../env-state";
import type { EnvMeta } from "../../api/types";

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "test-env",
    repoUrl: "https://github.com/user/repo",
    flyMachineId: "machine-123",
    createdAt: "2024-01-01T00:00:00Z",
    status: "started",
    ...overrides,
  };
}

describe("applyEnvStatusChange", () => {
  it("with message: sets bootMessage without changing status", () => {
    const envs = [makeEnv({ status: "started" })];
    const result = applyEnvStatusChange(envs, "test-env", "starting", "Syncing workspace...");

    expect(result[0].bootMessage).toBe("Syncing workspace...");
    expect(result[0].status).toBe("started"); // must NOT change to "starting"
  });

  it("without message: updates status, preserves bootMessage", () => {
    const envs = [makeEnv({ status: "starting", bootMessage: "Syncing workspace..." })];
    const result = applyEnvStatusChange(envs, "test-env", "started");

    expect(result[0].status).toBe("started");
    expect(result[0].bootMessage).toBe("Syncing workspace...");
  });

  it("terminal status stopped: clears bootMessage", () => {
    const envs = [makeEnv({ status: "started", bootMessage: "Starting Claude Code..." })];
    const result = applyEnvStatusChange(envs, "test-env", "stopped");

    expect(result[0].status).toBe("stopped");
    expect(result[0].bootMessage).toBeUndefined();
  });

  it("terminal status destroyed: clears bootMessage", () => {
    const envs = [makeEnv({ bootMessage: "Starting..." })];
    const result = applyEnvStatusChange(envs, "test-env", "destroyed");

    expect(result[0].bootMessage).toBeUndefined();
  });

  it("terminal status failed: clears bootMessage", () => {
    const envs = [makeEnv({ bootMessage: "Starting..." })];
    const result = applyEnvStatusChange(envs, "test-env", "failed");

    expect(result[0].bootMessage).toBeUndefined();
  });

  it("non-matching slug: env unchanged", () => {
    const envs = [makeEnv({ status: "started", bootMessage: "Starting..." })];
    const result = applyEnvStatusChange(envs, "other-env", "stopped", "Shutting down...");

    expect(result[0]).toEqual(envs[0]);
  });

  it("multiple envs: only matching slug is updated", () => {
    const envs = [
      makeEnv({ slug: "env-a", status: "started" }),
      makeEnv({ slug: "env-b", status: "stopped" }),
    ];
    const result = applyEnvStatusChange(envs, "env-a", "starting", "Booting...");

    expect(result[0].bootMessage).toBe("Booting...");
    expect(result[0].status).toBe("started"); // unchanged
    expect(result[1]).toEqual(envs[1]); // untouched
  });
});

describe("mergeEnvsPreservingBootMessages", () => {
  it("preserves bootMessage from previous state", () => {
    const prev = [makeEnv({ bootMessage: "Syncing workspace..." })];
    const fresh = [makeEnv()]; // REST API doesn't return bootMessage
    const result = mergeEnvsPreservingBootMessages(fresh, prev);

    expect(result[0].bootMessage).toBe("Syncing workspace...");
  });

  it("new env without prior bootMessage gets undefined", () => {
    const prev: EnvMeta[] = [];
    const fresh = [makeEnv()];
    const result = mergeEnvsPreservingBootMessages(fresh, prev);

    expect(result[0].bootMessage).toBeUndefined();
  });

  it("updates env data while keeping bootMessage", () => {
    const prev = [makeEnv({ status: "starting", bootMessage: "Restoring config..." })];
    const fresh = [makeEnv({ status: "started" })]; // REST now shows started
    const result = mergeEnvsPreservingBootMessages(fresh, prev);

    expect(result[0].status).toBe("started"); // updated from REST
    expect(result[0].bootMessage).toBe("Restoring config..."); // preserved
  });

  it("handles env removed from REST but present in prev", () => {
    const prev = [
      makeEnv({ slug: "env-a", bootMessage: "Booting..." }),
      makeEnv({ slug: "env-b", bootMessage: "Starting..." }),
    ];
    const fresh = [makeEnv({ slug: "env-a" })]; // env-b no longer returned
    const result = mergeEnvsPreservingBootMessages(fresh, prev);

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("env-a");
    expect(result[0].bootMessage).toBe("Booting...");
  });
});
