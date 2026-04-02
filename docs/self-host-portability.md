# Tiller Hub Self-Host Portability

This note documents the remaining account- and domain-specific values you need
to replace when deploying `tiller-hub` outside the Paperwing account.

## Runtime values

These are the runtime values you may want to explicitly configure for a
self-hosted deployment:

- `HUB_PUBLIC_URL`
  - optional override for the deployed hub URL, for example `https://tiller.example.com`
- `LOCAL_RUNNER_URL`
  - public URL for the local runner, for example `https://tiller-runner.example.com`
- `RESEARCH_RELAY_URL`
  - public URL for the local research relay, for example `https://tiller-relay.example.com/responses`
- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`

`HUB_PUBLIC_URL` is used when `tiller-hub` launches `tiller-cli` inside a
container. If unset, the worker derives it from the incoming request origin.

## Local defaults

`tiller` no longer hardcodes the Paperwing hostnames.

If `~/.config/tiller/config.json` includes:

```json
{
  "hubUrl": "https://tiller.example.com"
}
```

then `tiller` derives these hostnames by default:

- `tiller-runner.example.com`
- `tiller-relay.example.com`

You can still override them with:

- `localRunnerHostname`
- `researchRelayHostname`

## Wrangler values to replace

The default [wrangler.jsonc](../wrangler.jsonc) is now the deploy-button-friendly
self-host config with `workers_dev: true` and no account-specific values. It is
ready to use as-is for new deployments.

The Paperwing production config lives in
[wrangler.production.jsonc](../wrangler.production.jsonc) and contains
account-specific values (`routes`, `containers[].image`, `kv_namespaces[].id`,
`r2_buckets[].bucket_name`).

## Practical rule

For a new Cloudflare account:

1. Click the Deploy to Cloudflare button, or clone the repo and run
   `npx wrangler deploy`.
2. Open the deployed app and add runtime settings only as needed.
3. Install `tiller`.
4. Run `tiller setup`.

That is the baseline portable path.
