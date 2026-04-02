import type { Env, ClaudeAuthMode, ResolvedClaudeAuthMode } from "../types";
import { getSecret } from "../setup/config";

export interface ResolvedContainerAuth {
  authMode: ClaudeAuthMode;
  resolvedAuthMode: ResolvedClaudeAuthMode;
  authWarning?: string;
  envVars: Record<string, string>;
}

export function resolveClaudeAuthMode(options?: {
  requested?: string | null;
  stored?: string | null;
}): ClaudeAuthMode {
  if (options?.requested === "auto" || options?.requested === "subscription" || options?.requested === "api") {
    return options.requested;
  }

  if (options?.stored === "auto" || options?.stored === "subscription" || options?.stored === "api") {
    return options.stored;
  }

  return "auto";
}

export async function resolveContainerAuth(
  env: Env,
  options?: { requested?: string | null; stored?: string | null },
): Promise<ResolvedContainerAuth> {
  const authMode = resolveClaudeAuthMode(options);
  const oauthToken = await getSecret(env, "CLAUDE_CODE_OAUTH_TOKEN");
  const apiKey = await getSecret(env, "ANTHROPIC_API_KEY");

  if (authMode === "subscription") {
    if (!oauthToken) {
      throw new Error("Claude subscription auth requested, but CLAUDE_CODE_OAUTH_TOKEN is not configured");
    }
    return {
      authMode,
      resolvedAuthMode: "subscription",
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
    };
  }

  if (authMode === "api") {
    if (!apiKey) {
      throw new Error("Anthropic API auth requested, but ANTHROPIC_API_KEY is not configured");
    }
    return {
      authMode,
      resolvedAuthMode: "api",
      envVars: { ANTHROPIC_API_KEY: apiKey },
    };
  }

  if (oauthToken) {
    return {
      authMode,
      resolvedAuthMode: "subscription",
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
    };
  }

  if (apiKey) {
    return {
      authMode,
      resolvedAuthMode: "api",
      authWarning: "Using Anthropic API key fallback because the Claude subscription token is unavailable",
      envVars: { ANTHROPIC_API_KEY: apiKey },
    };
  }

  throw new Error("No auth configured for container: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY as a Wrangler secret");
}
