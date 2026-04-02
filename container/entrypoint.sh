#!/bin/bash
set -e

# --- Boot progress reporting (fire-and-forget) ---
report_progress() {
  local msg="$1"
  echo "[boot] $msg"
  if [ -n "$HUB_URL" ] && [ -n "$REPO_SLUG" ]; then
    # Escape quotes/backslashes/newlines so the JSON body is always valid
    local safe
    safe=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
    local http_code
    http_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      "${HUB_URL}/api/envs/${REPO_SLUG}/boot-progress" \
      -H "Content-Type: application/json" \
      -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
      -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
      -d "{\"message\": \"${safe}\"}" \
      --max-time 5 2>/dev/null) || http_code="curl_error"
    if [ "$http_code" != "200" ]; then
      echo "[boot] progress report failed: ${msg} (HTTP ${http_code})"
    fi
  fi
}

# --- Git auth for private repos ---
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

sync_down() {
  echo "Syncing workspace DO → /workspace..."
  node /workspace-sync.mjs down
}

sync_up() {
  echo "Syncing /workspace → workspace DO..."
  node /workspace-sync.mjs up
}

PERIODIC_PID=""
TTYD_PID=""
TILLER_PID=""
WATCHDOG_PID=""
CLEANING_UP=false

# Log file for tiller-cli output (readable from ttyd for debugging)
TILLER_LOG="/tmp/tiller-cli.log"

cleanup() {
  # Guard against re-entry (SIGTERM during cleanup)
  if $CLEANING_UP; then return; fi
  CLEANING_UP=true

  echo "Shutting down..."
  [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null
  [ -n "$TILLER_PID" ] && kill "$TILLER_PID" 2>/dev/null && wait "$TILLER_PID" 2>/dev/null
  [ -n "$PERIODIC_PID" ] && kill "$PERIODIC_PID" 2>/dev/null && wait "$PERIODIC_PID" 2>/dev/null

  # Final sync with timeout — don't hang on shutdown
  # (timeout can't call bash functions, so we invoke node directly here)
  echo "Syncing before exit (30s timeout)..."
  timeout 30 node /workspace-sync.mjs up || echo "[tiller] shutdown sync failed or timed out (exit $?)"

  [ -n "$TTYD_PID" ] && kill "$TTYD_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

# --- Step 1/6: Workspace sync (non-fatal — boot with empty workspace beats not booting) ---
report_progress "Step 1/6: Syncing workspace..."
sync_rc=0
sync_down || sync_rc=$?
if [ $sync_rc -ne 0 ]; then
  echo "[boot] WARNING: sync_down failed (exit $sync_rc), continuing with empty workspace"
  report_progress "Step 1/6: Sync failed (non-fatal), continuing..."
else
  report_progress "Step 1/6: Workspace synced"
fi

# sync_down runs as root — fix ownership so claude user can write
chown -R claude:claude /workspace

# --- Step 2/6: Upgrade tiller-cli (if TILLER_CLI_VERSION is set) ---
if [ -n "$TILLER_CLI_VERSION" ]; then
  report_progress "Step 2/6: Upgrading tiller-cli to $TILLER_CLI_VERSION..."
  echo "@paperwing-dev:registry=https://npm.pkg.github.com" > /tmp/.npmrc
  echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> /tmp/.npmrc
  if NODE_OPTIONS="--dns-result-order=ipv4first" HOME=/tmp npm install -g "@paperwing-dev/tiller-cli@${TILLER_CLI_VERSION}" 2>&1; then
    if [ -x /usr/bin/tiller-cli ]; then
      ln -sf /usr/bin/tiller-cli /usr/local/bin/tiller-cli
      echo "[boot] tiller-cli shim updated to /usr/bin/tiller-cli"
    fi
    report_progress "Step 2/6: tiller-cli upgraded to $TILLER_CLI_VERSION"
  else
    report_progress "Step 2/6: Upgrade failed, using baked version"
  fi
  rm -f /tmp/.npmrc
else
  report_progress "Step 2/6: Using baked tiller-cli"
fi

# --- Step 3/6: Background services ---
report_progress "Step 3/6: Starting background services..."

# Periodic sync every 5 min (resilient — one failure doesn't kill the loop)
(
  while true; do
    sleep 300
    sync_up || echo "[tiller] periodic sync failed (exit $?), will retry in 5m"
  done
) &
PERIODIC_PID=$!

# ttyd (web terminal fallback)
ttyd -p 7681 bash &
TTYD_PID=$!

report_progress "Step 3/6: Services started (ttyd on :7681)"

# --- Step 4/6: Pre-accept Claude Code dialogs ---
report_progress "Step 4/6: Writing Claude Code settings..."

# bypassPermissionsModeAccepted in .claude.json: the field CC checks to skip the
#   "type YES" confirmation when --dangerously-skip-permissions is passed.
# skipDangerousModePermissionPrompt in settings.json: belt-and-suspenders.
# Written at runtime as `claude` user to guarantee correct file ownership.
settings_rc=0
runuser -u claude -- sh -c '
  echo "{\"hasCompletedOnboarding\":true,\"bypassPermissionsModeAccepted\":true,\"projects\":{\"/workspace\":{\"hasTrustDialogAccepted\":true,\"hasCompletedProjectOnboarding\":true,\"allowedTools\":[]}}}" > /home/claude/.claude.json
  echo "{\"skipDangerousModePermissionPrompt\":true}" > /home/claude/.claude/settings.json
  mkdir -p /workspace/.claude
  echo "{\"skipDangerousModePermissionPrompt\":true}" > /workspace/.claude/settings.local.json
' || settings_rc=$?
if [ $settings_rc -ne 0 ]; then
  report_progress "Step 4/6: Settings write FAILED (exit $settings_rc)"
else
  report_progress "Step 4/6: Settings written"
fi

# --- Step 5/6: Verify prerequisites ---
report_progress "Step 5/6: Verifying prerequisites..."

# Check claude binary exists
if ! runuser -u claude -- sh -c 'which claude' >/dev/null 2>&1; then
  report_progress "Step 5/6: FAILED — claude binary not found in PATH"
  echo "[boot] ERROR: claude binary not found. Container will stay up for ttyd debugging."
  wait
  exit 1
fi
CLAUDE_VERSION=$(runuser -u claude -- sh -c 'claude --version 2>/dev/null || echo unknown')
echo "[boot] Claude Code version: $CLAUDE_VERSION"

# Check tiller-cli binary exists
if ! runuser -u claude -- sh -c 'which tiller-cli' >/dev/null 2>&1; then
  report_progress "Step 5/6: FAILED — tiller-cli binary not found in PATH"
  echo "[boot] ERROR: tiller-cli not found. Container will stay up for ttyd debugging."
  wait
  exit 1
fi

# Check required env vars
missing=""
[ -z "$HUB_URL" ] && missing="$missing HUB_URL"
[ -z "$REPO_SLUG" ] && missing="$missing REPO_SLUG"
[ -z "$CF_ACCESS_CLIENT_ID" ] && missing="$missing CF_ACCESS_CLIENT_ID"
[ -z "$CF_ACCESS_CLIENT_SECRET" ] && missing="$missing CF_ACCESS_CLIENT_SECRET"
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  missing="$missing CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY"
fi
if [ -n "$missing" ]; then
  report_progress "Step 5/6: FAILED — missing env vars:$missing"
  echo "[boot] ERROR: Missing required env vars:$missing"
  echo "[boot] Container will stay up for ttyd debugging."
  wait
  exit 1
fi

if [ -n "$TILLER_CLAUDE_AUTH_WARNING" ]; then
  report_progress "Step 5/6: WARNING — $TILLER_CLAUDE_AUTH_WARNING"
  echo "[boot] WARNING: $TILLER_CLAUDE_AUTH_WARNING"
elif [ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "subscription" ]; then
  report_progress "Step 5/6: Claude auth ready — subscription token"
  echo "[boot] Claude auth: subscription token"
elif [ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "api" ]; then
  report_progress "Step 5/6: Claude auth ready — Anthropic API key"
  echo "[boot] Claude auth: Anthropic API key"
fi

report_progress "Step 5/6: Prerequisites OK (claude $CLAUDE_VERSION)"

# --- Step 6/6: Launch tiller-cli ---
report_progress "Step 6/6: Launching tiller-cli..."

if [ -n "$HUB_URL" ]; then
  cd /workspace

  # Detect plan file written by research LLM
  PLAN_FILE="${PLAN_FILE:-/workspace/.tiller/plan.md}"

  if [ -s "$PLAN_FILE" ]; then
    report_progress "Step 6/6: Plan file detected, launching with plan..."
    runuser -u claude -- env HOME=/home/claude tiller-cli "$REPO_SLUG" --skip-permissions --cwd /workspace --plan-file "$PLAN_FILE" > >(tee -a "$TILLER_LOG") 2>&1 &
  else
    runuser -u claude -- env HOME=/home/claude tiller-cli "$REPO_SLUG" --skip-permissions --cwd /workspace > >(tee -a "$TILLER_LOG") 2>&1 &
  fi
  TILLER_PID=$!
  echo "[boot] tiller-cli started (PID $TILLER_PID), log at $TILLER_LOG"

  # --- Watchdog: monitor tiller-cli startup and report status ---
  # Runs in a subshell — cannot `wait` on TILLER_PID (sibling, not child),
  # so we use `kill -0` to check liveness and read /tmp/tiller-exit for the code.
  (
    log_last_line() {
      if [ -f "$TILLER_LOG" ]; then
        tail -5 "$TILLER_LOG" | head -1 | head -c 300
      fi
    }

    # Give tiller-cli a few seconds to start, then check if still alive
    sleep 3
    if ! kill -0 "$TILLER_PID" 2>/dev/null; then
      exit_code=$(cat /tmp/tiller-exit 2>/dev/null || echo "?")
      report_progress "Step 6/6: tiller-cli CRASHED on startup (exit $exit_code)"
      report_progress "tiller-cli error: $(log_last_line)"
      exit 0
    fi

    # Poll for session establishment + Claude output
    for i in $(seq 1 24); do
      sleep 5
      if ! kill -0 "$TILLER_PID" 2>/dev/null; then
        exit_code=$(cat /tmp/tiller-exit 2>/dev/null || echo "?")
        report_progress "Step 6/6: tiller-cli exited early (exit $exit_code)"
        report_progress "tiller-cli last output: $(log_last_line)"
        exit 0
      fi

      # Check if session was established
      if grep -q "\[tiller\] Session:" "$TILLER_LOG" 2>/dev/null; then
        report_progress "Step 6/6: tiller-cli connected to hub"

        # Record log size at session time, then wait for Claude to produce output
        log_size_at_session=$(wc -c < "$TILLER_LOG" 2>/dev/null || echo 0)
        for j in $(seq 1 12); do
          sleep 5
          if ! kill -0 "$TILLER_PID" 2>/dev/null; then
            exit_code=$(cat /tmp/tiller-exit 2>/dev/null || echo "?")
            report_progress "tiller-cli exited (exit $exit_code)"
            exit 0
          fi
          log_size_now=$(wc -c < "$TILLER_LOG" 2>/dev/null || echo 0)
          delta=$((log_size_now - log_size_at_session))
          if [ "$delta" -gt 500 ]; then
            report_progress "Claude Code is running"
            exit 0
          fi
        done
        report_progress "Step 6/6: tiller-cli connected but Claude Code may be stuck (no output after 60s)"
        exit 0
      fi
    done

    # After 120s, no session established
    report_progress "Step 6/6: tiller-cli still starting after 120s (may be stuck)"
    report_progress "tiller-cli last output: $(log_last_line)"
  ) &
  WATCHDOG_PID=$!

  # When tiller-cli exits (Claude session ends), sync and shut down.
  wait "$TILLER_PID" 2>/dev/null
  TILLER_EXIT=$?
  echo "$TILLER_EXIT" > /tmp/tiller-exit  # Readable by watchdog subshell
  echo "[boot] tiller-cli exited (code $TILLER_EXIT), shutting down..."
  report_progress "tiller-cli exited (code $TILLER_EXIT)"
  cleanup
else
  report_progress "No HUB_URL set — running ttyd only"
  # No hub — just keep ttyd alive
  wait
fi
