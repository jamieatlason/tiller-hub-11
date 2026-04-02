# Cloudflare Containers Migration

Migration from Fly.io Machines API to Cloudflare Containers for tiller-hub's sandboxed dev environments. Both backends run in parallel — switch between them with a single env var.

## Why

- **ttyd was publicly exposed with no auth** on Fly (`https://tiller-{slug}.fly.dev` → unauthenticated bash shell)
- **Split-brain state** between KV metadata and Fly API (5 `catch { /* machine may not exist */ }` guards in envs.ts)
- **One fewer vendor** — the hub is already a Cloudflare Worker/DO, so Fly is an external dependency for container lifecycle only

What we kept from Fly: **rclone for workspace persistence**. We evaluated the Sandbox SDK's `createBackup()`/`restoreBackup()` but it creates full snapshots (not incremental). For workspaces where Claude Code constantly edits files, rclone's checksum-based delta sync is better — if 3 files change, rclone uploads 3 files. Additionally, an open R2 read bug (#137, fails >15MB from containers) could break restore for real workspaces.

## How to switch

```bash
# Use Cloudflare Containers
npx wrangler secret put USE_CF_CONTAINERS
# enter: true

# Switch back to Fly
npx wrangler secret delete USE_CF_CONTAINERS
```

Every route in `api/envs.ts` checks `useCfContainers(env)` and branches. The Fly code path is completely unchanged — same `FlyClient` calls, same behavior as before.

**Important:** Environments created on one backend aren't visible to the other. An env created with CF Containers will show "unknown" status if you switch to Fly (and vice versa). Stop/delete existing envs before switching, or test with a fresh env.

## What changed

### New files

| File | Purpose |
|---|---|
| `api/sandbox-do.ts` | Container DO class extending `Container` from `@cloudflare/containers`. RPC methods: `startSandbox(envVars)`, `stopSandbox()`, `destroySandbox()`, `getStatus()`. Uses base class `start()`/`stop()` for lifecycle management (monitor, callbacks, retry). |

### Modified files

| File | What changed |
|---|---|
| `api/envs.ts` | Rewritten with feature flag. Each route (list, create, get, start, stop, delete) branches on `USE_CF_CONTAINERS`. CF path uses `env.SANDBOX.idFromName(slug)` — slug IS the container identity, no separate machine ID. Added `/api/envs/:slug/terminal` proxy route. Extracted shared helpers (`containerEnvVars()`, `getHub()`, `getSandboxStub()`). |
| `api/types.ts` | Added `SANDBOX: DurableObjectNamespace` and `USE_CF_CONTAINERS?: string` to `Env` interface. |
| `api/index.ts` | Added `export { SandboxDO } from "./sandbox-do"` for wrangler. |
| `wrangler.jsonc` | Added `SANDBOX` DO binding, v5 migration (`new_sqlite_classes`), and a commented-out `containers` array (see "Container image" below). |
| `container/Dockerfile` | Removed `openssh-server`, SSH setup (`mkdir /var/run/sshd`), port 22 exposure. Everything else stays (rclone, ttyd, Claude Code, tiller-cli). |
| `container/entrypoint.sh` | Removed SSH block (key setup + sshd launch). Rclone sync, ttyd, tiller-cli, cleanup trap all stay. |
| `package.json` | Added `@cloudflare/containers` dependency. |
| `src/EnvWaitingView.tsx` | "Creating Fly machine..." → "Creating container..." |
| `.github/workflows/tiller-base-image.yml` | Rewritten to build with `--secret` for private npm packages, push to 3 registries. Added `workflow_dispatch` trigger. |

### Not changed

- `api/fly.ts` — stays, used when `USE_CF_CONTAINERS` is unset
- `api/hub.ts` — untouched, still receives WebSocket from tiller-cli
- `container/fly.toml` — stays
- tiller-cli — untouched, connects outbound to hub with CF Access creds
- Web UI (except one string) — untouched
- All `/api/envs/*` endpoint shapes — same request/response contracts

## Container image registries

The GitHub Actions workflow (`.github/workflows/tiller-base-image.yml`) builds the Docker image once and pushes to three registries:

| Registry | Image | Used by |
|---|---|---|
| GHCR | `ghcr.io/paperwing-dev/tiller-base:latest` | Reference / backup |
| Fly | `registry.fly.io/tiller-sandbox:latest` | Fly machines (`BASE_IMAGE` in envs.ts) |
| Cloudflare | `registry.cloudflare.com/<account-id>/tiller-sandbox:latest` | CF Containers (`containers` array in wrangler.jsonc) |

**Triggered by:** push to `packages/tiller-hub/container/**` on `main`, or manual `workflow_dispatch`.

**Required GitHub secrets:**
- `FLY_API_TOKEN` — for Fly registry push (set)
- `CLOUDFLARE_API_TOKEN` — for Cloudflare registry push (needs to be created, see "Remaining setup" below)
- `GITHUB_TOKEN` — automatic, used for GHCR + private npm packages during build

## Container image build

Fly builds remotely (`fly deploy` sends Dockerfile to Fly's builders). Cloudflare Containers builds locally (`wrangler deploy` runs `docker build`). Since Docker isn't installed locally, CI handles the build.

The `containers` array in `wrangler.jsonc` is currently **commented out** because `wrangler deploy` tries to build the image locally. After CI pushes the image to Cloudflare's registry (on merge to main), uncomment it and redeploy.

## Architecture: how the CF Containers path works

```
Web UI ──WebSocket──> Hub DO ──WebSocket──< tiller-cli (in CF Container)
                        │
Worker ──DO RPC──> SandboxDO ──lifecycle──> Container
                        │
                  env.SANDBOX.idFromName(slug)
```

1. `POST /api/envs` → `getSandboxStub(env, slug)` → `stub.startSandbox(envVars)` in background
2. Container starts → entrypoint runs rclone restore → ttyd → tiller-cli
3. tiller-cli connects outbound to Hub DO via WebSocket (same as Fly)
4. `POST /api/envs/:slug/stop` → `stub.stopSandbox()` → SIGTERM → entrypoint rclone sync → exit
5. `POST /api/envs/:slug/terminal` → `stub.fetch(request)` → proxied to ttyd on port 7681 (behind CF Access)

**Key difference from Fly:** slug = container identity. `env.SANDBOX.idFromName(slug)` deterministically maps to a DO — no separate machine ID, no "pending" state, no KV metadata to reconcile with an external API.

## Remaining setup

1. **Create Cloudflare API token** at https://dash.cloudflare.com/profile/api-tokens
   - Use "Edit Cloudflare Workers" template
   - Add Containers write permission
   - Then: `gh secret set CLOUDFLARE_API_TOKEN -R paperwing-dev/paperwing-infrastructure`

2. **Merge to main** — triggers CI which builds + pushes the container image

3. **Uncomment `containers` array** in `wrangler.jsonc` and redeploy:
   ```bash
   npm run deploy:prod
   ```

4. **Test CF Containers:**
   ```bash
   npx wrangler secret put USE_CF_CONTAINERS
   # enter: true
   ```
   Create an environment from the web UI. It should spin up a CF Container instead of a Fly machine.

5. **Switch back to Fly if needed:**
   ```bash
   npx wrangler secret delete USE_CF_CONTAINERS
   ```

## Decisions made during migration

| Decision | Why |
|---|---|
| **Keep rclone** | Claude Code constantly edits files. Incremental sync (only changed files) beats full snapshots. Sandbox SDK's `createBackup()` re-archives the entire workspace every time. |
| **Keep R2 creds in container** | rclone needs S3 API access. Acceptable — creds scoped to tiller R2 bucket. |
| **Keep ttyd** | Works, no need for Sandbox SDK terminal abstraction. |
| **`@cloudflare/containers` not `@cloudflare/sandbox`** | Evaluated Sandbox SDK. Backup is full-snapshot (not incremental). R2 read bug (#137) risks restore failure >15MB. Terminal is nice but ttyd works. Raw Container class gives full Dockerfile control. |
| **Feature flag toggle** | Both infra stay alive. Instant rollback by deleting the secret. |
| **No `sleepAfter`** | Manual lifecycle only. Containers stop when tiller-cli exits or user calls stop. Avoids WebSocket sleep timeout bug (#147). |
| **`new_sqlite_classes` for v5 migration** | Container base class creates a SQLite table (`container_schedules`) in its constructor. Using `new_classes` would cause a runtime error. |

## Known CF Containers beta issues

| Issue | Impact | Mitigation |
|---|---|---|
| [#147](https://github.com/cloudflare/containers/issues/147) WebSocket doesn't renew sleep timeout | Not a blocker — no `sleepAfter` configured | Manual lifecycle |
| [#5996](https://github.com/cloudflare/workerd/issues/5996) 20-30% concurrent start failures | Could affect simultaneous env creation | Single-user system, low risk |
| [#137](https://github.com/cloudflare/containers/issues/137) R2 reads fail >15MB | Could affect rclone restore of large files | rclone transfers many small files, not one blob |
| Host restarts kill containers | Same risk as Fly | SIGTERM + 15 min grace period, rclone sync on shutdown |
