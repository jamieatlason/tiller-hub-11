FROM ubuntu:24.04

# --- Layer 1: System deps (rarely changes) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (Claude Code requires modern Node)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ttyd (web terminal fallback)
RUN curl -Lo /usr/local/bin/ttyd \
    https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd

# --- Layer 2: User + env setup (rarely changes) ---
RUN useradd -m -s /bin/bash claude \
    && mkdir -p /home/claude/.claude \
    && echo '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true,"projects":{"/workspace":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true,"allowedTools":[]}}}' > /home/claude/.claude.json \
    && echo '{"skipDangerousModePermissionPrompt":true}' > /home/claude/.claude/settings.json \
    && chown -R claude:claude /home/claude/.claude /home/claude/.claude.json \
    && mkdir -p /workspace && chown claude:claude /workspace

ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV DISABLE_AUTOUPDATER=1

# --- Layer 3: Claude Code CLI (changes on CLI releases) ---
RUN npm install -g @anthropic-ai/claude-code@2.1.87

# --- Layer 4: tiller-cli (changes on version bumps) ---
# Uses @homebridge/node-pty-prebuilt-multiarch — no build tools needed
RUN --mount=type=secret,id=GITHUB_TOKEN \
    echo "@paperwing-dev:registry=https://npm.pkg.github.com" > /root/.npmrc \
    && echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/GITHUB_TOKEN)" >> /root/.npmrc \
    && npm install -g @paperwing-dev/tiller-cli@0.3.0 \
    && rm /root/.npmrc

# --- Layer 5: App files (changes most often) ---
COPY workspace-sync.mjs /workspace-sync.mjs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7681
ENTRYPOINT ["/entrypoint.sh"]
