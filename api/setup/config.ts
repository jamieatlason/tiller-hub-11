import type { Env } from "../types";

// ── Per-isolate cache ──────────────────────────────────────────────

let cached: { config: Record<string, string>; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function invalidateConfigCache(): void {
  cached = null;
}

/**
 * Load all config key/value pairs from HubDO.
 * Cached per-isolate with a 60-second TTL to avoid hitting the DO on every request.
 */
export async function loadConfig(env: Env): Promise<Record<string, string>> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.config;
  const id = env.HUB.idFromName("hub");
  const hub = env.HUB.get(id) as unknown as { getAllConfig(): Record<string, string> };
  const config = await hub.getAllConfig();
  cached = { config, ts: Date.now() };
  return config;
}

/**
 * Resolve a secret by checking wrangler env first, then falling back to DO config.
 * Wrangler secrets always take precedence.
 */
export async function getSecret(env: Env, key: string): Promise<string | undefined> {
  const envVal = (env as unknown as Record<string, unknown>)[key];
  if (envVal) return envVal as string;
  const config = await loadConfig(env);
  return config[key] || undefined;
}
