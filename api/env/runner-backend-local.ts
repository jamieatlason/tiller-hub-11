import type { RunnerBackend } from "./runner-backend";
import type { Env, EnvMeta } from "../types";
import { getSecret } from "../setup/config";
import { isQuickTunnelUrl, readActiveLocalRunnerConfig } from "../local-runner-config";

interface LocalRunnerStatus {
  runnerId?: string;
  status?: string;
}

async function readRunnerStatus(response: Response): Promise<LocalRunnerStatus> {
  try {
    return await response.json<LocalRunnerStatus>();
  } catch {
    return {};
  }
}

async function requireLocalRunnerConfig(env: Env) {
  const configuredRunnerUrl = await getSecret(env, "LOCAL_RUNNER_URL");
  const runnerToken = await getSecret(env, "LOCAL_RUNNER_TOKEN");
  const cfClientId = await getSecret(env, "CF_ACCESS_CLIENT_ID");
  const cfClientSecret = await getSecret(env, "CF_ACCESS_CLIENT_SECRET");
  const activeConfig = configuredRunnerUrl ? null : await readActiveLocalRunnerConfig(env);
  const runnerUrl = configuredRunnerUrl ?? activeConfig?.runnerUrl ?? null;

  if (!runnerUrl) {
    throw new Error("LOCAL_RUNNER_URL is required for local runner backend");
  }
  if (!isQuickTunnelUrl(runnerUrl) && !runnerToken && (!cfClientId || !cfClientSecret)) {
    throw new Error("LOCAL_RUNNER_TOKEN or Cloudflare Access service token is required for local runner backend");
  }
  return {
    baseUrl: runnerUrl.replace(/\/+$/, ""),
    token: runnerToken ?? null,
    cfClientId: cfClientId ?? null,
    cfClientSecret: cfClientSecret ?? null,
  };
}

function applyCloudflareAccessHeaders(
  headers: Headers,
  config: { cfClientId: string | null; cfClientSecret: string | null },
): void {
  if (!config.cfClientId || !config.cfClientSecret) return;
  headers.set("CF-Access-Client-Id", config.cfClientId);
  headers.set("CF-Access-Client-Secret", config.cfClientSecret);
}

async function parseRunnerError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text ? `${response.status} ${text}` : String(response.status);
}

export async function createLocalRunnerBackend(env: Env): Promise<RunnerBackend> {
  const config = await requireLocalRunnerConfig(env);

  async function request(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (config.token) {
      headers.set("Authorization", `Bearer ${config.token}`);
    }
    applyCloudflareAccessHeaders(headers, config);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers,
    });
  }

  return {
    kind: "local",

    async create(meta: EnvMeta, envVars: Record<string, string>): Promise<EnvMeta> {
      const response = await request("/envs", {
        method: "POST",
        body: JSON.stringify({
          slug: meta.slug,
          repoUrl: meta.repoUrl,
          envVars,
        }),
      });
      if (!response.ok) {
        throw new Error(`Local runner create failed: ${await parseRunnerError(response)}`);
      }

      const result = await readRunnerStatus(response);
      const runnerId = result.runnerId ?? meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "local",
        runnerId,
        flyMachineId: runnerId,
      };
    },

    async getStatus(meta: EnvMeta): Promise<string> {
      const response = await request(`/envs/${encodeURIComponent(meta.slug)}`);
      if (response.status === 404) return "stopped";
      if (!response.ok) {
        throw new Error(`Local runner status failed: ${await parseRunnerError(response)}`);
      }

      const result = await readRunnerStatus(response);
      return result.status ?? "unknown";
    },

    async start(meta: EnvMeta, envVars: Record<string, string>): Promise<EnvMeta> {
      const response = await request(`/envs/${encodeURIComponent(meta.slug)}/start`, {
        method: "POST",
        body: JSON.stringify({
          repoUrl: meta.repoUrl,
          envVars,
        }),
      });
      if (!response.ok) {
        throw new Error(`Local runner start failed: ${await parseRunnerError(response)}`);
      }

      const result = await readRunnerStatus(response);
      const runnerId = result.runnerId ?? meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "local",
        runnerId,
        flyMachineId: runnerId,
      };
    },

    async stop(meta: EnvMeta): Promise<void> {
      const response = await request(`/envs/${encodeURIComponent(meta.slug)}/stop`, {
        method: "POST",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Local runner stop failed: ${await parseRunnerError(response)}`);
      }
    },

    async destroy(meta: EnvMeta): Promise<void> {
      const response = await request(`/envs/${encodeURIComponent(meta.slug)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Local runner destroy failed: ${await parseRunnerError(response)}`);
      }
    },

    async proxyTerminal(meta: EnvMeta, requestInit: Request, subPath: string): Promise<Response> {
      const targetUrl = new URL(`${config.baseUrl}/envs/${encodeURIComponent(meta.slug)}/terminal${subPath}`);
      const headers = new Headers(requestInit.headers);
      if (config.token) {
        headers.set("Authorization", `Bearer ${config.token}`);
      }
      applyCloudflareAccessHeaders(headers, config);
      const proxyReq = new Request(targetUrl.toString(), {
        method: requestInit.method,
        headers,
        body: requestInit.body,
        redirect: "manual",
      });
      return fetch(proxyReq);
    },
  };
}
