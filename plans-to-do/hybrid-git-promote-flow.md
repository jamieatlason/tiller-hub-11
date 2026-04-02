# Hybrid Git Promote Flow

This document captures the deferred plan for moving `tiller-hub` envs from
filesystem-diff promotion to a git-backed local branch and checkpoint model.

The decision is:

- keep Tiller's canonical repo snapshots and repo versioning
- use real git inside each env for local edits, commit, merge, and conflict UX
- persist only Tiller-managed git artifacts, not raw `.git`

## Why This Exists

The current env model has drifted toward re-implementing git concepts:

- local changes vs promotable changes
- ahead/behind semantics
- merge/reconcile behavior
- conflict handling

That complexity is not buying much. The better boundary is:

- Tiller owns canonical repo state, env lifecycle, and promotion policy
- git owns local commit, merge, and conflict semantics inside each env

This avoids turning `tiller-hub` into a git server while still making the user
experience feel branch-based and understandable.

## Product Rules

- An env is promotable only from an explicit local commit/checkpoint.
- Dirty working tree changes alone are not promotable.
- `Promote Commit` auto-attempts a merge if the repo moved ahead.
- Merge conflicts leave the env in a real git conflict state.
- Env files never auto-update in the background.
- All git actions work on both runner backends.

## Canonical Boundary

Keep the canonical repo model as it is today:

- `repo.currentVersion`
- repo revision metadata under `/.tiller/repo/revisions`
- repo tar snapshots under `/.tiller/repo/snapshots`

Do not switch the canonical repo workspace to native git worktrees.

Do not persist a shared `.git` object store for the canonical repo.

## Env Git Storage

Each env keeps real git state only while the runtime is up.

Persist only these Tiller-managed files in the env workspace:

- `/.tiller/git/base.json`
- `/.tiller/git/base.tar`
- `/.tiller/git/checkpoint.json`
- `/.tiller/git/checkpoint.tar`
- `/.tiller/git/state.json`

`base.*` describes the canonical repo version the env branch is based on.

`checkpoint.*` represents the single squashed local commit ahead of base.

`state.json` stores the last exported UI summary such as:

- git state
- whether a checkpoint exists
- whether the working tree is dirty
- conflict count
- export timestamp

Raw `.git` must never be persisted through WorkspaceDO or R2.

## Chosen Persistence Model

Use squash-only persistence across restarts.

That means:

- while an env is running, users and agents can use normal git locally
- when Tiller persists env git state, it collapses local history to one
  checkpoint commit ahead of base
- the next boot reconstructs the env branch from `base.*` plus one
  `checkpoint.*`

This keeps storage bounded and avoids syncing a large `.git` directory.

## Env Boot And Reconstruction

On env create or repo reset:

- copy the canonical repo snapshot into the env workspace
- write `/.tiller/git/base.*` from that repo version
- clear `checkpoint.*`

On env start:

- initialize a fresh git repo in `/workspace`
- add runtime ignore entries for:
  - `/.tiller/`
  - `/.git/`
  - `/.claude/settings.local.json`
- create a synthetic base commit from `base.tar`
- tag that commit as `tiller/base`
- create branch `tiller/env/<slug>`
- if `checkpoint.tar` exists, create one local commit on top of `tiller/base`
- overlay the persisted workspace files so uncommitted edits reappear as
  working tree changes

On periodic sync and shutdown:

- export current git state back into `/.tiller/git/*`
- squash any local commit history to one checkpoint
- keep uncommitted files as working tree files
- sync the workspace up without syncing `.git`

## Runner And Control API

Git is available in the runtimes, not in the API worker. So git operations need
an explicit sandbox control path.

Add a small control server inside the sandbox container and expose it on the
same port currently used for ttyd.

Move ttyd behind that control server.

The control server should handle:

- `POST /control/git/bootstrap`
- `GET /control/git/state`
- `POST /control/git/commit`
- `POST /control/git/discard-working-changes`
- `POST /control/git/update-branch`
- `POST /control/git/reset-branch`
- `POST /control/git/export-state`

`update-branch` and `reset-branch` accept the latest canonical repo tar and
repo version metadata in the request.

Every mutating control operation should export state and sync the workspace back
to WorkspaceDO before returning.

## Backend Changes

Extend the runner backend abstraction with a control request method.

Update both backends:

- `api/env/runner-backend-cf.ts`
- `api/env/runner-backend-local.ts`

For the local runner:

- add `/envs/:slug/control/*` to the runner server (`packages/tiller/src/runner-server.ts`)
- proxy it the same way terminal traffic is proxied today

For the Cloudflare container backend:

- forward control requests through `SandboxDO.fetch(...)`

Add one helper in env routes that:

- starts the env if needed
- waits for control bootstrap
- remembers whether Tiller auto-started it
- stops it again after the action if Tiller started it only for that action

## API And Type Changes

Add a new git-oriented env summary model in `api/types.ts`.

New fields:

- `gitState: "clean" | "modified" | "committed" | "conflicted" | "legacy"`
- `hasCheckpoint`
- `workingTreeDirty`
- `behindRepoVersion`
- `checkpointMessage`
- `checkpointCreatedAt`
- `conflictCount`
- `gitLastExportedAt`

Keep `baseRepoVersion`.

Keep old reconcile-oriented fields temporarily as compatibility fields until the
UI is fully switched over.

Add new env routes:

- `POST /api/envs/:slug/commit`
- `POST /api/envs/:slug/promote`
- `POST /api/envs/:slug/update-branch`
- `POST /api/envs/:slug/discard-working-changes`
- `POST /api/envs/:slug/reset-branch-to-repo`

Keep aliases during migration:

- `commit-back` -> `promote`
- `reconcile` -> `update-branch`
- `reset-to-repo` -> `reset-branch-to-repo`

## Action Semantics

### Commit Changes

- allowed when the env has changes and no unresolved conflicts
- creates or replaces the single local checkpoint commit
- requires a message, with a default UI value of `Checkpoint changes`
- if the current tree equals base, clear the checkpoint and return `no-op`

### Promote Commit

- requires a checkpoint
- requires a clean working tree
- requires zero unresolved conflicts
- if the repo moved ahead, auto-run `update-branch`
- if that merge conflicts, stop and leave the env conflicted
- if the env is ready, promote `checkpoint.tar` into canonical repo state
- after a successful promotion, reset the env branch to the new canonical base

### Update Branch

- merges the latest canonical repo snapshot into the local checkpoint branch
- requires no unresolved conflicts and no uncommitted working tree changes
- on success, updates `base.*` to the new repo version and rewrites
  `checkpoint.*`
- on conflict, leaves standard conflict markers in the workspace and records the
  conflict state

### Discard Working Changes

- resets the working tree to the checkpoint commit if one exists
- otherwise resets to the base commit
- does not discard the checkpoint itself

### Reset Branch To Repo

- replaces the env with the latest canonical repo snapshot
- clears checkpoint and conflict state
- rewrites `base.*` to the current repo version

## UX

Center the UI around local branch state, not repo versions.

Primary states:

- `Clean`
- `Modified`
- `Committed`
- `Behind repo`
- `Conflicted`
- `Legacy state: reset required`

Primary actions:

- `Commit Changes`
- `Promote Commit`
- `Update Branch`
- `Discard Working Changes`
- `Reset Branch to Repo`

Keep repo version numbers as secondary detail only.

Do not show `Promote Commit` just because an env was opened or closed.

## Keeping State In Sync

When an env is running, env list and env detail fetches should refresh the git
summary from the live control API before returning data.

When an env is stopped, use the last exported git summary plus repo version
metadata.

This ensures terminal-side edits and manual git usage can still be reflected in
the UI without waiting for a full reset or recreate flow.

## Excludes And Runtime Noise

Update the sync and hashing logic so `.git` is fully excluded everywhere.

Use one shared runtime ignore list for:

- workspace sync
- tree hashing
- promotion tar creation
- git export/staging

Keep `/.claude/settings.local.json` excluded so boot noise never becomes a code
change again.

## Migration

Add a feature flag for the new flow, for example `TILLER_GIT_FLOW=1`.

Existing envs without `/.tiller/git/base.*` start as `legacy`.

Legacy handling:

- if the env can be mapped safely, bootstrap git artifacts on first start
- if the env is in old reconcile/conflict state, require `Reset Branch to Repo`

No repo migration is required because canonical repo snapshots stay the same.

## Suggested Implementation Order

1. Exclude `.git` everywhere and add `/.tiller/git/*` persisted artifacts.
2. Build the sandbox control server and git bootstrap/export scripts.
3. Extend both runner backends and `tiller-runner` with control proxying.
4. Implement commit, update-branch, promote, discard, and reset routes.
5. Switch the UI to the new branch/checkpoint state model.
6. Add legacy bootstrap and temporary route aliases.
7. Remove old reconcile-first behavior after the new flow is stable.

## Acceptance Criteria

- creating and starting an env produces a clean git-backed workspace
- opening and stopping an env with no code edits does not create a promotable
  state
- `Commit Changes` creates or replaces one checkpoint commit
- stopped envs resume with the same checkpoint and working tree state
- `Promote Commit` on an unchanged repo creates the next canonical repo version
- `Promote Commit` behind repo auto-merges on clean cases
- conflicting merges leave real conflict markers in the workspace
- `.git` is not present in persisted workspace manifests
- both local and Cloudflare backends pass the same git action tests

## Tests To Add

- bootstrap/export unit tests for base-only and base-plus-checkpoint envs
- squash export tests for multiple local commits
- ignore tests for `/.claude/settings.local.json`
- route tests for commit, promote, update-branch, discard, and reset
- backend tests for local and CF control request forwarding
- UI tests for the new action matrix
- end-to-end smoke tests for:
  - edit -> commit -> promote
  - repo advances in another env -> auto-merge on promote
  - merge conflict -> conflict state -> reset path

## Explicit Defaults

- squash-only persistence across restarts
- Tiller-first UX labels instead of raw git terminology
- ship both backends in the first release
- auto-merge on promote when the repo moved ahead
- auto-start stopped envs for git actions
- uncommitted working tree changes block promote and update-branch

## Non-Goals

- converting canonical repo storage to native git worktrees
- persisting full `.git` in WorkspaceDO or R2
- multi-user branch permissions
- preserving full local commit history across restarts
