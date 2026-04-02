import type { EnvMeta } from "../types";

export function normalizeRunnerStatus(status?: string): string {
  switch (status) {
    case "running":
    case "started":
    case "healthy":
    case "paused":
      return "started";
    case "created":
      return "creating";
    case "restarting":
      return "starting";
    case "removing":
      return "deleting";
    case "exited":
    case "dead":
    case "stopped":
      return "stopped";
    default:
      return status ?? "unknown";
  }
}

export function resolveEnvStatus(meta: Pick<EnvMeta, "status">, liveStatus?: string): string {
  const normalizedLive = normalizeRunnerStatus(liveStatus);

  switch (meta.status) {
    case "creating":
      return normalizedLive === "started" ? "started" : "creating";
    case "starting":
      return normalizedLive === "started" ? "started" : "starting";
    case "stopping":
      return normalizedLive === "stopped" ? "stopped" : "stopping";
    case "deleting":
      return "deleting";
    case "failed":
      return "failed";
    default:
      return normalizedLive;
  }
}
