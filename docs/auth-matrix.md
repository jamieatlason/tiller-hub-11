# Tiller Auth Matrix

This is the current auth and config surface for `tiller-hub`, `tiller`, and
`tiller-cli`.

The goal is to answer three questions quickly:

1. What is required for a hosted deploy?
2. What is required for laptop-local use through `tiller`?
3. Which tokens are optional hardening or provider-specific integrations?

## Deployment-time credentials

These are used to deploy the worker, not during normal runtime.

| Name | Where used | Required | Notes |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploys / CI | Yes | Standard Cloudflare API token for deploy-time operations. |
| `CLOUDFLARE_DEFAULT_ACCOUNT_ID` | Wrangler deploys / CI | Yes | Account selection for deploy-time operations. |

## Hosted `tiller-hub` runtime bindings and secrets

These are the live bindings or secrets used by the deployed worker.

| Name | Required | Used for | Notes |
| --- | --- | --- | --- |
| `HUB_PUBLIC_URL` | Optional | Public hub URL handed to containers | If unset, `tiller-hub` derives it from the incoming request origin. |
| `CF_ACCESS_CLIENT_ID` | Optional | Cloudflare Access service token | Required only when the hub or local runner/relay are protected by Cloudflare Access. |
| `CF_ACCESS_CLIENT_SECRET` | Optional | Cloudflare Access service token | Same role as `CF_ACCESS_CLIENT_ID`. |
| `DEFAULT_NAMESPACE` | Yes | Default namespace selection | Current system still assumes a default namespace exists. |
| `DEFAULT_RUNNER_BACKEND` | Optional | Default env backend | `cf` or `local`. |
| `DEFAULT_TILLER_CLI_VERSION` | Optional | Pin `tiller-cli` version in containers | Useful for controlled rollouts. |
| `LOCAL_RUNNER_URL` | Optional | Local backend API base URL | Required only when using the local runner backend. |
| `LOCAL_RUNNER_TOKEN` | Optional | Extra bearer-token layer for local runner | Additional hardening on top of Cloudflare Access. |
| `RESEARCH_RELAY_URL` | Optional | Research relay URL | Required only if Research uses the local ChatGPT/Codex relay path. |
| `RESEARCH_RELAY_TOKEN` | Optional | Extra bearer-token layer for research relay | Additional hardening on top of Cloudflare Access. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional | Claude subscription auth in containers | Preferred credential for Claude Code subscription mode. |
| `ANTHROPIC_API_KEY` | Optional | Anthropic API auth in containers | Used only when the selected container auth mode resolves to API. |
| `GITHUB_TOKEN` | Optional | Private repo tarballs and GitHub package access | Needed for private repos or package pulls that require auth. |
| `OPENAI_MODEL` | Optional | Hosted Research model override | Defaults are defined by agent specs if unset. |

## Local `tiller` config

These values live in `~/.config/tiller/config.json` or equivalent env vars.

| Key / Env | Required | Used for | Notes |
| --- | --- | --- | --- |
| `hubUrl` / `HUB_URL` | Yes | Target hub URL | Example: `https://tiller.example.com`. |
| `clientId` / `CF_ACCESS_CLIENT_ID` | Optional | Cloudflare Access service token | Required when the hub or local runner/relay hostnames are behind Cloudflare Access. Not required for a deliberately public hub. |
| `clientSecret` / `CF_ACCESS_CLIENT_SECRET` | Optional | Cloudflare Access service token | Same role as `clientId`. |
| `namespace` / `NAMESPACE` | Optional | Namespace override | Falls back to hostname if omitted. |
| `cloudflaredTunnelName` / `TILLER_CLOUDFLARED_TUNNEL_NAME` | Optional | Named tunnel process target | Defaults to `tiller-local`. |
| `localRunnerHostname` / `TILLER_LOCAL_RUNNER_HOSTNAME` | Optional | Public runner hostname | Defaults to `tiller-runner.<hub-domain>`. |
| `researchRelayHostname` / `TILLER_RESEARCH_RELAY_HOSTNAME` | Optional | Public relay hostname | Defaults to `tiller-relay.<hub-domain>`. |
| `localRunnerPort` / `TILLER_LOCAL_RUNNER_PORT` | Optional | Local runner listen port | Defaults to `8789`. |
| `researchRelayPort` / `TILLER_RESEARCH_RELAY_PORT` | Optional | Local relay listen port | Defaults to `8788`. |
| `localRunnerImage` / `TILLER_LOCAL_RUNNER_IMAGE` | Optional | Local sandbox image | Defaults to `tiller-sandbox:local`. |
| `localRunnerPullImage` / `TILLER_LOCAL_RUNNER_PULL_IMAGE` | Optional | Prebuilt image source for first-run pulls | Defaults to `ghcr.io/paperwing-dev/tiller-base:latest`. |
| `cloudflaredConfigPath` / `TILLER_CLOUDFLARED_CONFIG_PATH` | Optional | Tunnel config path | Defaults to `~/.cloudflared/config.yml`. |
| `localRunnerToken` / `TILLER_RUNNER_TOKEN` | Optional | Extra runner bearer-token layer | Optional hardening only. |
| `researchRelayToken` / `TILLER_RESEARCH_RELAY_TOKEN` | Optional | Extra relay bearer-token layer | Optional hardening only. |

## Minimal supported setups

### Hosted hub only

Required:

- `DEFAULT_NAMESPACE`
- provider auth for whichever agents you actually use

Optional:

- `HUB_PUBLIC_URL`
- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`
- `DEFAULT_RUNNER_BACKEND`
- `LOCAL_RUNNER_URL`
- `RESEARCH_RELAY_URL`
- extra bearer-token hardening

### Hosted hub + laptop-local execution

Required on the machine:

- `hubUrl`
- `clientId`
- `clientSecret`
- Docker
- local image `tiller-sandbox:local`
- named tunnel config in `~/.cloudflared/` or your configured path

One of these tunnel runtimes is required:

- host `cloudflared`
- Docker, so `tiller` can run the official `cloudflare/cloudflared` image

Optional but useful on developer machines:

- `gh auth` login, so `tiller` can authenticate Docker pulls from GHCR automatically

Optional on the machine:

- `localRunnerToken`
- `researchRelayToken`
- explicit runner/relay hostnames if you do not want the derived defaults

## Explicitly removed legacy items

These are no longer part of the active runtime surface:

- `FLY_API_TOKEN`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT`
- `CF_ACCESS_TEAM_DOMAIN`

Historical notes may still mention them in migration documents, but the current
runtime no longer depends on them.
