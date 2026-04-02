# Tiller Hub

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paperwing-dev/tiller-hub&autoDeploy=true)

_Steer queries to the agent that fits the job, using infrastructure sized to the task. Switch to more powerful agents and compute seamlessly, picking up right where the last agent left off._

TLDR, it's a wrapper around coding agents like Claude Code/Codex/your own, but focused on remote execution and handoff between agents. If you want to build your own AI IDE while still taking advantage of the updates from coding agents, this is a good starting place.

For more background, check out [paperwing.dev/code/tiller](www.paperwing.dev/code/tiller).

## How To Run

1. Deploy using the "Cloudflare Deploy" button.
2. Open the deployed Tiller UI and add your API key in Settings.
3. Install the `tiller` package.

## How To Use

1. Explore the Tiller Hub UI wherever you deployed it. You can do everything from there
2. Run `npm run tiller` locally. This allows starting, stopping, and using any session that you've create in the UI. Both local sessions and remote sessions.

## What Is Supported

Tiller can be controlled through a web ui at the "tiller-hub", or locally via the "tiller" cli package.

## Architecture

### Containers Backend: Cloudflare vs Fly.io

Routing to the right infrastructure "sized for the task", means different things for different applications. Sometimes you might want better performance and worse price, sometimes the opposite. In this apps case, cloudflare containers should have faster performance during usage, as it all lives on the same network. However, if you want every coding agent to be sandboxed to it's own container, it will be more expensive than Fly.io. Subsequent boot times on Fly.io also should be faster, but again slower in usage.

These costs can be cut down significantly if you want to run multiple coding agents on one cloudflare container. They will still each maintain their own filesystem, but since they are run on the same machine, the sandboxing is not complete. For our use case this is probably fine, and will be added as a future feature if cost becomes an issue. Unlikely given most repos and usage patterns.

### Embedded Custom Agents

With "Dynamic Workers", you can run agents that don't need a container at an even cheaper cost. We used one to create the "Plan" agent. Look in the repo for an example of how you could build your agent like "review" for example. The one issue with these agents is that Claude Code is not supported with a subscription -- only via the API. Chatgpt 5.4 does work with a subscription, but only if you are running the `tiller` CLI tool locally. All models work via the API, and we have a few from Cloudflares API gateway prepopulated that you can choose from.

We typically use ChatGpt 5.4 running `tiller` locally for this application. Applications where there are no subscriptions (many users supported), will require using api keys and would be better suited for other models.

## What runs where

### Cloudflare

- Web app and API
- `HubDO` session state
- `WorkspaceDO` file storage and Research
- optional Cloudflare runner backend via `SandboxDO`

### Local runner

- Docker container lifecycle
- ttyd terminal endpoint
- outbound network egress for the running coding harness

### Container

- syncs workspace files from `WorkspaceDO`
- starts `tiller-cli`
- connects back to the hosted hub

## Backend choices

| Backend | Executes where                        | Use when                                                           |
| ------- | ------------------------------------- | ------------------------------------------------------------------ |
| `local` | Docker on your machine or home server | Better egress, personal subscriptions, lower-cost personal compute |
| `cf`    | Cloudflare Containers                 | Fully hosted execution                                             |

The backend is selectable per environment in the UI.

## Quick start: local backend

This is the setup that is currently most useful if you want the hub hosted but
want the container to egress from your own network.

### 1. Build the local image

```bash
cd <project-root>
npm run build --workspace packages/tiller-cli
docker build -f packages/tiller-hub/container/Dockerfile.local -t tiller-sandbox:local .
```

### 2. Start the local runner

The runner is built into `tiller`:

```bash
tiller serve-runner
```

Check it:

```bash
curl http://127.0.0.1:8789/healthz
```

### 3. Expose the runner with Cloudflare Tunnel

Quick test:

```bash
cloudflared tunnel --url http://127.0.0.1:8789
```

Long-lived setup is better with a named tunnel. See
[runner-backends.md](./docs/runner-backends.md).

### 4. Configure the deployed worker

```bash
cd <project-root>/packages/tiller-hub
printf '%s' 'local' | npx wrangler secret put DEFAULT_RUNNER_BACKEND
printf '%s' 'https://tiller-runner.example.com' | npx wrangler secret put LOCAL_RUNNER_URL
printf '%s' 'https://tiller.example.com' | npx wrangler secret put HUB_PUBLIC_URL
cd <project-root>
npm run deploy --workspace packages/tiller-hub
```

`LOCAL_RUNNER_TOKEN` is now optional. Set it only if you want an extra
application-level bearer-token check in addition to Cloudflare Access.

`HUB_PUBLIC_URL` is also optional. If you leave it unset, `tiller-hub` derives
its public URL from the incoming request origin. Only set it when you want to
override that auto-detected value.

If you do not want `local` as the default, skip the
`DEFAULT_RUNNER_BACKEND` secret and choose the backend in the UI.

### 5. Add local config for `tiller`

Preferred:

```bash
tiller init --hub-url https://tiller.example.com --client-id <cf-access-client-id> --client-secret <cf-access-client-secret>
```

`tiller init` writes `~/.config/tiller/config.json` for you.

If you still prefer manual config, `tiller setup` reads:

```json
{
  "hubUrl": "https://tiller.example.com",
  "namespace": "your-namespace",
  "clientId": "<cf-access-client-id>",
  "clientSecret": "<cf-access-client-secret>",
  "cloudflaredTunnelName": "tiller-local"
}
```

You can still add `localRunnerToken` and `researchRelayToken` if you want the
local services to enforce a second bearer-token layer, but they are no longer
required for `tiller` to bootstrap the local stack.

By default, `tiller` derives `tiller-runner.<hub-domain>` and
`tiller-relay.<hub-domain>` from `hubUrl`. Override them with
`localRunnerHostname` / `researchRelayHostname` only if your tunnel hostnames
do not follow that pattern.

For the remaining account-specific Wrangler values, see
[self-host-portability.md](./docs/self-host-portability.md).
For the full auth/config surface, see
[auth-matrix.md](./docs/auth-matrix.md).
For the end-to-end self-host path, see
[self-host-guide.md](./docs/self-host-guide.md).
For a Deploy to Cloudflare-oriented hosted setup, see
[deploy-to-cloudflare.md](./docs/deploy-to-cloudflare.md).
For generated self-host files, run:

```bash
npm run bootstrap:self-host --workspace packages/tiller-hub -- --help
```

### 6. Preferred laptop flow

Once the named tunnel and worker secrets are configured, day-to-day local use
should go through `tiller`:

```bash
cd <project-root>
npm run build --workspace packages/tiller
cd packages/tiller
npm run setup -- --local
npm start
```

Plain `tiller` now:

- opens the env/session picker
- starts local services only when you choose or attach to a local environment
- tears down only the services that invocation started when you exit

When attached to a session, the controls are:

- single `Ctrl+C` exits `tiller` and then local cleanup runs
- `Ctrl+]` sends abort to the remote session

Useful commands:

```bash
npm run doctor
npm run status
npm run up
npm run down
```

### 7. Use it

- Open `tiller-hub`
- click `New Environment`
- choose `Local Runner` or `Cloudflare Containers`
- start the environment normally
- use `Research` the same way regardless of backend

## Research

`Research` is hosted and uses `WorkspaceDO`, so it is independent of where the
container runs. That means:

- Research works even if the environment is stopped
- moving execution to `local` does not remove the Research button

### ChatGPT/Codex subscription path

Research currently supports the ChatGPT-authenticated Codex backend. When using
that subscription-backed path from a deployed Worker, a separate local relay may
still be needed because `chatgpt.com` can challenge datacenter egress.

See:

- [codex-relay.md](./docs/codex-relay.md)
- [runner-backends.md](./docs/runner-backends.md)

## Main docs

- [runner-backends.md](./docs/runner-backends.md)
  - how `cf` and `local` work
  - local runner setup
  - tunnel setup
  - operational caveats
- [local-service-auth.md](./docs/local-service-auth.md)
  - why runner/relay use both Cloudflare Access and bearer-token auth
  - what breaks when named tunnels or secrets drift
- [codex-relay.md](./docs/codex-relay.md)
  - Research relay for ChatGPT/Codex subscription egress

## Package commands

```bash
cd <project-root>/packages/tiller-hub
npm run dev
npm run build
npm run deploy
npm run deploy:prod
npm run test
```
