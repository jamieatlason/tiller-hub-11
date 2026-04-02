# Deploy To Cloudflare

This package can move toward a Deploy to Cloudflare flow, but only for the
hosted `tiller-hub` Worker.

`tiller`, the local runner, and the relay are still local-machine concerns.
They stay outside the deploy button flow.

## What the button could cover

- the hosted Worker app
- KV
- R2
- Durable Objects
- Workers AI binding
- the default self-host `wrangler.jsonc`

## What it does not replace

- Cloudflare Access application and service token setup
- local `tiller` install
- `tiller init`
- `tiller setup`
- local tunnel creation and `cloudflared` login

## Current constraints

- The repository must be public for the button to be useful.
- Cloudflare's deploy button works best when the Worker app is isolated enough
  to deploy from a subdirectory.
- The local half of Tiller still needs post-deploy setup because it is not a
  Worker app.

## Recommended shape

The realistic tight UX is:

1. Click Deploy to Cloudflare for the hosted Worker.
2. Open the deployed app and add the required API key in Settings.
3. Create the Access app and service token if you want local runner or private hub auth.
4. Install `tiller`.
5. Run `tiller init` or `tiller init --public-hub`.
6. Run `tiller setup`.
7. Run `tiller`.

## Naming

The hosted Worker does not need to be named `tiller-hub`. The generated self-host
template now accepts any Worker name and supports either:

- a custom domain, such as `https://tiller.example.com`
- a `workers.dev` URL, such as `https://my-tiller-control-plane.<subdomain>.workers.dev`

If you use `workers.dev`, supply explicit runner and relay URLs because those
local hostnames cannot be derived from the Worker URL.

`HUB_PUBLIC_URL` does not need to be known before first deploy. The Worker
derives it from the request origin unless you explicitly override it later.
