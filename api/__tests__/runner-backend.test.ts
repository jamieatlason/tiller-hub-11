import { describe, expect, it } from "vitest";
import { resolveRunnerBackendKind } from "../env/runner-backend";

describe("resolveRunnerBackendKind", () => {
  it("prefers an explicit request", () => {
    expect(
      resolveRunnerBackendKind(
        { DEFAULT_RUNNER_BACKEND: "local", USE_CF_CONTAINERS: "true" },
        { requested: "cf" },
      ),
    ).toBe("cf");
  });

  it("falls back to stored backend metadata", () => {
    expect(
      resolveRunnerBackendKind(
        { DEFAULT_RUNNER_BACKEND: "local", USE_CF_CONTAINERS: "true" },
        { stored: "cf" },
      ),
    ).toBe("cf");
  });

  it("uses server defaults before the old USE_CF_CONTAINERS fallback", () => {
    expect(
      resolveRunnerBackendKind(
        { DEFAULT_RUNNER_BACKEND: "local", USE_CF_CONTAINERS: "true" },
      ),
    ).toBe("local");
    expect(
      resolveRunnerBackendKind(
        { DEFAULT_RUNNER_BACKEND: undefined, USE_CF_CONTAINERS: "true" },
      ),
    ).toBe("cf");
  });
});
