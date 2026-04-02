import { decodeJwt } from "jose";
import { createMiddleware } from "hono/factory";
import type { HonoEnv, Env } from "./types";
import { getSecret } from "./setup/config";

/**
 * Verify the CF Access JWT assertion.
 *
 * CF Access fully verifies the JWT (signature, expiry, audience) at the edge
 * BEFORE the request reaches this Worker. Re-verifying the signature here
 * requires an outbound HTTPS fetch to the JWKS endpoint, which takes up to
 * 30 seconds on a cold Worker isolate and is the root cause of slow WS connects.
 *
 * Instead: decode the token without signature verification (just parse the
 * base64 payload) and check the audience claim. The edge guarantee makes the
 * signature re-check redundant for Workers sitting entirely behind CF Access.
 */
export async function verifyCfAccessJwt(request: Request, env: Env): Promise<void> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Missing Cf-Access-Jwt-Assertion");

  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(token);
  } catch {
    throw new Error("Malformed JWT");
  }

  const aud = claims.aud;
  const cfAccessAud = await getSecret(env, "CF_ACCESS_AUD");
  if (!cfAccessAud) throw new Error("CF_ACCESS_AUD not configured");
  const valid = Array.isArray(aud)
    ? aud.includes(cfAccessAud)
    : aud === cfAccessAud;
  if (!valid) throw new Error("Invalid audience");
}

/**
 * Hono middleware — verifies CF Access JWT.
 * Skips /health and WebSocket upgrades (WS auth happens in onConnect).
 * Auto-detect dev: if no JWT header present, skip auth (local wrangler dev).
 */
export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  if (c.req.path === "/health") return next();
  if (c.req.path === "/api/setup/status") return next();

  // Setup routes are open when ANTHROPIC_API_KEY is not yet configured (checks DO config too)
  if (c.req.path.startsWith("/api/setup")) {
    const apiKey = await getSecret(c.env, "ANTHROPIC_API_KEY");
    if (!apiKey) return next();
  }

  if (c.req.header("upgrade")?.toLowerCase() === "websocket") return next();

  // No JWT header = local dev (wrangler dev without CF Access)
  if (!c.req.header("Cf-Access-Jwt-Assertion")) {
    return next();
  }

  try {
    await verifyCfAccessJwt(c.req.raw, c.env);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});
