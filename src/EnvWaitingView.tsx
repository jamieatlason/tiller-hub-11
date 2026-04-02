import { useState, useEffect, useRef } from "react";
import type { EnvMeta } from "../api/types";
import { stopEnv, deleteEnv } from "./api";

const STATUS_COLORS: Record<string, string> = {
  started: "bg-green-500",
  running: "bg-green-500",
  starting: "bg-yellow-400 animate-pulse",
  stopping: "bg-yellow-400 animate-pulse",
  creating: "bg-blue-400 animate-pulse",
  deleting: "bg-red-400 animate-pulse",
  stopped: "bg-[#d0d7de]",
  created: "bg-blue-400",
  destroyed: "bg-red-400",
  failed: "bg-red-500",
};

const STATUS_LABELS: Record<string, string> = {
  started: "Running",
  running: "Running",
  starting: "Starting...",
  stopping: "Stopping...",
  creating: "Creating...",
  deleting: "Deleting...",
  stopped: "Stopped",
  created: "Created",
  destroyed: "Destroyed",
  failed: "Failed",
  unknown: "Unknown",
};

interface EnvWaitingViewProps {
  env: EnvMeta;
  hubUrl: string;
  onAction?: () => void;
  onDeleted?: (slug: string) => void;
  onStatusChange?: (slug: string, status: string) => void;
  onStartRequest?: (slug: string) => void;
}

export default function EnvWaitingView({ env, hubUrl, onAction, onDeleted, onStatusChange, onStartRequest }: EnvWaitingViewProps) {
  const [busy, setBusy] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);

  const status = env.status || "unknown";
  const isCreating = status === "creating";
  const isStarting = status === "starting";
  const isRunning = status === "started" || status === "running";
  const isStopping = status === "stopping";
  const isDeleting = status === "deleting";
  const isFailed = status === "failed";
  const isStopped = status === "stopped" || status === "unknown" || isFailed;
  const dotColor = STATUS_COLORS[status] || "bg-[#d0d7de]";
  const label = STATUS_LABELS[status] || status;

  // Accumulate boot log entries as bootMessage changes
  const [bootLog, setBootLog] = useState<{ time: string; msg: string }[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (env.bootMessage) {
      const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setBootLog((prev) => {
        // Deduplicate consecutive identical messages
        if (prev.length > 0 && prev[prev.length - 1].msg === env.bootMessage) return prev;
        return [...prev, { time, msg: env.bootMessage! }];
      });
    }
  }, [env.bootMessage]);

  // Clear log on stop/destroy
  useEffect(() => {
    if (isStopped) setBootLog([]);
  }, [isStopped]);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bootLog]);

  // Track elapsed seconds while starting/running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isStarting && !isRunning) { setElapsed(0); return; }
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isStarting, isRunning]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      console.error("[tiller] env action failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const canShowTerminal = isStarting || isRunning;
  const terminalUrl = `${hubUrl}/api/envs/${env.slug}/terminal`;
  const authBadgeClass = env.resolvedAuthMode === "api"
    ? "border-amber-200 bg-amber-50 text-amber-700"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
  const authLabel = env.resolvedAuthMode === "api"
    ? (env.authMode === "api" ? "api" : "api fallback")
    : "subscription";

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-[#d0d7de] flex items-center justify-between bg-[#f6f8fa]">
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#24292f]">{env.slug}</h2>
              <span className="rounded border border-[#d0d7de] bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#57606a]">
                {env.backend || "cf"}
              </span>
              {env.resolvedAuthMode && (
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${authBadgeClass}`}>
                  {authLabel}
                </span>
              )}
            </div>
            <p className="text-xs text-[#0969da]">
              {env.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
            </p>
            <p className="mt-0.5 text-[11px] text-[#57606a]">
              Plan: {env.startupPlanId ? "Selected" : "None"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canShowTerminal && (
            <button
              onClick={() => setShowTerminal((v) => !v)}
              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                showTerminal
                  ? "border-[#0969da] bg-[#ddf4ff] text-[#0969da]"
                  : "border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a]"
              }`}
            >
              {showTerminal ? "Hide Terminal" : "Debug Terminal"}
            </button>
          )}
          {isStopped && (
            <button
              onClick={() => onStartRequest?.(env.slug)}
              disabled={busy}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40 transition-colors"
            >
              Start
            </button>
          )}
          {isRunning && (
            <button
              onClick={() => run(async () => {
                const res = await stopEnv(hubUrl, env.slug);
                onStatusChange?.(env.slug, res.status);
              })}
              disabled={busy}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40 transition-colors"
            >
              Stop
            </button>
          )}
          {!isDeleting && (
            <button
              onClick={async () => {
                if (confirm(`Delete environment "${env.slug}"? This will destroy the container and wipe R2 storage.`)) {
                  setBusy(true);
                  try {
                    await deleteEnv(hubUrl, env.slug);
                    onStatusChange?.(env.slug, "deleting");
                  } catch (err) {
                    console.error("[tiller] delete failed:", err);
                    alert("Failed to delete environment. Please try again.");
                  } finally {
                    setBusy(false);
                  }
                }
              }}
              disabled={busy}
              className="text-xs px-2.5 py-1 rounded border border-red-200 bg-white hover:bg-red-50 text-red-600 disabled:opacity-40 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {env.authWarning && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2">
          <p className="text-xs text-amber-800">{env.authWarning}</p>
        </div>
      )}

      {/* Debug terminal (full-height iframe to ttyd) */}
      {showTerminal && canShowTerminal && (
        <div className="flex-1 flex flex-col border-b border-[#d0d7de]">
          <div className="px-3 py-1.5 bg-[#161b22] flex items-center justify-between">
            <span className="text-xs text-[#8b949e] font-mono">ttyd @ {env.slug}</span>
            <a
              href={terminalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#58a6ff] hover:underline"
            >
              Open in new tab
            </a>
          </div>
          <iframe
            src={terminalUrl}
            className="flex-1 w-full bg-[#0d1117] min-h-[400px]"
            title={`Debug terminal for ${env.slug}`}
          />
        </div>
      )}

      {/* Main content (only show when terminal is hidden) */}
      {!showTerminal && (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="text-center w-full max-w-lg px-4">
            <div className="flex items-center justify-center gap-2 mb-3">
              <span className={`w-3 h-3 rounded-full ${dotColor}`} />
              <span className="text-sm font-medium text-[#24292f]">{label}</span>
              {(isStarting || isRunning) && (
                <span className="text-xs text-[#8b949e]">{elapsed}s</span>
              )}
            </div>

            {isCreating && (
              <div className="flex flex-col items-center gap-3">
                <Spinner />
                <p className="text-sm text-[#57606a]">Creating container...</p>
              </div>
            )}

            {(isStarting || isRunning) && (
              <div className="flex flex-col items-center gap-3 w-full">
                <Spinner />
                <p className="text-sm text-[#57606a]">
                  {env.bootMessage || (isStarting ? "Container is booting..." : "Waiting for tiller-cli to connect...")}
                </p>
              </div>
            )}

            {isStopping && (
              <div className="flex flex-col items-center gap-3">
                <Spinner />
                <p className="text-sm text-[#57606a]">Container is shutting down...</p>
              </div>
            )}

            {isDeleting && (
              <div className="flex flex-col items-center gap-3">
                <Spinner />
                <p className="text-sm text-[#57606a]">Destroying container and cleaning up storage...</p>
              </div>
            )}

            {isStopped && (
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm text-[#57606a]">
                  {isFailed ? "Container action failed. You can retry." : "Container is stopped"}
                </p>
                <button
                  onClick={() => onStartRequest?.(env.slug)}
                  className="text-sm px-4 py-1.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#24292f] font-medium disabled:opacity-40 transition-colors"
                >
                  Start Container
                </button>
              </div>
            )}

            {/* Boot log */}
            {bootLog.length > 0 && (isStarting || isRunning) && (
              <div className="mt-4 w-full text-left bg-[#161b22] rounded-md border border-[#30363d] overflow-hidden">
                <div className="px-3 py-1.5 border-b border-[#30363d] flex items-center justify-between">
                  <span className="text-xs text-[#8b949e]">Boot Log</span>
                  <span className="text-xs text-[#8b949e]">{bootLog.length} entries</span>
                </div>
                <div className="px-3 py-2 max-h-48 overflow-y-auto font-mono text-xs leading-5">
                  {bootLog.map((entry, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-[#484f58] shrink-0 select-none">{entry.time}</span>
                      <span className={
                        entry.msg.includes("FAILED") || entry.msg.includes("error")
                          ? "text-[#f85149]"
                          : entry.msg.includes("running") || entry.msg.includes("OK") || entry.msg.includes("synced") || entry.msg.includes("written") || entry.msg.includes("connected")
                          ? "text-[#3fb950]"
                          : "text-[#c9d1d9]"
                      }>
                        {entry.msg}
                      </span>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-[#57606a]" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
