import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { HonoEnv } from "../types";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => {
    return env[key] || undefined;
  },
}));

import envRoutes, { resolveHubPublicUrl } from "../env/routes";

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.use("*", async (_c, next) => {
    await next();
  });
  app.route("/", envRoutes);
  return app;
}

const ENV_META = JSON.stringify({
  slug: "my-env",
  repoUrl: "https://github.com/test/repo",
  flyMachineId: "m-123",
  createdAt: "2024-01-01",
});

describe("POST /api/envs/:slug/boot-progress", () => {
  it("returns 404 for unknown slug", async () => {
    const env = {
      ENVS_KV: { get: vi.fn().mockResolvedValue(null) },
      HUB: { idFromName: vi.fn(), get: vi.fn() },
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/unknown/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      },
      env as any,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when message is missing", async () => {
    const env = {
      ENVS_KV: { get: vi.fn().mockResolvedValue(ENV_META) },
      HUB: { idFromName: vi.fn(), get: vi.fn() },
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env as any,
    );
    expect(res.status).toBe(400);
  });

  it("broadcasts boot message and returns 200", async () => {
    const mockBroadcast = vi.fn().mockResolvedValue(undefined);
    const mockPut = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(ENV_META),
        put: mockPut,
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({ broadcastEnvStatus: mockBroadcast }),
      },
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Syncing workspace..." }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith("my-env", "starting", "Syncing workspace...");
  });

  it("awaits broadcastEnvStatus before responding", async () => {
    // If the await is removed, broadcastCompleted will be false when the response arrives
    let broadcastCompleted = false;
    const mockBroadcast = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            broadcastCompleted = true;
            resolve();
          }, 50);
        }),
    );
    const mockPut = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(ENV_META),
        put: mockPut,
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({ broadcastEnvStatus: mockBroadcast }),
      },
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Starting services..." }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(broadcastCompleted).toBe(true);
  });
});

describe("resolveHubPublicUrl", () => {
  it("uses HUB_PUBLIC_URL when configured", async () => {
    expect(
      await resolveHubPublicUrl(
        { HUB_PUBLIC_URL: "https://tiller.example.com/" } as any,
        "https://ignored.example.net/api/envs",
      ),
    ).toBe("https://tiller.example.com");
  });

  it("falls back to the request origin", async () => {
    expect(
      await resolveHubPublicUrl(
        { HUB_PUBLIC_URL: undefined } as any,
        "https://tiller-preview.example.net/api/envs/demo/start",
      ),
    ).toBe("https://tiller-preview.example.net");
  });
});
