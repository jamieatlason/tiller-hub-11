#!/usr/bin/env node
// workspace-sync.mjs — Container ↔ Workspace DO sync via public API
// Replaces rclone. Uses manifest-diff for incremental sync, tar for initial download.
//
// Usage:
//   node /workspace-sync.mjs down   — sync DO → local /workspace
//   node /workspace-sync.mjs up     — sync local /workspace → DO

// Fix Node.js 22 undici IPv6/Happy Eyeballs hang (nodejs/node#56204).
// Reduces auto-select family timeout so IPv4 fallback happens quickly.
import { setDefaultAutoSelectFamilyAttemptTimeout, getDefaultAutoSelectFamily, getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
setDefaultAutoSelectFamilyAttemptTimeout(100);

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";

// ── Config ────────────────────────────────────────────────────────────

const WORKSPACE = "/workspace";
const MANIFEST_CACHE = "/tmp/.workspace-manifest.json";
const LAST_SYNC = "/tmp/.last-sync";
const CURL_TMP = "/tmp/.sync-curl-body";

const HUB_URL = process.env.HUB_URL;
const SLUG = process.env.REPO_SLUG;
const CF_ID = process.env.CF_ACCESS_CLIENT_ID;
const CF_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

const EXCLUDES = ["node_modules", ".git/objects", "__pycache__", ".DS_Store", ".terraform", "vendor", "dist", ".next", "build"];
const FETCH_TIMEOUT_MS = 30_000;

if (!HUB_URL || !SLUG) {
  console.error("[sync] HUB_URL and REPO_SLUG are required");
  process.exit(1);
}

const API_BASE = `${HUB_URL}/api/workspace/${SLUG}`;

// ── Networking ───────────────────────────────────────────────────────

function authHeaders() {
  if (!CF_ID || !CF_SECRET) return {};
  return { "CF-Access-Client-Id": CF_ID, "CF-Access-Client-Secret": CF_SECRET };
}

/** Log network diagnostics — called once on first fetch failure */
let _diagRan = false;
async function logDiagnostics(fetchErr) {
  if (_diagRan) return;
  _diagRan = true;

  const hostname = new URL(HUB_URL).hostname;
  console.error(`[diag] fetch failed: ${fetchErr.name}: ${fetchErr.message}`);
  console.error(`[diag] Node.js ${process.version}, autoSelectFamily=${getDefaultAutoSelectFamily()}, timeout=${getDefaultAutoSelectFamilyAttemptTimeout()}ms`);
  console.error(`[diag] NODE_OPTIONS=${process.env.NODE_OPTIONS || "(unset)"}`);

  try {
    const result = await lookup(hostname, { all: true });
    console.error(`[diag] DNS ${hostname} →`, result.map(r => `${r.address} (IPv${r.family})`).join(", "));
  } catch (err) {
    console.error(`[diag] DNS lookup failed:`, err.message);
  }
}

/** curl fallback — returns a fetch-like response object */
function curlFetch(url, opts = {}) {
  const method = opts.method || "GET";
  const timeout = Math.ceil((opts.timeoutMs || FETCH_TIMEOUT_MS) / 1000);

  const args = ["-s", "--max-time", String(timeout), "--retry", "3", "-o", CURL_TMP, "-w", "%{http_code}"];
  if (method !== "GET") args.push("-X", method);

  const headers = opts.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }

  if (opts.body) args.push("--data-raw", opts.body);
  args.push(url);

  const statusStr = execFileSync("curl", args, {
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  }).trim();

  const status = parseInt(statusStr, 10);
  const bodyBuffer = readFileSync(CURL_TMP);

  return {
    ok: status >= 200 && status < 300,
    status,
    json() { return JSON.parse(bodyBuffer.toString("utf-8")); },
    text() { return bodyBuffer.toString("utf-8"); },
    get body() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bodyBuffer));
          controller.close();
        },
      });
    },
  };
}

/**
 * Resilient HTTP fetch: try native fetch first, on failure log diagnostics
 * once and fall back to curl so the container always boots.
 */
async function safeFetch(url, opts = {}) {
  const label = `${opts.method || "GET"} ${url.replace(API_BASE, "")}`;
  const start = Date.now();
  console.log(`[sync] → ${label}`);

  // Try native fetch
  try {
    const { timeoutMs, ...fetchOpts } = opts;
    const resp = await fetch(url, {
      ...fetchOpts,
      signal: AbortSignal.timeout(timeoutMs || FETCH_TIMEOUT_MS),
    });
    console.log(`[sync] ← ${label} ${resp.status} (${Date.now() - start}ms)`);
    return resp;
  } catch (fetchErr) {
    const elapsed = Date.now() - start;
    console.error(`[sync] ✗ ${label} fetch failed after ${elapsed}ms: ${fetchErr.name}: ${fetchErr.message}`);
    await logDiagnostics(fetchErr);
  }

  // Fallback to curl
  try {
    console.log(`[sync] ↻ ${label} retrying with curl...`);
    const resp = curlFetch(url, opts);
    console.log(`[sync] ← ${label} ${resp.status} via curl (${Date.now() - start}ms)`);
    return resp;
  } catch (curlErr) {
    console.error(`[sync] ✗ ${label} curl also failed: ${curlErr.message}`);
    throw curlErr;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function isExcluded(relPath) {
  return EXCLUDES.some((ex) => relPath.includes(ex));
}

/** Walk local workspace and return { path → { size, mtimeMs } } */
function walkLocal(dir, base = dir) {
  const result = {};
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = "/" + relative(base, full);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      Object.assign(result, walkLocal(full, base));
    } else if (entry.isFile()) {
      const st = statSync(full);
      result[rel] = { size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return result;
}

/** Find files modified after a given timestamp */
function findModifiedSince(sinceMs) {
  const local = walkLocal(WORKSPACE);
  const changed = [];
  for (const [path, info] of Object.entries(local)) {
    if (info.mtimeMs > sinceMs) changed.push(path);
  }
  return { local, changed };
}

// ── Tar extraction (same approach as DO-side initFromTarball) ─────────

async function extractTar(stream) {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let fileCount = 0;
  const decoder = new TextDecoder();

  function append(existing, chunk) {
    const merged = new Uint8Array(existing.length + chunk.length);
    merged.set(existing);
    merged.set(chunk, existing.length);
    return merged;
  }

  while (true) {
    // Read at least 512 bytes for header
    while (buffer.length < 512) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = append(buffer, value);
    }
    if (buffer.length < 512) break;

    const header = buffer.slice(0, 512);
    if (header.every((b) => b === 0)) break;

    const rawName = decoder.decode(header.slice(0, 100)).replace(/\0.*$/, "");
    const sizeOctal = decoder.decode(header.slice(124, 136)).replace(/\0.*$/, "").trim();
    const typeFlag = decoder.decode(header.slice(156, 157));
    const prefix = decoder.decode(header.slice(345, 500)).replace(/\0.*$/, "");

    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const paddedSize = Math.ceil(size / 512) * 512;

    buffer = buffer.slice(512);

    // Read content
    while (buffer.length < paddedSize) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = append(buffer, value);
    }

    const content = buffer.slice(0, size);
    buffer = buffer.slice(paddedSize);

    // Skip directories and special entries
    if (typeFlag === "5" || typeFlag === "g" || typeFlag === "x") continue;
    if (size === 0 && rawName.endsWith("/")) continue;

    // Path from tar is workspace-relative (no leading prefix to strip)
    const wsPath = fullName.startsWith("/") ? fullName : "/" + fullName;
    const localPath = join(WORKSPACE, wsPath);

    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, content);
    fileCount++;
  }

  return fileCount;
}

// ── sync_down ─────────────────────────────────────────────────────────

async function syncDown() {
  console.log(`[sync] syncDown starting — API_BASE=${API_BASE}`);

  // Fetch remote manifest
  const manifestResp = await safeFetch(`${API_BASE}/manifest`, { headers: authHeaders() });
  if (!manifestResp.ok) {
    console.error(`[sync] Failed to fetch manifest: ${manifestResp.status} ${await manifestResp.text().catch(() => "")}`);
    process.exit(1);
  }
  const remoteManifest = await manifestResp.json();
  console.log(`[sync] Manifest: ${remoteManifest.length} remote files`);

  if (remoteManifest.length === 0) {
    console.log("[sync] Remote workspace is empty, nothing to sync down");
    writeFileSync(MANIFEST_CACHE, "[]");
    return;
  }

  // Check if local workspace is empty
  const localFiles = walkLocal(WORKSPACE);
  const localCount = Object.keys(localFiles).length;
  console.log(`[sync] Local workspace: ${localCount} files`);

  if (localCount === 0) {
    // First boot: download tar
    console.log(`[sync] Initial sync: downloading ${remoteManifest.length} files as tar...`);
    const tarResp = await safeFetch(`${API_BASE}/download`, {
      headers: authHeaders(),
      timeoutMs: 60_000, // tar can be large
    });
    if (!tarResp.ok || !tarResp.body) {
      console.error(`[sync] Failed to download tar: ${tarResp.status} ${await tarResp.text().catch(() => "")}`);
      process.exit(1);
    }
    const count = await extractTar(tarResp.body);
    console.log(`[sync] Extracted ${count} files to ${WORKSPACE}`);
  } else {
    // Restart: diff and download only changed files
    console.log(`[sync] Incremental sync: ${localCount} local, ${remoteManifest.length} remote`);

    const toDownload = [];
    const remoteByPath = new Map(remoteManifest.map((f) => [f.path, f]));

    for (const [path, remote] of remoteByPath) {
      const local = localFiles[path];
      if (!local || local.size !== remote.size || local.mtimeMs < remote.mtime) {
        toDownload.push(path);
      }
    }

    // Delete local files not in remote manifest
    let deletedCount = 0;
    for (const path of Object.keys(localFiles)) {
      if (!remoteByPath.has(path)) {
        const localPath = join(WORKSPACE, path);
        try { unlinkSync(localPath); deletedCount++; } catch { /* ignore */ }
      }
    }
    if (deletedCount > 0) console.log(`[sync] Deleted ${deletedCount} stale local files`);

    if (toDownload.length > 0) {
      console.log(`[sync] Downloading ${toDownload.length} changed files...`);
      for (let i = 0; i < toDownload.length; i += 50) {
        const batch = toDownload.slice(i, i + 50);
        console.log(`[sync] Batch ${Math.floor(i / 50) + 1}: ${batch.length} files`);
        try {
          const resp = await safeFetch(`${API_BASE}/files`, {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ paths: batch }),
          });
          if (!resp.ok) {
            console.error(`[sync] Batch read failed: ${resp.status} ${await resp.text().catch(() => "")}`);
            continue;
          }
          const { files } = await resp.json();
          for (const f of files) {
            if (f.content === null) continue;
            const localPath = join(WORKSPACE, f.path);
            mkdirSync(dirname(localPath), { recursive: true });
            writeFileSync(localPath, f.content, "utf-8");
          }
        } catch (err) {
          console.error(`[sync] Batch ${Math.floor(i / 50) + 1} error:`, err.message);
        }
      }
    } else {
      console.log("[sync] No changed files to download");
    }
  }

  // Cache manifest for sync_up diffing
  writeFileSync(MANIFEST_CACHE, JSON.stringify(remoteManifest));
  touchLastSync();
  console.log("[sync] syncDown complete");
}

// ── sync_up ───────────────────────────────────────────────────────────

async function syncUp() {
  const lastSyncMs = getLastSyncMs();
  const { local, changed } = findModifiedSince(lastSyncMs);

  // Load cached manifest to detect deletions
  let cachedManifest = [];
  try {
    cachedManifest = JSON.parse(readFileSync(MANIFEST_CACHE, "utf-8"));
  } catch { /* no cache yet */ }

  const localPaths = new Set(Object.keys(local));
  const deleted = cachedManifest
    .map((f) => f.path)
    .filter((p) => !localPaths.has(p));

  if (changed.length === 0 && deleted.length === 0) {
    console.log("[sync] No changes to sync up");
    return;
  }

  // Upload changed files in batches of 50
  if (changed.length > 0) {
    console.log(`[sync] Uploading ${changed.length} changed files...`);
    for (let i = 0; i < changed.length; i += 50) {
      const batch = changed.slice(i, i + 50);
      const files = batch.map((path) => {
        const localPath = join(WORKSPACE, path);
        const content = readFileSync(localPath, "utf-8");
        return { path, content };
      });

      try {
        const resp = await safeFetch(`${API_BASE}/write`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ files }),
        });
        if (!resp.ok) {
          console.error(`[sync] Batch write failed: ${resp.status}`);
        }
      } catch (err) {
        console.error(`[sync] Batch write error:`, err.message);
      }
    }
  }

  // Delete removed files
  if (deleted.length > 0) {
    console.log(`[sync] Deleting ${deleted.length} removed files...`);
    try {
      const resp = await safeFetch(`${API_BASE}/delete`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ paths: deleted }),
      });
      if (!resp.ok) {
        console.error(`[sync] Batch delete failed: ${resp.status}`);
      }
    } catch (err) {
      console.error(`[sync] Batch delete error:`, err.message);
    }
  }

  // Update cached manifest with current local state
  const newManifest = Object.entries(local).map(([path, info]) => ({
    path,
    size: info.size,
    mtime: info.mtimeMs,
  }));
  writeFileSync(MANIFEST_CACHE, JSON.stringify(newManifest));
  touchLastSync();
  console.log(`[sync] Sync up complete: ${changed.length} written, ${deleted.length} deleted`);
}

// ── Timestamp helpers ─────────────────────────────────────────────────

function touchLastSync() {
  writeFileSync(LAST_SYNC, Date.now().toString());
}

function getLastSyncMs() {
  try {
    return parseInt(readFileSync(LAST_SYNC, "utf-8"), 10);
  } catch {
    return 0; // Full scan on first sync
  }
}

// ── Main ──────────────────────────────────────────────────────────────

const command = process.argv[2];
if (command === "down") {
  await syncDown().catch((err) => {
    console.error("[sync] syncDown crashed:", err);
    process.exit(1);
  });
} else if (command === "up") {
  await syncUp().catch((err) => {
    console.error("[sync] syncUp crashed:", err);
    process.exit(1);
  });
} else {
  console.error("Usage: node workspace-sync.mjs <down|up>");
  process.exit(1);
}
