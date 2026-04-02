# Codex Relay via Cloudflare Tunnel

Use this when `tiller-hub` is deployed on Cloudflare Workers but Codex requests need to egress from your local machine.

## 1. Start the local relay

Generate a shared secret:

```bash
openssl rand -hex 32
```

Start the relay on your machine:

```bash
cd <project-root>
RESEARCH_RELAY_TOKEN=<secret> npm run relay --workspace packages/tiller-hub
```

The relay listens on `http://127.0.0.1:8788` and proxies `POST /responses` to `https://chatgpt.com/backend-api/codex/responses`.

Health check:

```bash
curl http://127.0.0.1:8788/healthz
```

## 2. Expose it with Cloudflare Tunnel

Quick test:

```bash
cloudflared tunnel --url http://127.0.0.1:8788
```

That prints a temporary `https://<random>.trycloudflare.com` URL. Use:

```text
https://<random>.trycloudflare.com/responses
```

as `RESEARCH_RELAY_URL`.

## 3. Configure tiller-hub

Set these on the deployed worker:

```bash
cd <project-root>/packages/tiller-hub
printf '%s' 'https://<random>.trycloudflare.com/responses' | npx wrangler secret put RESEARCH_RELAY_URL
printf '%s' '<secret>' | npx wrangler secret put RESEARCH_RELAY_TOKEN
```

Then redeploy:

```bash
cd <project-root>
npm run deploy --workspace packages/tiller-hub
```

## 4. Notes

- `tiller-hub` still manages ChatGPT token refresh in Workers.
- The relay only changes network egress. It does not run tools or store history.
- The worker sends the ChatGPT access token to the relay over HTTPS, protected by `RESEARCH_RELAY_TOKEN`.
- For a stable long-lived setup, use a named Cloudflare Tunnel instead of `trycloudflare`.
