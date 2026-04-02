import { useState, useEffect, useCallback, useRef } from 'react';
import type { StoredSession, StoredPermission } from '../api/types';
import {
  fetchSessions,
  fetchMessages,
  fetchPendingPermissions,
  createReconnectingWebSocket,
  fetchEnvs,
  fetchRepos,
  fetchEnvStatus,
  fetchSetupStatus,
  createEnv,
} from './api';
import type { LiveMessage, ReconnectingWebSocket, EnvMeta, RepoMeta, SetupStatus } from './api';
import {
  applyEnvStatusChange,
  mergeEnvsPreservingBootMessages,
} from './env-state';
import { useToast } from './Toast';
import SessionList from './SessionList';
import SessionView from './SessionView';
import EnvWaitingView from './EnvWaitingView';
import PlanView from './PlanView';
import NewEnvDialog from './NewEnvDialog';
import StartPlanDialog from './StartPlanDialog';
import SettingsPage from './SettingsPage';

const HUB_URL = window.location.origin;
const TERMINAL_STATES = new Set(['started', 'running', 'stopped', 'destroyed', 'failed']);

type Selection =
  | { type: 'none' }
  | { type: 'session'; sessionId: string }
  | { type: 'env'; envSlug: string }
  | { type: 'plan'; repoId: string; repoUrl: string }
  | { type: 'settings' };

// Request notification permission once on load
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [envs, setEnvs] = useState<EnvMeta[]>([]);
  const [repos, setRepos] = useState<RepoMeta[]>([]);
  const [selection, setSelection] = useState<Selection>({ type: 'none' });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connected, setConnected] = useState(false);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const [permissions, setPermissions] = useState<
    Map<string, StoredPermission[]>
  >(new Map());
  const [showNewEnv, setShowNewEnv] = useState(false);
  const [startDialogSlug, setStartDialogSlug] = useState<string | null>(null);
  const [lastRepoRevisionEvent, setLastRepoRevisionEvent] = useState<{
    repoId: string;
    repoUrl: string;
    previousVersion: number;
    currentVersion: number;
    previousRevisionId: string;
    currentRevisionId: string;
    sourceEnvSlug?: string | null;
  } | null>(null);
  const liveMessageRef = useRef<((msg: LiveMessage) => void) | null>(null);
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const selectionRef = useRef<Selection>({ type: 'none' });
  const sessionsRef = useRef<StoredSession[]>([]);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupChecked, setSetupChecked] = useState(false);
  const addToast = useToast();
  const titleFlashRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep refs in sync
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await fetchSessions(HUB_URL);
      setSessions(list);
    } catch (err) {
      if ((err as Error).message.includes('401')) {
        // Guard against reload loop — only reload once per 10s
        const lastReload = Number(
          sessionStorage.getItem('tiller-auth-reload') || '0',
        );
        if (Date.now() - lastReload > 10_000) {
          sessionStorage.setItem('tiller-auth-reload', String(Date.now()));
          window.location.reload();
        }
      }
    }
  }, []);

  const refreshEnvs = useCallback(async () => {
    try {
      const list = await fetchEnvs(HUB_URL);
      console.log(
        '[tiller] refreshEnvs',
        list.map((e) => ({ slug: e.slug, status: e.status })),
      );
      setEnvs((prev) => mergeEnvsPreservingBootMessages(list, prev));
    } catch (err) {
      console.error('[tiller] Failed to fetch envs:', err);
    }
  }, []);

  const refreshRepos = useCallback(async () => {
    try {
      const list = await fetchRepos(HUB_URL);
      setRepos(list);
      // Clear plan selection if the selected repo was deleted
      setSelection((prev) => {
        if (prev.type === 'plan' && !list.some((r) => r.repoId === prev.repoId)) {
          return { type: 'none' };
        }
        return prev;
      });
    } catch (err) {
      console.error('[tiller] Failed to fetch repos:', err);
    }
  }, []);

  // Expose a way for TerminalView to report lastSeq
  const updateLastSeq = useCallback((sessionId: string, seq: number) => {
    const current = lastSeqRef.current.get(sessionId);
    if (current == null || seq > current) {
      lastSeqRef.current.set(sessionId, seq);
    }
  }, []);

  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(
    new Map(),
  );

  // Clean up all poll timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of pollTimers.current.values()) clearInterval(timer);
    };
  }, []);

  const pollEnvStatus = useCallback((slug: string) => {
    // Clear any existing poll for this slug
    const existing = pollTimers.current.get(slug);
    if (existing) clearInterval(existing);

    const start = Date.now();
    const timer = setInterval(async () => {
      // Stop after 60s
      if (Date.now() - start > 60_000) {
        clearInterval(timer);
        pollTimers.current.delete(slug);
        return;
      }
      try {
        const status = await fetchEnvStatus(HUB_URL, slug);
        setEnvs((prev) =>
          prev.map((e) => (e.slug === slug ? { ...e, status } : e)),
        );
        if (TERMINAL_STATES.has(status)) {
          clearInterval(timer);
          pollTimers.current.delete(slug);
        }
      } catch {
        // Env may have been deleted — stop polling and remove from list
        clearInterval(timer);
        pollTimers.current.delete(slug);
        setEnvs((prev) => {
          const env = prev.find((e) => e.slug === slug);
          if (env?.status === 'deleting') {
            return prev.filter((e) => e.slug !== slug);
          }
          return prev;
        });
      }
    }, 3_000);
    pollTimers.current.set(slug, timer);
  }, []);

  const handleCreateEnv = useCallback(
    async (repoUrl: string, backend: "cf" | "local", authMode: "auto" | "subscription" | "api") => {
      const env = await createEnv(HUB_URL, repoUrl, backend, authMode);
      await refreshRepos();
      addToast({
        title: 'Environment created',
        body: `${env.slug} (${backend}, ${authMode})`,
        variant: 'success',
      });
      if (env.authWarning) {
        addToast({
          title: 'Claude auth fallback',
          body: env.authWarning,
          variant: 'warning',
          duration: 8000,
        });
      }
      setEnvs((prev) => [...prev, { ...env, status: 'creating' }]);
      setShowNewEnv(false);
      pollEnvStatus(env.slug);
    },
    [addToast, pollEnvStatus, refreshRepos],
  );

  const handleEnvDeleted = useCallback((slug: string) => {
    // Cancel any active poll timer for this env
    const timer = pollTimers.current.get(slug);
    if (timer) {
      clearInterval(timer);
      pollTimers.current.delete(slug);
    }
    setStartDialogSlug((current) => (current === slug ? null : current));
    setEnvs((prev) => {
      const remaining = prev.filter((env) => env.slug !== slug);

      setSelection((current) => {
        if (current.type === 'env' && current.envSlug === slug) {
          return { type: 'none' };
        }

        return current;
      });

      return remaining;
    });
    void refreshRepos();
  }, [refreshRepos]);

  const handleStatusChange = useCallback((slug: string, status: string) => {
    setEnvs((prev) => applyEnvStatusChange(prev, slug, status));
    if (!TERMINAL_STATES.has(status)) {
      pollEnvStatus(slug);
    }
  }, [pollEnvStatus]);

  // Gap-fill: fetch messages missed during disconnect for the active session
  const gapFill = useCallback(async () => {
    const sel = selectionRef.current;
    const activeId = sel.type === 'session' ? sel.sessionId : null;
    if (!activeId) return;
    const lastSeq = lastSeqRef.current.get(activeId);
    if (lastSeq == null) return;

    try {
      const msgs = await fetchMessages(HUB_URL, activeId, {
        afterSeq: lastSeq,
        limit: 1000,
      });
      for (const msg of msgs) {
        liveMessageRef.current?.({
          sessionId: activeId,
          content: msg.content,
          seq: msg.seq,
        });
      }
    } catch (err) {
      console.error('[tiller] gap-fill failed:', err);
    }
  }, []);

  // Load pending permissions for active session on reconnect
  const loadPermissions = useCallback(async () => {
    const sel = selectionRef.current;
    const activeId = sel.type === 'session' ? sel.sessionId : null;
    if (!activeId) return;
    try {
      const perms = await fetchPendingPermissions(HUB_URL, activeId);
      setPermissions((prev) => {
        const next = new Map(prev);
        next.set(activeId, perms);
        return next;
      });
    } catch (err) {
      console.error('[tiller] loadPermissions failed:', err);
    }
  }, []);

  // Immediately remove a permission from local state (called on successful HTTP resolve)
  const handlePermissionResolved = useCallback((permId: string) => {
    setPermissions((prev) => {
      const next = new Map(prev);
      for (const [sid, perms] of next) {
        const filtered = perms.filter((p) => p.id !== permId);
        if (filtered.length !== perms.length) {
          next.set(sid, filtered);
        }
      }
      return next;
    });
  }, []);

  // Flash title when permission needs attention
  const startTitleFlash = useCallback(() => {
    if (titleFlashRef.current) return;
    const original = document.title;
    let on = true;
    titleFlashRef.current = setInterval(() => {
      document.title = on ? '[!] Approval needed' : original;
      on = !on;
    }, 1000);
    // Stop flashing when tab becomes visible
    const stop = () => {
      if (!document.hidden) {
        clearInterval(titleFlashRef.current!);
        titleFlashRef.current = null;
        document.title = original;
        document.removeEventListener('visibilitychange', stop);
      }
    };
    document.addEventListener('visibilitychange', stop);
  }, []);

  // Handle env selection — find matching session or select env
  const handleEnvSelect = useCallback((slug: string) => {
    setSessions((currentSessions) => {
      const matchingSession = currentSessions.find((s) => s.tag === slug);
      if (matchingSession) {
        setSelection({ type: 'session', sessionId: matchingSession.id });
      } else {
        setSelection({ type: 'env', envSlug: slug });
      }
      return currentSessions;
    });
  }, []);

  // Handle session selection
  const handleSessionSelect = useCallback((sessionId: string) => {
    setSelection({ type: 'session', sessionId });
  }, []);

  // Check setup status on mount
  useEffect(() => {
    fetchSetupStatus(HUB_URL)
      .then(setSetupStatus)
      .catch(() => setSetupStatus({ needsSetup: false, keys: {} }))
      .finally(() => setSetupChecked(true));
  }, []);

  // Fetch sessions + envs on mount, then connect WS immediately
  useEffect(() => {
    if (!setupChecked || setupStatus?.needsSetup) return;

    refreshSessions();
    refreshEnvs();
    refreshRepos();
    setReconnectExhausted(false);

    const ws = createReconnectingWebSocket(HUB_URL, {
      onConnected: () => {
        setConnected(true);
        setReconnectExhausted(false);
        gapFill();
        loadPermissions();
        refreshEnvs();
        refreshRepos();
        addToast({ title: 'Connected', variant: 'success', duration: 2000 });
      },
      onDisconnected: () => {
        setConnected(false);
      },
      onReconnectExhausted: () => {
        setReconnectExhausted(true);
        addToast({
          title: 'Connection lost',
          body: 'Max reconnection attempts reached',
          variant: 'error',
          duration: 0,
        });
      },
      onMessage: (msg) => {
        if (msg.seq != null && msg.sessionId) {
          updateLastSeq(msg.sessionId, msg.seq);
        }
        liveMessageRef.current?.(msg);
        // Auto-transition from env waiting view to session on first output only
        if (msg.seq === 1) {
          setSelection((prev) => {
            if (prev.type === 'env') {
              const session = sessionsRef.current.find(
                (s) => s.tag === prev.envSlug && s.id === msg.sessionId,
              );
              if (session) {
                return { type: 'session', sessionId: session.id };
              }
            }
            return prev;
          });
        }
      },
      onSessionUpdated: (session) => {
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === session.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = session;
            return next;
          }
          return [session, ...prev];
        });
      },
      onSessionDeleted: (sessionId) => {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        setSelection((prev) =>
          prev.type === 'session' && prev.sessionId === sessionId
            ? { type: 'none' }
            : prev,
        );
      },
      onPermissionCreated: (permission) => {
        setPermissions((prev) => {
          const next = new Map(prev);
          const existing = next.get(permission.session_id) || [];
          next.set(permission.session_id, [...existing, permission]);
          return next;
        });
        addToast({
          title: 'Permission requested',
          body: `${permission.tool_name} needs approval`,
          variant: 'warning',
        });
        // Browser notification when tab is hidden
        if (document.hidden && Notification.permission === 'granted') {
          new Notification(
            `Tiller: Permission needed — ${permission.tool_name}`,
            {
              body: `Session requires approval for ${permission.tool_name}`,
              tag: permission.id,
            },
          );
        }
        if (document.hidden) {
          startTitleFlash();
        }
      },
      onEnvStatusChanged: (slug, status, message) => {
        console.log('[tiller ws] env-status-changed', { slug, status, message });
        if (status === 'deleted') {
          handleEnvDeleted(slug);
          return;
        }
        setEnvs((prev) => applyEnvStatusChange(prev, slug, status, message));
        // Transition session→env when env stops (reverse of the env→session auto-transition)
        // Only on "stopped", not "stopping" — keep SessionView visible while shutting down
        if (status === 'stopped') {
          void refreshEnvs();
          setSelection((prev) => {
            if (prev.type === 'session') {
              const session = sessionsRef.current.find(
                (s) => s.id === prev.sessionId,
              );
              if (session?.tag === slug) {
                return { type: 'env', envSlug: slug };
              }
            }
            return prev;
          });
        }
      },
      onRepoRevisionChanged: (repoId, repoUrl, previousVersion, currentVersion, previousRevisionId, currentRevisionId, sourceEnvSlug) => {
        setLastRepoRevisionEvent({
          repoId,
          repoUrl,
          previousVersion,
          currentVersion,
          previousRevisionId,
          currentRevisionId,
          sourceEnvSlug,
        });
        refreshRepos();
        refreshEnvs();
      },
      onPermissionResolved: (permission) => {
        setPermissions((prev) => {
          const next = new Map(prev);
          const existing = next.get(permission.session_id) || [];
          next.set(
            permission.session_id,
            existing.filter((p) => p.id !== permission.id),
          );
          return next;
        });
      },
      onError: (err) => {
        console.error('[tiller ws]', err);
      },
    });

    wsRef.current = ws;

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [
    setupChecked,
    setupStatus?.needsSetup,
    refreshSessions,
    refreshEnvs,
    refreshRepos,
    gapFill,
    loadPermissions,
    updateLastSeq,
    addToast,
    startTitleFlash,
  ]);

  const handleReconnect = () => {
    wsRef.current?.reconnect();
  };

  const selectedSession =
    selection.type === 'session'
      ? sessions.find((s) => s.id === selection.sessionId) || null
      : null;

  const selectedEnv =
    selection.type === 'env'
      ? envs.find((e) => e.slug === selection.envSlug) || null
      : null;

  const planSelection = selection.type === 'plan' ? selection : null;

  const selectedId = selection.type === 'session' ? selection.sessionId : null;
  const selectedEnvSlug = selection.type === 'env' ? selection.envSlug : null;
  const startDialogEnv =
    startDialogSlug ? envs.find((env) => env.slug === startDialogSlug) ?? null : null;

  const selectedPermissions = selectedId
    ? permissions.get(selectedId) || []
    : [];

  // Compute per-session permission counts for SessionList
  const permissionCounts: Record<string, number> = {};
  for (const [sid, perms] of permissions) {
    if (perms.length > 0) permissionCounts[sid] = perms.length;
  }

  // Setup check: loading or needs first-run setup
  if (!setupChecked) {
    return (
      <div className="flex h-screen items-center justify-center text-[#57606a] text-sm">
        Loading...
      </div>
    );
  }

  if (setupStatus?.needsSetup) {
    return (
      <SettingsPage
        status={setupStatus}
        firstRun
        onDone={() => window.location.reload()}
      />
    );
  }

  return (
    <div className="flex h-screen relative">
      {/* Sidebar */}
      <div
        className={`${sidebarOpen ? 'w-80' : 'w-0'} overflow-hidden border-r border-[#d0d7de] flex flex-col bg-[#f6f8fa] transition-all duration-200 flex-shrink-0`}
      >
        <div className="px-3 py-2.5 border-b border-[#d0d7de] flex flex-col gap-0.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold tracking-widest uppercase text-[#57606a]">
              TILLER
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelection({ type: 'settings' })}
                className="text-[#57606a] hover:text-[#24292f] text-sm leading-none"
                title="Settings"
              >
                &#9881;
              </button>
              <span
                className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
                title={connected ? 'Connected' : 'Disconnected'}
              />
              <button
                onClick={() => setSidebarOpen(false)}
                className="text-[#57606a] hover:text-[#24292f] text-sm leading-none"
                title="Collapse sidebar"
              >
                ←
              </button>
            </div>
          </div>
        </div>
        <div className="px-3 py-2 border-b border-[#d0d7de]">
          <button
            onClick={() => setShowNewEnv(true)}
            className="w-full text-xs px-2.5 py-1.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#24292f] font-medium transition-colors"
          >
            Add Repo
          </button>
        </div>
        <SessionList
          repos={repos}
          sessions={sessions}
          selectedId={selectedId}
          onSelect={handleSessionSelect}
          permissionCounts={permissionCounts}
          envs={envs}
          hubUrl={HUB_URL}
          onPollEnvStatus={pollEnvStatus}
          onStatusChange={handleStatusChange}
          onEnvSelect={handleEnvSelect}
          selectedEnvSlug={selectedEnvSlug}
          onPlanSelect={(repoId, repoUrl) =>
            setSelection({ type: 'plan', repoId, repoUrl })
          }
          planRepoId={planSelection?.repoId ?? null}
          onStartRequest={(slug) => setStartDialogSlug(slug)}
          onRefreshData={() => {
            void refreshRepos();
            void refreshEnvs();
          }}
        />
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-[#f6f8fa] border border-[#d0d7de] border-l-0 rounded-r px-1 py-3 text-[#57606a] hover:text-[#24292f] hover:bg-white transition-colors text-sm"
            title="Expand sidebar"
          >
            →
          </button>
        )}
        {reconnectExhausted && !connected && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between">
            <span className="text-sm text-red-600">Connection lost</span>
            <button
              onClick={handleReconnect}
              className="text-xs px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium"
            >
              Reconnect
            </button>
          </div>
        )}
        {selection.type === 'settings' && setupStatus ? (
          <SettingsPage
            status={setupStatus}
            onDone={() => setSelection({ type: 'none' })}
          />
        ) : selectedSession ? (
          <SessionView
            session={selectedSession}
            hubUrl={HUB_URL}
            onWsMessage={liveMessageRef}
            wsSend={wsRef}
            connected={connected}
            updateLastSeq={updateLastSeq}
            permissions={selectedPermissions}
            onPermissionResolved={handlePermissionResolved}
          />
        ) : planSelection ? (
          <PlanView
            key={planSelection.repoId}
            repoId={planSelection.repoId}
            repoUrl={planSelection.repoUrl}
            revisionEvent={lastRepoRevisionEvent}
          />
        ) : selectedEnv ? (
          <EnvWaitingView
            env={selectedEnv}
            hubUrl={HUB_URL}
            onAction={refreshEnvs}
            onDeleted={handleEnvDeleted}
            onStatusChange={handleStatusChange}
            onStartRequest={(slug) => setStartDialogSlug(slug)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[#57606a] text-sm">
            Select a session or create a new environment
          </div>
        )}
      </div>

      {showNewEnv && (
        <NewEnvDialog
          onClose={() => setShowNewEnv(false)}
          onCreate={handleCreateEnv}
        />
      )}
      {startDialogEnv && (
        <StartPlanDialog
          env={startDialogEnv}
          hubUrl={HUB_URL}
          onClose={() => setStartDialogSlug(null)}
          onStarted={(status) => {
            handleStatusChange(startDialogEnv.slug, status);
          }}
        />
      )}
    </div>
  );
}
