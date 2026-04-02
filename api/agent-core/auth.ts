import type { Env } from "../types";
import { getValidOpenAIAuth } from "../openai-auth";
import type { AgentSpec } from "./types";

export interface ResolvedAgentAuth {
  accessToken: string | null;
  accountId: string | null;
}

export async function resolveAgentAuth(env: Env, spec: AgentSpec): Promise<ResolvedAgentAuth> {
  switch (spec.modelTarget.provider) {
    case "external-codex": {
      const auth = await getValidOpenAIAuth(env);
      return {
        accessToken: auth.access_token,
        accountId: auth.account_id ?? null,
      };
    }
    case "workers-ai":
      return {
        accessToken: null,
        accountId: null,
      };
  }

  const unexpectedProvider: never = spec.modelTarget.provider;
  throw new Error(`Unsupported auth provider: ${unexpectedProvider}`);
}
