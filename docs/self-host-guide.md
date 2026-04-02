# Tiller Self-Host Guide

This is the shortest supported path for running Tiller on a different Cloudflare
account and domain.

The intended operator flow is:

1. Deploy `tiller-hub`
2. Install `tiller`
3. Run `tiller setup`
4. Run `tiller`

## 1. Prepare the worker config

The fastest path is to generate all three local files from the templates.
The hosted Worker can use any name and either a custom domain or a
`workers.dev` URL.

```bash
cd <project-root>
npm run bootstrap:self-host --workspace packages/tiller-hub -- \
  --worker-name my-tiller-control-plane \
  --hub-url https://tiller.example.com \
  --account-id <account-id> \
  --kv-id <kv-namespace-id> \
  --bucket-name <bucket-name>
```

For a `workers.dev` deployment, use the Worker URL directly and pass explicit
runner and relay URLs because they cannot be derived from `workers.dev`:

```bash
cd <project-root>
npm run bootstrap:self-host --workspace packages/tiller-hub -- \
  --worker-name my-tiller-control-plane \
  --hub-url https://my-tiller-control-plane.<subdomain>.workers.dev \
  --workers-dev \
  --runner-url https://tiller-runner.example.com \
  --relay-url https://tiller-relay.example.com/responses \
  --account-id <account-id> \
  --kv-id <kv-namespace-id> \
  --bucket-name <bucket-name>
```

That writes:

- `packages/tiller-hub/wrangler.self-host.jsonc`
- `packages/tiller-hub/.dev.vars.self-host`
- `packages/tiller/config.self-host.json`

The generated `tiller` config can be tested without touching your real home
config by exporting `TILLER_CONFIG_PATH`.

If you prefer to do it manually, copy the template Wrangler file:

```bash
cd <project-root>/packages/tiller-hub
cp wrangler.self-host.template.jsonc wrangler.self-host.jsonc
```

Replace these placeholders in
[wrangler.self-host.template.jsonc](../wrangler.self-host.template.jsonc):

- `<worker-name>`
- `<container-app-name>`
- `<account-id>`
- `<bucket-name>`
- `<kv-namespace-id>`
- route or `workers_dev` settings, depending on your chosen public URL

The live Paperwing production config is in
[wrangler.production.jsonc](../wrangler.production.jsonc).
The default [wrangler.jsonc](../wrangler.jsonc) is the deploy-button-friendly
self-host config. The template is for new accounts.

## 2. Create the Cloudflare resources

You need:

- one KV namespace for `ENVS_KV`
- one R2 bucket for `BUCKET`
- one Access application covering the hub and local sibling hostnames
- one Access service token for machine-to-machine calls
- optional: a Cloudflare Containers image in your account registry

The exact runtime token list is documented in
[auth-matrix.md](./auth-matrix.md).

## 3. Configure runtime secrets and vars

For local dev or manual self-host setup, start from
[.dev.vars.self-host.example](../.dev.vars.self-host.example).

For deployed secrets, set at least:

```bash
printf '%s' 'https://tiller.example.com' | npx wrangler secret put HUB_PUBLIC_URL
printf '%s' '<cf-access-client-id>' | npx wrangler secret put CF_ACCESS_CLIENT_ID
printf '%s' '<cf-access-client-secret>' | npx wrangler secret put CF_ACCESS_CLIENT_SECRET
printf '%s' '<namespace>' | npx wrangler secret put DEFAULT_NAMESPACE
```

If you want local execution from `tiller-hub`, also set:

```bash
printf '%s' 'https://tiller-runner.example.com' | npx wrangler secret put LOCAL_RUNNER_URL
printf '%s' 'https://tiller-relay.example.com/responses' | npx wrangler secret put RESEARCH_RELAY_URL
```

## 4. Deploy `tiller-hub`

Use the generated or edited self-host Wrangler file directly:

```bash
cd <project-root>/packages/tiller-hub
npx wrangler deploy --config wrangler.self-host.jsonc
```

At this point the hosted control plane should be live.

If you are evaluating a public template repo later, see
[deploy-to-cloudflare.md](./deploy-to-cloudflare.md)
for the current constraints of a Deploy to Cloudflare button.

## 5. Install and configure `tiller`

Install `tiller`, then either let plain `tiller` prompt for config on first
run or use the generated config.

Optional non-interactive init:

```bash
tiller init --hub-url https://tiller.example.com --client-id <cf-access-client-id> --client-secret <cf-access-client-secret>
```

Optional public-hub init:

```bash
tiller init --public-hub --hub-url https://tiller.example.com
```

Generated config path:

```bash
TILLER_CONFIG_PATH=../../tiller/config.self-host.json \
  npm run setup --workspace packages/tiller
```

If you still prefer editing a file manually, start from:

- [config.example.json](../../tiller/config.example.json)

## 6. Start `tiller`

```bash
cd <project-root>/packages/tiller
npm start
```

On first run, `tiller` can:

- prompt for missing config and write `~/.config/tiller/config.json`
- try to bring up the local runner, relay, and tunnel
- prompt to pull the prebuilt sandbox image if it is missing
- fall back to remote-only mode for that run if you decline the image pull

Use the explicit checks only when you want diagnostics:

```bash
npm run doctor --workspace packages/tiller
npm run setup --workspace packages/tiller -- --local
```

`doctor` is the support command. `setup --local` is the strict preflight if you
want to validate every local prerequisite explicitly.

## Notes

- By default, `tiller` derives:
  - `tiller-runner.<hub-domain>`
  - `tiller-relay.<hub-domain>`
- Override those only if your hostnames do not follow that pattern.
- `tiller` can use a host `cloudflared` install or the official
  `cloudflare/cloudflared` Docker image for the named tunnel.
- The local sandbox image is still not bundled with the `tiller` package. The
  default pull source is `ghcr.io/paperwing-dev/tiller-base:latest`.
- `LOCAL_RUNNER_TOKEN` and `RESEARCH_RELAY_TOKEN` are optional hardening, not
  baseline requirements.
- `tiller-cli` stays separate because it runs inside the container, not on the
  operator machine.

## Related docs

- [auth-matrix.md](./auth-matrix.md)
- [self-host-portability.md](./self-host-portability.md)
- [runner-backends.md](./runner-backends.md)
