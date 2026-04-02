# Runner Backends

`tiller-hub` now separates hosted workspace state from execution backend. That lets
the same hub target either Cloudflare Containers or a local Docker runner
without changing the UI, `tiller-cli`, or `tiller`.

## Why this exists

The original design coupled workspace state, Research chat, and container
lifecycle into one Cloudflare Container-backed Durable Object. That worked for
Cloudflare-hosted execution, but it made two things awkward:

- `Research` was tied to the Cloudflare container path even though it does not
  need a running container.
- Subscription-backed AI products may accept residential egress and challenge
  datacenter egress. A local runner gives better egress without moving the hub
  off Cloudflare.

The current split keeps the control plane hosted while making execution
pluggable.

## Current architecture

- `HubDO`
  - Session state, WebSocket fanout, replay, permissions, terminal attach state.
- `WorkspaceDO`
  - Workspace files, tar sync, Research chat, chat history.
- Runner backend
  - `cf`: Cloudflare Containers via `SandboxDO`.
  - `local`: Docker on a home server via `tiller serve-runner`.
- Container
  - Runs the existing `tiller-hub/container` boot flow.
  - Syncs against hosted workspace APIs.
  - Starts `tiller-cli`, which connects back to the hosted hub.

## Backend matrix

| Backend | Executes where | Good for | Notes |
| --- | --- | --- | --- |
| `cf` | Cloudflare Containers | Fully hosted execution | Uses `SandboxDO` for lifecycle and terminal proxy |
| `local` | Docker on your machine or home server | Better outbound egress, personal subscriptions, cheaper compute | Requires `tiller serve-runner` + `cloudflared` |

## Request flow

### Local backend

1. The UI creates an environment with `backend: "local"`.
2. `tiller-hub` stores env metadata in KV and initializes `WorkspaceDO`.
3. `tiller-hub` calls the runner (via `tiller serve-runner`) over HTTPS.
4. The runner starts a local Docker container from `tiller-sandbox:local`.
5. The container syncs files from `WorkspaceDO`, starts `tiller-cli`, and opens
   ttyd.
6. `tiller-cli` connects back to `HubDO` and creates a normal session.
7. The web UI and `tiller` attach to the hosted hub exactly the same way they do
   for Cloudflare Containers.

### Cloudflare Containers backend

1. The UI creates an environment with `backend: "cf"`.
2. `tiller-hub` stores env metadata in KV and initializes `WorkspaceDO`.
3. `tiller-hub` calls `SandboxDO`.
4. `SandboxDO` starts the Cloudflare container.
5. The container syncs from `WorkspaceDO`, starts `tiller-cli`, and connects back
   to `HubDO`.

## What stays hosted on Cloudflare

- The `tiller-hub` web app and API.
- `HubDO`.
- `WorkspaceDO`.
- The `Research` button and chat history.
- Workspace file browsing and sync APIs.

Local execution does not move workspace state or Research off Cloudflare. It
only changes where the container runs.

## Research and local execution

`Research` is intentionally independent of runner backend:

- It reads and writes workspace files through `WorkspaceDO`.
- It stores history in `WorkspaceDO`.
- It still works when no container is running.

If you are using the ChatGPT/Codex subscription path, the separate Codex relay
is still needed because that problem is about outbound network origin for
Research, not about where `tiller-cli` runs. See
[codex-relay.md](./codex-relay.md).

## Local backend setup

### Prerequisites

- Docker running on the local machine or home server.
- `cloudflared` installed.
- `tiller-hub` deployed and already configured with:
  - `CF_ACCESS_CLIENT_ID`
  - `CF_ACCESS_CLIENT_SECRET`
  - either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`

### 1. Build the local sandbox image

```bash
cd <project-root>
npm run build --workspace packages/tiller-cli
docker build -f packages/tiller-hub/container/Dockerfile.local -t tiller-sandbox:local .
```

### 2. Start the runner

The runner is built into `tiller`. Start it with:

```bash
tiller serve-runner
```

Or configure it via environment variables:

```bash
export RUNNER_TOKEN="$(openssl rand -hex 24)"
export TILLER_LOCAL_RUNNER_IMAGE="tiller-sandbox:local"
export TILLER_LOCAL_RUNNER_PORT=8789
tiller serve-runner
```

Health check:

```bash
curl http://127.0.0.1:8789/healthz
```

Authenticated runner check:

```bash
curl -i -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:8789/envs/example-slug
```

That should return `404`, not `401`.

### 3. Expose the runner with Cloudflare Tunnel

Quick test:

```bash
cloudflared tunnel --url http://127.0.0.1:8789
```

Recommended long-lived setup:

```bash
cloudflared tunnel login
cloudflared tunnel create tiller-runner
cloudflared tunnel route dns tiller-runner tiller-runner.example.com
```

Example config:

```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: tiller-runner.example.com
    service: http://127.0.0.1:8789
  - service: http_status:404
```

Run it:

```bash
cloudflared tunnel run --config ~/.cloudflared/tiller-runner.yml tiller-runner
```

### 4. Point `tiller-hub` at the local backend

```bash
cd <project-root>/packages/tiller-hub
printf '%s' 'local' | npx wrangler secret put DEFAULT_RUNNER_BACKEND
printf '%s' 'https://tiller-runner.example.com' | npx wrangler secret put LOCAL_RUNNER_URL
printf '%s' 'https://tiller.example.com' | npx wrangler secret put HUB_PUBLIC_URL
cd <project-root>
npm run deploy --workspace packages/tiller-hub
```

`LOCAL_RUNNER_TOKEN` is optional. Keep it only if you want the runner origin to
enforce a second bearer-token layer in addition to Cloudflare Access.

If you only want local sometimes, leave `DEFAULT_RUNNER_BACKEND` unset and
choose the backend in the UI instead.

### 5. Add local config for `tiller`

For laptop-oriented local use, `tiller setup` reads these from
`~/.config/tiller/config.json`:

```json
{
  "hubUrl": "https://tiller.example.com",
  "clientId": "<cf-access-client-id>",
  "clientSecret": "<cf-access-client-secret>",
  "cloudflaredTunnelName": "tiller-local"
}
```

`localRunnerToken` and `researchRelayToken` are now optional for laptop-local
use. Add them only if you want the local services to enforce a second
application-level bearer-token check.

By default, `tiller` derives `tiller-runner.<hub-domain>` and
`tiller-relay.<hub-domain>` from `hubUrl`. Override them only if your tunnel
hostnames use different names.

### 6. Preferred laptop flow

After the one-time worker and tunnel setup above, use `tiller` as the local
entry point:

```bash
cd <project-root>
npm run build --workspace packages/tiller
cd packages/tiller
npm run setup
npm start
```

Plain `tiller` now starts the local runner, Research relay, and named tunnel if
needed before opening the picker. On exit, it tears down only the services that
invocation started. Helpful companion commands:

```bash
npm run doctor
npm run status
npm run up
npm run down
```

### 7. Use it

- Open `tiller-hub`.
- Click `New Environment`.
- Choose `Local Runner` or `Cloudflare Containers`.
- Start the environment normally.
- Use `Research` the same way regardless of backend.

## Operational notes

- The runner (`tiller serve-runner`) and `cloudflared` should run under a
  supervisor such as `systemd`, `launchd`, or Docker Compose if you want this to be reliable.
- If the tunnel is down, local env starts will fail from `tiller-hub`.
- If the runner is up but Docker is down, starts will fail at the runner.
- If you change `tiller-cli` or container boot logic, rebuild
  `tiller-sandbox:local`.
- Existing envs can be mixed: some `cf`, some `local`.

## Files involved

- [envs.ts](../api/envs.ts)
- [workspace-do.ts](../api/workspace-do.ts)
- [sandbox-do.ts](../api/sandbox-do.ts)
- [runner-backend.ts](../api/runner-backend.ts)
- [runner-backend-cf.ts](../api/runner-backend-cf.ts)
- [runner-backend-local.ts](../api/runner-backend-local.ts)
- [runner-server.ts](../../tiller/src/runner-server.ts)
- [Dockerfile.local](../container/Dockerfile.local)
