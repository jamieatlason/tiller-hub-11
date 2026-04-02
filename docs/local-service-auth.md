# Local Service Auth

This note explains the auth layers between deployed `tiller-hub`, the local
runner, and the local Codex relay.

## Why this exists

Once the runner and the Codex relay moved behind named Cloudflare Tunnel
hostnames, they stopped being directly reachable from `tiller-hub`.

That is intentional. The local services are exposed publicly enough for
Cloudflare to route traffic to them, but they are still protected by Cloudflare
Access before the request ever reaches the machine at home.

This creates a primary auth model:

1. Cloudflare Access proves the caller is allowed to reach the tunnel hostname.
2. Optional local bearer tokens can add an extra application-level check.

## Current hostnames

- `https://tiller-runner.example.com`
- `https://tiller-relay.example.com`

These are long-lived named tunnel hostnames that replace fragile
`trycloudflare.com` URLs.

In a normal self-hosted setup, these are sibling hostnames of the deployed hub
URL, and `tiller` derives them automatically from `hubUrl` unless you
explicitly override them.

## Request flows

### Local runner

1. Browser calls deployed `tiller-hub`.
2. `tiller-hub` decides an env uses `backend: "local"`.
3. `tiller-hub` calls `https://tiller-runner.example.com`.
4. Cloudflare Access validates service-token headers.
5. If configured, the runner validates `Authorization: Bearer <LOCAL_RUNNER_TOKEN>`.
6. The runner starts or manages the local Docker container.

### Research relay

1. Browser calls deployed `tiller-hub`.
2. `WorkspaceDO` starts a Research chat request.
3. `tiller-hub` calls `https://tiller-relay.example.com/responses`.
4. Cloudflare Access validates service-token headers.
5. If configured, the relay validates `Authorization: Bearer <RESEARCH_RELAY_TOKEN>`.
6. The relay forwards the request to
   `https://chatgpt.com/backend-api/codex/responses`.

## The two auth layers

### Layer 1: Cloudflare Access

These headers get the request through Cloudflare Access:

- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`

In `tiller-hub`, they come from:

- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`

Why this layer exists:

- protects the named tunnel hostname even if someone learns it
- blocks requests before they ever reach the local machine
- gives one centralized access policy in Cloudflare

Without these headers, Cloudflare returns the Access login or deny page and the
request never reaches the runner or the relay.

### Layer 2: Optional local service bearer token

These headers authenticate the caller to the actual local service:

- `Authorization: Bearer <LOCAL_RUNNER_TOKEN>`
- `Authorization: Bearer <RESEARCH_RELAY_TOKEN>`

Why this layer still exists:

- Cloudflare Access proves the caller may reach the hostname
- it does not replace application-level auth for the service itself
- the runner and relay should still reject requests that lack the expected
  shared secret

This layer is optional for laptop-local use because the services bind only to
`127.0.0.1` and the public path is already gated by Cloudflare Access. It is
still supported when you want a narrower shared secret between `tiller-hub` and
the local origin service.

## Why not use only one layer

### Only bearer token

This would mean removing Access from the tunnel hostnames and relying only on
service-specific shared secrets.

That would work, but it is weaker:

- the hostnames become directly reachable from the public internet
- the local service becomes responsible for all outer authentication
- you lose Cloudflare-side gating and auditability

### Only Cloudflare Access

This is now the default laptop-local mode:

- the public hostname is still protected by Cloudflare Access
- the local service only listens on `127.0.0.1`
- `tiller` can bootstrap the stack from the same service-token pair already
  used for `tiller-hub`

The tradeoff is narrower app-level separation between the runner/relay and any
other service using that Access token.

## Why this is different from quick tunnels

Quick tunnels were useful for testing because they only needed the service-level
bearer token and a temporary URL.

They were also operationally fragile:

- URLs changed every time the tunnel restarted
- stale worker secrets caused `530` and `1016` errors
- both local env boot and Research would break at once when the tunnel died

Named tunnels fix the URL stability problem. With the current setup,
`tiller-hub` must always send the Cloudflare Access headers and may also send the
service-specific bearer token when configured.

## Current secrets and bindings

### In deployed `tiller-hub`

- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`
- `LOCAL_RUNNER_URL`
- optional `LOCAL_RUNNER_TOKEN`
- `RESEARCH_RELAY_URL`
- optional `RESEARCH_RELAY_TOKEN`

### On the local machine

- optional `RUNNER_TOKEN` for the runner
- optional `RESEARCH_RELAY_TOKEN` for the relay process
- Cloudflare tunnel credentials in `~/.cloudflared/`

## Security tradeoff

The current setup is acceptable for personal infrastructure:

- Cloudflare Access gates the hostnames
- the local services bind only to `127.0.0.1`
- optional bearer tokens can still be enabled for extra separation

One cleanup still worth doing later:

- use a dedicated Cloudflare Access service token for `tiller-hub -> runner/relay`
  instead of sharing a broader token

## Operational failure modes

### Access headers missing or wrong

Symptoms:

- requests fail before they hit the local service
- Cloudflare Access login page or denial page
- local env starts fail
- Research relay fails

### Bearer token missing or wrong

Symptoms:

- the request reaches the local service
- the local service returns `401`
- only applies when the local bearer-token layer is enabled

### Tunnel down

Symptoms:

- DNS still resolves, but the tunnel hostname cannot reach the local service
- Research or local env control fails even though the local process may still be
  running

## Relevant code

- [runner-backend-local.ts](../api/env/runner-backend-local.ts)
- [codex.ts](../api/agent-core/codex.ts)
- [types.ts](../api/types.ts)
- [runner-server.ts](../../tiller/src/runner-server.ts)
- [codex-relay.md](./codex-relay.md)
- [runner-backends.md](./runner-backends.md)
