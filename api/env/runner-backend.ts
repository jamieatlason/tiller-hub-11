import type { Env, EnvMeta } from "../types";

export type RunnerBackendKind = "cf" | "local";

export interface RunnerBackend {
  kind: RunnerBackendKind;
  create(meta: EnvMeta, envVars: Record<string, string>): Promise<EnvMeta>;
  getStatus(meta: EnvMeta): Promise<string>;
  start(meta: EnvMeta, envVars: Record<string, string>): Promise<EnvMeta>;
  stop(meta: EnvMeta): Promise<void>;
  destroy(meta: EnvMeta): Promise<void>;
  proxyTerminal(meta: EnvMeta, request: Request, subPath: string): Promise<Response>;
}

export function resolveRunnerBackendKind(
  env: Pick<Env, "DEFAULT_RUNNER_BACKEND" | "USE_CF_CONTAINERS">,
  options?: { requested?: string | null; stored?: string | null },
): RunnerBackendKind {
  if (options?.requested === "cf" || options?.requested === "local") {
    return options.requested;
  }

  if (options?.stored === "cf" || options?.stored === "local") {
    return options.stored;
  }

  if (env.DEFAULT_RUNNER_BACKEND === "cf" || env.DEFAULT_RUNNER_BACKEND === "local") {
    return env.DEFAULT_RUNNER_BACKEND;
  }

  return env.USE_CF_CONTAINERS === "true" ? "cf" : "local";
}
