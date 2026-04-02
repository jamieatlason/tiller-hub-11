import { describe, expect, it, vi } from "vitest";
import {
  buildCodexRequestConfig,
  CODEX_RESPONSES_URL,
} from "../codex";
import type { Env } from "../../types";

vi.mock("../../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => {
    return env[key] || undefined;
  },
}));

function mockEnv(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

describe("buildCodexRequestConfig", () => {
  it("builds a direct Codex request when no relay is configured", async () => {
    const request = await buildCodexRequestConfig(
      mockEnv({}),
      "access_token",
      "acct_123",
      "session_1",
      JSON.stringify({ hello: "world" }),
    );

    expect(request.url).toBe(CODEX_RESPONSES_URL);
    expect(request.headers.get("Authorization")).toBe("Bearer access_token");
    expect(request.headers.get("ChatGPT-Account-Id")).toBe("acct_123");
    expect(request.headers.get("session_id")).toBe("session_1");
  });

  it("builds a relay request when relay env vars are configured", async () => {
    const request = await buildCodexRequestConfig(
      mockEnv({
        RESEARCH_RELAY_URL: "https://relay.example.com/responses",
        RESEARCH_RELAY_TOKEN: "relay_secret",
      }),
      "access_token",
      "acct_123",
      "session_1",
      JSON.stringify({ hello: "world" }),
    );

    expect(request.url).toBe("https://relay.example.com/responses");
    expect(request.headers.get("Authorization")).toBe("Bearer relay_secret");
    expect(request.headers.get("X-OpenAI-Access-Token")).toBe("access_token");
    expect(request.headers.get("X-ChatGPT-Account-Id")).toBe("acct_123");
    expect(request.headers.get("X-Session-Id")).toBe("session_1");
  });

  it("supports relay mode without a relay token when other auth is used", async () => {
    const request = await buildCodexRequestConfig(
      mockEnv({
        RESEARCH_RELAY_URL: "https://relay.example.com/responses",
        CF_ACCESS_CLIENT_ID: "access-id",
        CF_ACCESS_CLIENT_SECRET: "access-secret",
      }),
      "access_token",
      null,
      "session_1",
      JSON.stringify({ hello: "world" }),
    );

    expect(request.headers.get("Authorization")).toBeNull();
    expect(request.headers.get("CF-Access-Client-Id")).toBe("access-id");
    expect(request.headers.get("CF-Access-Client-Secret")).toBe("access-secret");
  });
});
