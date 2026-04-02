import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT ?? 8788);
const RELAY_TOKEN = process.env.RESEARCH_RELAY_TOKEN;
const UPSTREAM_URL = process.env.RESEARCH_RELAY_UPSTREAM_URL ?? "https://chatgpt.com/backend-api/codex/responses";

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function getHeader(req, name) {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function pipeUpstream(res, upstream) {
  const headers = {
    "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "Cache-Control": "no-store",
  };

  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || req.url !== "/responses") {
    json(res, 404, { error: "Not found" });
    return;
  }

  if (RELAY_TOKEN && getHeader(req, "authorization") !== `Bearer ${RELAY_TOKEN}`) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  const accessToken = getHeader(req, "x-openai-access-token");
  if (!accessToken) {
    json(res, 400, { error: "Missing X-OpenAI-Access-Token header" });
    return;
  }

  const accountId = getHeader(req, "x-chatgpt-account-id");
  const originator = getHeader(req, "x-originator") ?? "opencode";
  const userAgent = getHeader(req, "x-user-agent") ?? "opencode/tiller-hub";
  const sessionId = getHeader(req, "x-session-id") ?? randomUUID();
  const body = await readRequestBody(req);

  try {
    const upstreamHeaders = new Headers({
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": getHeader(req, "content-type") ?? "application/json",
      originator,
      "User-Agent": userAgent,
      session_id: sessionId,
    });

    if (accountId) {
      upstreamHeaders.set("ChatGPT-Account-Id", accountId);
    }

    const upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: upstreamHeaders,
      body,
    });

    pipeUpstream(res, upstream);
  } catch (error) {
    json(res, 502, {
      error: error instanceof Error ? error.message : "Relay request failed",
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[tiller-hub relay] listening on http://127.0.0.1:${PORT}`);
  console.log(`[tiller-hub relay] forwarding to ${UPSTREAM_URL}`);
  if (!RELAY_TOKEN) {
    console.log("[tiller-hub relay] RESEARCH_RELAY_TOKEN not set; relying on localhost binding and Cloudflare Access");
  }
});
