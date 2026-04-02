import { describe, expect, it } from "vitest";
import { normalizeRunnerStatus, resolveEnvStatus } from "../env/status";

describe("normalizeRunnerStatus", () => {
  it("maps Docker running to started", () => {
    expect(normalizeRunnerStatus("running")).toBe("started");
  });

  it("maps Docker terminal states to stopped", () => {
    expect(normalizeRunnerStatus("exited")).toBe("stopped");
    expect(normalizeRunnerStatus("dead")).toBe("stopped");
  });

  it("preserves transition-like statuses", () => {
    expect(normalizeRunnerStatus("restarting")).toBe("starting");
    expect(normalizeRunnerStatus("removing")).toBe("deleting");
  });
});

describe("resolveEnvStatus", () => {
  it("keeps stopping until the runtime is actually stopped", () => {
    expect(resolveEnvStatus({ status: "stopping" }, "running")).toBe("stopping");
    expect(resolveEnvStatus({ status: "stopping" }, "exited")).toBe("stopped");
  });

  it("keeps deleting while the row still exists", () => {
    expect(resolveEnvStatus({ status: "deleting" }, "exited")).toBe("deleting");
  });

  it("promotes creating and starting to started when runtime is live", () => {
    expect(resolveEnvStatus({ status: "creating" }, "running")).toBe("started");
    expect(resolveEnvStatus({ status: "starting" }, "running")).toBe("started");
  });
});
