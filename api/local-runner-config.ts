import type { ActiveLocalRunnerConfig, Env } from "./types";

function getHub(env: Env) {
  if (!env.HUB) return null;
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId) as unknown as {
    getActiveLocalRunnerConfig(): ActiveLocalRunnerConfig | null | Promise<ActiveLocalRunnerConfig | null>;
  };
}

export async function readActiveLocalRunnerConfig(env: Env): Promise<ActiveLocalRunnerConfig | null> {
  const hub = getHub(env);
  if (!hub) return null;

  const config = await hub.getActiveLocalRunnerConfig();
  if (!config) return null;

  const runnerUrl = config.runnerUrl?.trim() ?? "";
  const relayUrl = config.relayUrl?.trim() ?? "";
  if (!runnerUrl && !relayUrl) return null;

  return {
    runnerUrl: runnerUrl || null,
    relayUrl: relayUrl || null,
  };
}

export function isQuickTunnelUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}
