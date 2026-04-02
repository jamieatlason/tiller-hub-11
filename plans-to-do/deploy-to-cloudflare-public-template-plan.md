# Deploy-To-Cloudflare Public Template Plan

This is a deferred plan for turning `tiller-hub` into a temporary public,
deploy-button-friendly template repo for real-world testing.

The decision for now is to **wait before implementing this**.

Reason:
- `tiller-hub` and `tiller` are still changing quickly.
- A public template repo will get stale fast if extracted too early.
- The right time to do this is when the hosted app shape, config surface, and
  local `tiller` flow are more stable.

## Goal

Make it possible to test this flow with a temporary public GitHub repo:

1. Click Deploy to Cloudflare for a public `tiller-hub`
2. Get a `workers.dev` URL
3. Install `tiller`
4. Run `tiller`
5. Let `tiller` handle first-run config and local startup

After testing, take the public repo back down.

## Why A Separate Public Repo

Do not expose this monorepo.

Cloudflare deploy buttons are best suited to a public repo with an isolated
Worker app. Even if monorepo support improves, a dedicated template repo is the
cleaner test surface.

That repo should:
- contain only the hosted `tiller-hub` template
- avoid Paperwing-specific values
- avoid unrelated packages and history
- default to a public `workers.dev` deployment

## Scope For The Temporary Public Repo

Include:
- Worker source needed to run `tiller-hub`
- `wrangler.jsonc`
- `.dev.vars.example`
- template README
- deploy-button docs
- any minimal scripts needed for first deploy

Exclude:
- unrelated packages from this monorepo
- Paperwing domains and account IDs
- private tokens or internal secrets
- local-only operational docs unless they are directly relevant to self-hosting

## First Version Constraints

The first public template should be:
- public-hub-first
- `workers.dev`-first
- no Cloudflare Access required for the initial test
- local runner / relay URLs optional
- local execution delegated to `tiller`

Do not try to make the first version cover:
- private Access-heavy setup
- full local tunnel bootstrapping from the deploy button
- advanced namespace/multi-user behavior

## Implementation Plan

### Phase 1: Local Extraction Draft

Create a local temporary directory or sibling repo that contains only the files
required to run a hosted `tiller-hub` template.

Checklist:
- identify the minimal file set
- copy only the hosted app files
- remove Paperwing-specific config
- replace account-specific values with placeholders
- confirm the template builds standalone

### Phase 2: Template Hardening

Before making anything public:
- verify the Worker can deploy from the extracted repo
- verify the Wrangler config is generic
- verify docs do not assume Paperwing domains
- verify the default flow uses `workers.dev`

### Phase 3: Public Repo Creation

Create a temporary public GitHub repo, for example:
- `tiller-hub-template`
- `paperwing-tiller-template`

Push only the extracted template contents.

### Phase 4: Add The Real Deploy Button

Add a real Deploy to Cloudflare button to the public repo README.

The deploy-button path should:
- create a public hosted Worker
- provision the needed Worker resources
- expose the post-deploy `workers.dev` URL

### Phase 5: End-To-End Test

Run the full public test flow:

1. Deploy from the button into a fresh Cloudflare Worker
2. Confirm the hosted app is reachable publicly
3. Install `tiller`
4. Run `tiller`
5. Confirm first-run config works
6. Confirm local-first attach still works with the current local setup

### Phase 6: Tear Down

After validation:
- delete the temporary public GitHub repo
- remove or archive the deploy-button docs if they were only for the test
- keep the learnings here and in the main repo docs

## File Extraction Checklist

This should be revisited when implementation begins, but likely candidates are:

- `packages/tiller-hub/api/`
- `packages/tiller-hub/src/`
- `packages/tiller-hub/public/`
- `packages/tiller-hub/index.html`
- `packages/tiller-hub/package.json`
- `packages/tiller-hub/vite.config.ts`
- `packages/tiller-hub/vitest.config.ts`
- `packages/tiller-hub/tsconfig.json`
- `packages/tiller-hub/tsconfig.app.json`
- `packages/tiller-hub/wrangler.self-host.template.jsonc`
- `packages/tiller-hub/.dev.vars.example`
- selected docs rewritten for the public repo

This should likely exclude at first:
- `container/` if the template is public-hub-only
- local relay implementation details
- migration notes and internal historical docs

## Open Questions For Later

- Should the public template include container support from day one, or only
  hosted agents?
- Should the deploy-button version use `workers.dev` only, with custom domains
  as a later doc?
- Should the public repo be a one-off temporary repo or the start of a lasting
  separate template repository?
- Do we want a true public sandbox image before doing this, or is the current
  developer-only GHCR image acceptable for the test?

## Decision

Do this later, not now.

Trigger to revisit:
- `tiller` first-run UX is stable
- `tiller-hub` config surface stops moving frequently
- self-host docs are stable enough that a public template will not churn
