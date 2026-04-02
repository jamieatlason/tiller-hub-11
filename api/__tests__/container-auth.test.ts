import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveClaudeAuthMode, resolveContainerAuth } from "../env/container-auth";
import type { Env } from "../types";

// Mock the config module so getSecret falls through to env values
// (no DO available in unit tests)
vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => {
    return env[key] || undefined;
  },
}));

function mockEnv(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

describe("resolveClaudeAuthMode", () => {
  it("defaults to auto", () => {
    expect(resolveClaudeAuthMode()).toBe("auto");
  });

  it("prefers explicit request", () => {
    expect(resolveClaudeAuthMode({ requested: "subscription", stored: "api" })).toBe("subscription");
  });

  it("falls back to stored mode", () => {
    expect(resolveClaudeAuthMode({ stored: "api" })).toBe("api");
  });
});

describe("resolveContainerAuth", () => {
  it("uses subscription token in auto mode when available", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
    );

    expect(result.authMode).toBe("auto");
    expect(result.resolvedAuthMode).toBe("subscription");
    expect(result.envVars).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
    expect(result.authWarning).toBeUndefined();
  });

  it("falls back to api key in auto mode with warning", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ ANTHROPIC_API_KEY: "api-key" }),
    );

    expect(result.authMode).toBe("auto");
    expect(result.resolvedAuthMode).toBe("api");
    expect(result.envVars).toEqual({ ANTHROPIC_API_KEY: "api-key" });
    expect(result.authWarning).toContain("fallback");
  });

  it("requires oauth token in subscription mode", async () => {
    await expect(
      resolveContainerAuth(
        mockEnv({ ANTHROPIC_API_KEY: "api-key" }),
        { requested: "subscription" },
      ),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("requires api key in api mode", async () => {
    await expect(
      resolveContainerAuth(
        mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
        { requested: "api" },
      ),
    ).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  it("uses only api key in explicit api mode", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
      { requested: "api" },
    );

    expect(result.authMode).toBe("api");
    expect(result.resolvedAuthMode).toBe("api");
    expect(result.envVars).toEqual({ ANTHROPIC_API_KEY: "api-key" });
  });
});
