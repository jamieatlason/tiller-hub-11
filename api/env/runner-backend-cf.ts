import { getSandboxStub } from "../helpers";
import type { RunnerBackend } from "./runner-backend";
import type { Env, EnvMeta } from "../types";

export function createCloudflareRunnerBackend(env: Env): RunnerBackend {
  return {
    kind: "cf",

    async create(meta: EnvMeta, envVars: Record<string, string>): Promise<EnvMeta> {
      const stub = getSandboxStub(env, meta.slug);
      await stub.startSandbox(envVars);
      const runnerId = meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "cf",
        runnerId,
        flyMachineId: runnerId,
      };
    },

    async getStatus(meta: EnvMeta): Promise<string> {
      if (meta.error) return "failed";
      try {
        const stub = getSandboxStub(env, meta.slug);
        return await stub.getStatus();
      } catch {
        return "unknown";
      }
    },

    async start(meta: EnvMeta, envVars: Record<string, string>): Promise<EnvMeta> {
      const stub = getSandboxStub(env, meta.slug);
      await stub.startSandbox(envVars);
      const runnerId = meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "cf",
        runnerId,
        flyMachineId: runnerId,
      };
    },

    async stop(meta: EnvMeta): Promise<void> {
      const stub = getSandboxStub(env, meta.slug);
      await stub.stopSandbox();
    },

    async destroy(meta: EnvMeta): Promise<void> {
      const stub = getSandboxStub(env, meta.slug);
      await stub.destroySandbox();
    },

    async proxyTerminal(meta: EnvMeta, request: Request, subPath: string): Promise<Response> {
      const stub = getSandboxStub(env, meta.slug);
      const targetUrl = new URL(subPath, request.url);
      const proxyReq = new Request(targetUrl.toString(), request);
      return stub.fetch(proxyReq);
    },
  };
}
