import { Hono } from "hono";
import type { HonoEnv, Env } from "../types";
import { loadConfig, invalidateConfigCache } from "./config";

// Keys that can be managed via the settings page.
const CONFIGURABLE_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CF_ACCESS_AUD",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "HUB_PUBLIC_URL",
  "RESEARCH_RELAY_URL",
  "RESEARCH_RELAY_TOKEN",
  "LOCAL_RUNNER_URL",
  "LOCAL_RUNNER_TOKEN",
] as const);

type ConfigurableKey = typeof CONFIGURABLE_KEYS extends Set<infer T> ? T : never;

function getHub(env: Env) {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id) as unknown as {
    setConfig(key: string, value: string): void;
  };
}

async function keyStatus(
  env: Env,
): Promise<Record<ConfigurableKey, "configured" | "missing">> {
  const config = await loadConfig(env);
  const result = {} as Record<ConfigurableKey, "configured" | "missing">;
  for (const key of CONFIGURABLE_KEYS) {
    const hasEnv = !!(env as unknown as Record<string, unknown>)[key];
    const hasConfig = !!config[key];
    result[key] = hasEnv || hasConfig ? "configured" : "missing";
  }
  return result;
}

// ── Routes ─────────────────────────────────────────────────────────

const setupRoutes = new Hono<HonoEnv>();

setupRoutes.get("/api/setup/status", async (c) => {
  const keys = await keyStatus(c.env);
  const needsSetup = keys.ANTHROPIC_API_KEY === "missing";
  return c.json({ needsSetup, keys });
});

setupRoutes.post("/api/setup", async (c) => {
  const body = await c.req.json<{ secrets?: Record<string, string> }>();
  if (!body.secrets || typeof body.secrets !== "object") {
    return c.json({ error: "Request body must contain a `secrets` object" }, 400);
  }

  const entries = Object.entries(body.secrets).filter(
    ([, v]) => typeof v === "string" && v.length > 0,
  );
  const invalid = entries.filter(([k]) => !CONFIGURABLE_KEYS.has(k as ConfigurableKey));
  if (invalid.length > 0) {
    return c.json(
      { error: `Invalid keys: ${invalid.map(([k]) => k).join(", ")}` },
      400,
    );
  }

  if (entries.length === 0) {
    return c.json({ error: "No valid secrets provided" }, 400);
  }

  const hub = getHub(c.env);
  for (const [key, value] of entries) {
    await hub.setConfig(key, value);
  }

  invalidateConfigCache();
  return c.json({ ok: true, saved: entries.map(([k]) => k) });
});

export default setupRoutes;
