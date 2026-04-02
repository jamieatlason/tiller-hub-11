# Shared Workspace Mode

This document describes a second, separate product mode for `tiller-hub`: a collaborative shared-workspace model that lives alongside the existing isolated-worktree model.

## Problem statement

`tiller-hub` currently supports a "git worktree"-style model:

- each env gets its own isolated workspace snapshot
- agents and sessions operate inside that isolated workspace
- repo state is updated later through an explicit commit-back flow

That model is good for isolated implementation work, but it does not support another workflow the product needs:

- multiple agents and sessions should be able to work against the same repo filesystem
- they should see shared code changes quickly
- they still need real local filesystems so normal tools work
- the user is comfortable with only one runtime publishing writes at a time
- the user wants this collaborative model to work with both local and remote runtimes
- this collaborative model must remain completely separate from the existing isolated-worktree product

The current env model cannot provide that UX because isolated snapshots are the core abstraction. A shared collaborative product needs different primitives:

- one canonical shared repo workspace
- many runtimes with local mirrors of that workspace
- one writer lease at a time
- incremental push and pull sync around a canonical workspace
- no semantic mixing with isolated mode

This document defines that second product: **Shared Workspace Mode**.

## Product boundary

Shared mode and isolated mode are separate products that may reference the same GitHub repo URL but do not share active workspace state.

### Shared Workspace Mode

- one canonical shared workspace per repo
- many runtimes and sessions may attach
- one writer lease at a time
- local mirrors sync with the canonical workspace

### Isolated Worktree Mode

- keep the current env and worktree product
- isolated copies
- explicit commit and reset semantics

### Hard boundary rules

- separate entry point before the app shell
- separate coordination Durable Object
- separate storage prefixes
- separate repo and workspace records
- no automatic crossover between modes
- no shared active files between modes
- if the same repo exists in both modes, that is intentional and they are separate states

## Goals

- add a collaborative "Google Docs for code" product beside the current isolated product
- support both local and remote runtimes
- keep real filesystem-backed runtimes for tool compatibility
- enforce one-writer-at-a-time publishing
- keep the collaborative model understandable and operationally separate

## Non-goals for v1

- multi-writer merge semantics
- automatic merges or conflict resolution
- automatic shared-to-isolated conversion
- branch-aware Git semantics
- syncing dependency, build, or cache directories
- multi-user collaboration across different human accounts

## Scope assumption

V1 is single-user, multi-agent and multi-session collaboration.

That means:

- one authenticated user
- many local and remote runtimes and sessions under that user
- no cross-user authorization model in this phase

## Relevant current seams

The existing codebase already has useful primitives that shared mode can build on.

### Canonical file storage primitive

- `api/workspace/do.ts`
- `api/workspace/routes.ts`

### Presence and websocket coordination pattern

- `api/hub.ts`
- `api/types.ts`

### Existing runtime backends

- `api/env/runner-backend-local.ts`
- `api/env/runner-backend-cf.ts`
- `api/sandbox-do.ts`

### Existing repo-level planning

- `api/plan/store.ts`
- `api/agents/plan-chat-agent.ts`
- `src/PlanView.tsx`

## Chosen architecture

### Canonical file storage

Do not create a new file-storage Durable Object class.

Reuse the existing `WorkspaceDO` class for shared-mode storage, keyed separately, for example:

- `shared-workspace:{repoId}`

This gives shared mode:

- separate file trees from isolated mode
- reuse of existing R2-backed workspace storage
- reuse of tar snapshot and bootstrap behavior
- reuse of file CRUD operations

Large files continue to rely on the underlying workspace abstraction and its R2 backing. No extra blob system is needed in v1.

### Shared coordination Durable Object

Add one new shared-mode coordination Durable Object:

- `SharedHubDO`

This remains separate from the current isolated `HubDO` so the product semantics stay cleanly separated, even if some implementation patterns are similar.

`SharedHubDO` owns:

- shared workspace metadata
- runtime presence
- session presence for shared mode
- writer lease
- change journal
- websocket broadcasting for shared-mode events

### Shared-mode repo workspace model

For a repo in shared mode:

- one canonical workspace in `WorkspaceDO`
- many runtimes with local mirrors
- many sessions attached to those runtimes
- one active writer lease

## Runtime model

A runtime is a compute instance running a sync agent against a local mirror of the shared workspace.

Concrete v1 runtime definition:

- a local or remote compute instance
- with a real local working directory
- running a sync agent
- attached to one shared workspace

A runtime is not just a websocket connection and not just an env copy. It is:

- compute
- local filesystem mirror
- sync agent
- attached sessions

### Runtime metadata

- `runtimeId`
- `workspaceId`
- `backend`
- `status`
- `createdAt`
- `lastSeenAt`
- `localSeq`
- `isWriter`
- `hostLabel`
- `sessionCount`
- `dirtyWithoutLease`

## Writer lease model

Only one runtime may publish file changes to the canonical shared workspace at a time.

### Lease data

- `writerRuntimeId`
- `writerSessionId`
- `acquiredAt`
- `expiresAt`
- `touchedFiles`

### Lease behavior

- explicit acquire
- explicit release
- heartbeat renewal
- expiry on disconnect or missed heartbeat

### Publishing rule

A push is accepted only if:

- the runtime holds the current lease
- the push is based on the current canonical sequence

This prevents stale publishes without introducing multi-writer merge complexity.

## Canonical change journal

The canonical shared workspace needs an ordered mutation log.

Store this journal in SQLite inside `SharedHubDO`, not in the workspace file store.

### Journal entry fields

- `seq`
- `workspaceId`
- `sourceRuntimeId`
- `createdAt`
- `baseSeq`
- `operations`

### Operation fields

- `type` (`write`, `delete`, optional later `move`)
- `path`
- `contentHash`
- `size`
- optional `encoding`
- no large inline content in the journal

The journal stores metadata only. Files remain in the canonical `WorkspaceDO` and R2-backed workspace.

## Sync model

Each runtime has a local mirror for tool compatibility.

### Bootstrap sync

On runtime start:

- fetch full canonical snapshot from the shared workspace
- hydrate local mirror
- set `localSeq = lastChangeSeq`

Use the existing tarball and snapshot pattern for bootstrap.

### Incremental push

If the runtime holds the writer lease:

- watch local filesystem changes
- filter paths
- debounce into batches every `0.5-2s`
- compute hashes
- send push batch with `baseSeq`
- canonical workspace writes changed files
- coordination DO appends journal entry
- `lastChangeSeq` increments
- websocket change event is broadcast

### Incremental pull

Follower runtimes:

- subscribe to websocket change events
- fetch journal entries since `localSeq`
- fetch changed file contents in batch from canonical workspace
- apply them locally
- update `localSeq`

### Idempotency and ordering

A push batch must include:

- `workspaceId`
- `sourceRuntimeId`
- `baseSeq`
- `operations`

If `baseSeq !== currentSeq`, reject and require resync. Because only one writer exists, ordering remains simple.

## File transfer format

Do not fetch each changed file with separate HTTP requests if avoidable.

Use:

- batched file read APIs for changed paths
- journal metadata for sequencing
- file content fetched separately from the canonical workspace, not embedded in journal rows

This supports:

- small text files
- larger text files
- binary files

without bloating the journal.

## Filtering and exclusions

The sync agent must be stricter than raw filesystem watching.

### Exclude by default

- `.git`
- `node_modules`
- `.next`
- `dist`
- `build`
- caches
- temp and editor swap files
- package manager transient directories

### Filtering behavior

- support `.gitignore`-aware filtering where practical
- debounce noisy file watcher events
- use content hashes to avoid loops and redundant writes

This is a product rule, not a later optimization.

## Follower local edits

Decision for v1:

- follower runtimes may technically edit files locally
- but they may not publish without the writer lease

If follower local edits are detected:

- mark the runtime `dirtyWithoutLease`
- pause automatic pull apply for that runtime
- require one of:
  - acquire writer lease and publish
  - discard local changes and resync

This keeps the model safe without pretending followers can collaboratively write at the same time.

## Touched files

Decision:

- touched-files are published automatically by the writer runtime's sync agent
- derived from the current batched changed paths
- advisory only, not enforced locks

This supports the workflow where agents tell other agents what files they are touching.

## Planning in shared mode

Repo-level planning continues in shared mode.

Decision:

- shared mode keeps a repo-level Plan surface
- shared-mode planning reads the canonical shared workspace state
- planning artifacts remain scoped to shared mode, not automatically shared with isolated mode

This preserves the existing planning value while avoiding cross-product ambiguity.

## API and transport design

Use REST for bootstrap and CRUD. Use WebSocket for all real-time collaboration behavior.

### REST

- create and list shared repos
- create and list runtimes
- snapshot fetch
- batch file reads
- initial bootstrap operations

### WebSocket

- runtime and session presence
- writer lease acquire, release, and heartbeat
- workspace changed notifications
- touched-file updates
- resync-required notifications

This should follow the existing realtime pattern but remain in shared-mode coordination, not the current isolated `HubDO`.

## UI and product design

### Entry point

Before entering the product, the user chooses:

- `Shared Workspace`
- `Isolated Worktree`

This is a product switch, not a small toggle.

### Shared-mode shell

Shared mode gets its own top-level route and components.

Recommended route family:

- `/shared/...`

Recommended components:

- `SharedApp`
- `SharedRepoList`
- `SharedWorkspaceView`
- `SharedRuntimeView`
- `SharedSessionView`

Do not reuse the current env surface directly except for low-level presentational primitives if useful.

### Shared repo list

Per repo row:

- repo label
- whether a shared workspace exists
- current writer
- runtime count
- session count

### Shared workspace view

Main panels:

- workspace status
- current writer lease
- touched files
- runtimes
- sessions
- recent changed files
- acquire and release writer button
- resync runtime action

### Shared session view

A session attaches to a runtime. Follower runtimes should clearly indicate:

- read-only sync
- dirty without lease
- waiting for writer

## Bootstrap flow

Shared-mode repo creation should reuse the existing GitHub bootstrap pattern.

Flow:

1. create shared repo record
2. allocate canonical shared workspace key
3. bootstrap from GitHub tarball into the shared `WorkspaceDO`
4. create initial shared workspace metadata in `SharedHubDO`
5. runtime startup fetches this snapshot

No separate bootstrap mechanism is needed.

## Shared-mode routes

Recommended route namespace:

- `/api/shared/...`

### REST endpoints

- `GET /api/shared/repos`
- `POST /api/shared/repos`
- `GET /api/shared/repos/:repoId`
- `POST /api/shared/repos/:repoId/runtimes`
- `GET /api/shared/repos/:repoId/runtimes`
- `GET /api/shared/repos/:repoId/snapshot`
- `GET /api/shared/repos/:repoId/changes?since=...`
- `POST /api/shared/repos/:repoId/files/read-batch`
- `POST /api/shared/repos/:repoId/files/push-batch`
- `POST /api/shared/repos/:repoId/runtimes/:runtimeId/resync`

### WebSocket message types

- `shared-runtime-registered`
- `shared-runtime-updated`
- `shared-session-updated`
- `shared-writer-changed`
- `shared-workspace-changed`
- `shared-runtime-dirty`
- `shared-resync-required`

## Phased implementation plan

### Phase 1: product boundary and shared-mode shell

Goal:

- create a separate shared-mode product surface

Changes:

- entry selector before app shell
- shared-mode routes and frontend shell
- separate shared-mode repo records
- separate shared-mode coordination DO binding

Validation:

- user can enter shared mode without touching isolated-mode state
- the same repo URL may exist in both products independently

### Phase 2: canonical shared workspace storage

Goal:

- create canonical shared file storage using the existing `WorkspaceDO` class with separate keying

Changes:

- shared workspace keying scheme
- shared repo creation and bootstrap from GitHub
- snapshot fetch endpoint
- shared workspace metadata records

Validation:

- shared repo workspace can be created and snapshotted
- no runtime sync yet

### Phase 3: runtime registration and writer lease

Goal:

- make runtimes first-class and enforce one writer

Changes:

- runtime registration
- lease acquire, release, and heartbeat
- runtime and session presence in the shared coordination DO
- websocket lease updates

Validation:

- only one runtime can hold the writer lease
- lease expiry works
- UI reflects writer status

### Phase 4: incremental sync protocol

Goal:

- near-real-time collaboration with one writer

Changes:

- change journal in SQLite
- `changes since seq`
- push-batch API with `baseSeq`
- batched file fetch
- sync agent protocol
- touched-files publication

Validation:

- writer changes appear in followers within a couple seconds
- stale push is rejected
- touched-files update correctly

### Phase 5: dirty follower handling and recovery

Goal:

- make the follower story safe and usable

Changes:

- detect local edits without lease
- mark runtime dirty
- pause pull apply for dirty follower
- add resync, discard, and reacquire-lease actions
- clear UI for `read-only`, `dirty`, and `writer`

Validation:

- follower local edits do not silently corrupt shared state
- user can recover by resync or by taking the lease

### Phase 6: local and remote runtime backends

Goal:

- complete v1 runtime support

Changes:

- local shared runtime adapter
- remote shared runtime adapter
- shared-mode sync agent packaging and lifecycle for both

Validation:

- one local runtime and one remote runtime can attach to the same shared workspace
- writer handoff between local and remote works

## Test scenarios

### Shared product boundary

- the same repo URL exists in shared and isolated modes
- deleting one does not affect the other

### Bootstrap

- a new shared repo bootstraps from GitHub tarball correctly
- a runtime mirror matches the canonical snapshot

### Lease

- one runtime acquires the lease
- a second runtime is denied until release or expiry
- lease changes are visible live

### Sync

- writer edits one file
- follower receives the update within `1-2s`
- journal sequence advances monotonically
- push with stale `baseSeq` is rejected

### Filtering

- excluded directories do not sync
- temp and swap file storms do not create noisy canonical updates

### Follower divergence

- follower local edit marks dirty state
- follower does not publish without the writer lease
- resync clears dirty state

### Planning

- shared-mode Plan reads the canonical shared workspace
- planning artifacts remain in shared-mode scope

## Decisions and defaults

- shared-mode file storage reuses `WorkspaceDO` with a separate key prefix
- shared-mode coordination uses a separate `SharedHubDO`
- journal and lease live in SQLite in the shared coordination DO
- files remain in canonical workspace storage and its R2-backed workspace abstraction
- touched-files are automatic
- repo-level planning continues in shared mode
- v1 is single-user, multi-agent and multi-session
- both local and remote runtimes are in scope
- followers cannot publish without the writer lease
- follower dirty state pauses pull apply until resolved
- no automatic crossover with isolated mode

## Reviewer prompts

Questions still worth refining:

- is one shared coordination DO enough, or is there a compelling reason to split lease and journal from presence later?
- is pausing pull sync on dirty followers the right v1 UX, or should dirty followers be blocked from local writes sooner?
- what is the minimum remote runtime backend that still satisfies the "not only local" requirement without exploding implementation scope?
- should shared-mode planning artifacts remain completely separate from isolated-mode planning artifacts, or should there eventually be explicit import and export between them?
