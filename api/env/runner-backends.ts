import { createCloudflareRunnerBackend } from "./runner-backend-cf";
import { createLocalRunnerBackend } from "./runner-backend-local";
import type { RunnerBackend, RunnerBackendKind } from "./runner-backend";
import type { Env } from "../types";

export async function getRunnerBackend(env: Env, kind: RunnerBackendKind): Promise<RunnerBackend> {
  switch (kind) {
    case "cf":
      return createCloudflareRunnerBackend(env);
    case "local":
      return await createLocalRunnerBackend(env);
  }
}
