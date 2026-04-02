import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { ensureSchema } from "./schema";
import { verifyCfAccessJwt } from "./auth";
import * as Q from "./queries";
import type {
  ActiveLocalRunnerConfig,
  Env,
  MachineRunnerState,
  StoredSession,
  StoredMachine,
  StoredMessage,
  StoredPermission,
  VersionedUpdateResult,
  WsConnectionState,
  WsClientMessage,
  WsServerMessage,
} from "./types";

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute alarm for stale cleanup
const MACHINE_INACTIVE_GRACE_SECONDS = 90;

// ── HubDO ───────────────────────────────────────────────────────────

export class HubDO extends Server<Env> {
  static options = { hibernate: true };

  private _db: SqlStorage | null = null;
  private _schemaReady = false;

  // In-memory map for holding long-poll requests open until permission is resolved
  private pendingPolls = new Map<string, {
    resolve: (result: { status: string; decision_reason?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /** Lazy-init SQL — direct RPC stub calls bypass partyserver's onStart(). */
  private get db(): SqlStorage {
    if (!this._db) {
      this._db = this.ctx.storage.sql;
    }
    if (!this._schemaReady) {
      ensureSchema(this._db);
      this._schemaReady = true;
    }
    return this._db;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async onStart(): Promise<void> {
    // Force schema init for WebSocket path
    console.time("[HubDO] onStart ensureSchema");
    const _ = this.db;
    console.timeEnd("[HubDO] onStart ensureSchema");
    // Handle ping/pong at the edge without waking the DO from hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    console.log("[HubDO] onStart done");
  }

  // ── WebSocket lifecycle hooks ─────────────────────────────────

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    // No JWT header = local dev (wrangler dev without CF Access)
    const jwtHeader = ctx.request.headers.get("Cf-Access-Jwt-Assertion");
    if (jwtHeader) {
      try {
        verifyCfAccessJwt(ctx.request, this.env);
      } catch (err) {
        console.warn("[HubDO] onConnect auth failed:", (err as Error).message);
        this.send(connection, { type: "error", message: "Unauthorized" });
        connection.close(4001, "Unauthorized");
        return;
      }
    }

    console.log(`[HubDO] onConnect ok, t=${Date.now()}`);
    connection.setState({} as WsConnectionState);
    this.scheduleAlarm();
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;

    let data: WsClientMessage;
    try {
      data = JSON.parse(message);
    } catch {
      this.send(connection, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (data.type) {
      case "reconnect":
        this.handleReconnect(connection, data.lastSeq);
        break;
      case "message":
        this.handleMessage(connection, data);
        break;
      case "session-alive":
        this.handleSessionAlive(connection, data.sessionId);
        break;
      case "session-end":
        this.handleSessionEnd(data.sessionId);
        break;
      case "update-metadata":
        this.handleUpdateMetadata(connection, data);
        break;
      case "update-agent-state":
        this.handleUpdateAgentState(connection, data);
        break;
      case "update-todos":
        this.handleUpdateTodos(connection, data);
        break;
      case "machine-alive":
        this.handleMachineAlive(connection, data.machineId);
        break;
      case "machine-update-metadata":
        this.handleMachineUpdateMetadata(connection, data);
        break;
      case "machine-update-runner-state":
        this.handleMachineUpdateRunnerState(connection, data);
        break;
    }
  }

  onClose(connection: Connection, _code: number, _reason: string, _wasClean: boolean): void {
    this.cleanupConnection(connection);
  }

  onError(connection: Connection, _error: unknown): void {
    this.cleanupConnection(connection);
  }

  // ── Message handlers ──────────────────────────────────────────

  private handleMessage(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "message" }>,
  ): void {
    const { message, sessionSeq } = Q.addMessage(
      this.db,
      data.id,
      data.sessionId,
      data.content,
      data.localId ?? null,
    );

    const event: WsServerMessage = {
      type: "message-received",
      id: message.id,
      sessionId: data.sessionId,
      content: JSON.parse(message.content),
      seq: sessionSeq,
      localId: message.local_id ?? undefined,
    };

    // Broadcast to all connections except sender
    this.broadcastToAll(event, connection.id);
  }

  private handleSessionAlive(connection: Connection, sessionId: string): void {
    // Persist sessionId on the connection so handleReconnect can replay missed messages
    const state = connection.state as WsConnectionState;
    if (!state.sessionId) {
      connection.setState({ ...state, sessionId } as WsConnectionState);
    }

    Q.reviveSession(this.db, sessionId);
    const session = Q.getSession(this.db, sessionId);
    if (session) {
      this.broadcastToAll({ type: "session-updated", session });
    }
  }

  private handleSessionEnd(sessionId: string): void {
    Q.markSessionEnded(this.db, sessionId);
    this.broadcastToAll({ type: "session-deleted", sessionId });
  }

  private handleUpdateMetadata(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "update-metadata" }>,
  ): void {
    const result = Q.updateSessionMetadata(
      this.db,
      data.sessionId,
      data.metadata,
      data.expectedVersion,
    );
    this.handleVersionedResult(connection, result, data.sessionId);
  }

  private handleUpdateAgentState(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "update-agent-state" }>,
  ): void {
    const result = Q.updateSessionAgentState(
      this.db,
      data.sessionId,
      data.agentState,
      data.expectedVersion,
    );
    this.handleVersionedResult(connection, result, data.sessionId);
  }

  private handleUpdateTodos(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "update-todos" }>,
  ): void {
    const result = Q.updateSessionTodos(
      this.db,
      data.sessionId,
      data.todos,
      data.expectedVersion,
    );
    this.handleVersionedResult(connection, result, data.sessionId);
  }

  private handleMachineAlive(connection: Connection, machineId: string): void {
    const state = connection.state as WsConnectionState;
    Q.markMachineAlive(this.db, machineId);

    // Tag this connection as a machine connection
    connection.setState({ ...state, machineId, role: "cli" } as WsConnectionState);

    const machine = Q.getMachine(this.db, machineId);
    if (machine) {
      this.broadcastToAll({ type: "machine-updated", machine });
    }
  }

  private handleMachineUpdateMetadata(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "machine-update-metadata" }>,
  ): void {
    const result = Q.updateMachineMetadata(
      this.db,
      data.machineId,
      data.metadata,
      data.expectedVersion,
    );
    this.handleVersionedMachineResult(connection, result, data.machineId);
  }

  private handleMachineUpdateRunnerState(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "machine-update-runner-state" }>,
  ): void {
    const result = Q.updateMachineRunnerState(
      this.db,
      data.machineId,
      data.runnerState,
      data.expectedVersion,
    );
    this.handleVersionedMachineResult(connection, result, data.machineId);
  }

  private handleVersionedResult(
    connection: Connection,
    result: VersionedUpdateResult,
    sessionId: string,
  ): void {
    if (!result.ok) {
      this.send(connection, {
        type: "error",
        message: result.reason === "not_found"
          ? `Session ${sessionId} not found`
          : `Version conflict (current: ${result.current_version})`,
      });
      return;
    }
    const session = Q.getSession(this.db, sessionId);
    if (session) {
      this.broadcastToAll({ type: "session-updated", session });
    }
  }

  private handleVersionedMachineResult(
    connection: Connection,
    result: VersionedUpdateResult,
    machineId: string,
  ): void {
    if (!result.ok) {
      this.send(connection, {
        type: "error",
        message: result.reason === "not_found"
          ? `Machine ${machineId} not found`
          : `Version conflict (current: ${result.current_version})`,
      });
      return;
    }
    const machine = Q.getMachine(this.db, machineId);
    if (machine) {
      this.broadcastToAll({ type: "machine-updated", machine });
    }
  }

  // ── Reconnection ──────────────────────────────────────────────

  private handleReconnect(connection: Connection, lastSeq: number): void {
    const state = connection.state as WsConnectionState;
    if (!state.sessionId) {
      // No session context — just ack
      this.send(connection, { type: "replay", events: [] });
      return;
    }

    const missed = Q.getMessagesSince(this.db, state.sessionId, lastSeq);
    const events: WsServerMessage[] = missed.map((m) => ({
      type: "message-received" as const,
      id: m.id,
      sessionId: m.session_id,
      content: JSON.parse(m.content),
      seq: m.seq,
      localId: m.local_id ?? undefined,
    }));

    this.send(connection, { type: "replay", events });
  }

  private getLiveReferences(excludeConnectionId?: string): {
    hasConnections: boolean;
    machineIds: Set<string>;
    sessionIds: Set<string>;
  } {
    const machineIds = new Set<string>();
    const sessionIds = new Set<string>();
    let hasConnections = false;

    for (const conn of this.getConnections()) {
      if (excludeConnectionId && conn.id === excludeConnectionId) continue;
      hasConnections = true;
      const state = conn.state as WsConnectionState | undefined;
      if (state?.machineId) machineIds.add(state.machineId);
      if (state?.sessionId) sessionIds.add(state.sessionId);
    }

    return { hasConnections, machineIds, sessionIds };
  }

  private scheduleAlarm(): void {
    this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private markMachineInactive(machineId: string): void {
    const machine = Q.getMachine(this.db, machineId);
    if (!machine || machine.active !== 1) return;

    Q.setMachineActive(this.db, machineId, false);
    const updated = Q.getMachine(this.db, machineId);
    if (updated) {
      this.broadcastToAll({ type: "machine-updated", machine: updated });
    }
  }

  private markSessionInactive(sessionId: string): void {
    const session = Q.getSession(this.db, sessionId);
    if (!session || session.active !== 1) return;

    try {
      Q.setSessionActive(this.db, sessionId, false);
    } catch {
      return;
    }

    const updated = Q.getSession(this.db, sessionId);
    if (updated) {
      this.broadcastToAll({ type: "session-updated", session: updated });
    }
  }

  // ── Connection cleanup ────────────────────────────────────────

  private cleanupConnection(connection: Connection): void {
    const state = connection.state as WsConnectionState | undefined;
    if (!state) return;

    const live = this.getLiveReferences(connection.id);

    // Sessions go inactive immediately on disconnect. Machines get a grace period
    // and are cleaned up from the alarm loop to avoid flapping on WS reconnects.
    if (state.sessionId && !live.sessionIds.has(state.sessionId)) {
      this.markSessionInactive(state.sessionId);
    }
  }

  broadcastEnvStatus(slug: string, status: string, message?: string): void {
    this.broadcastToAll({ type: "env-status-changed", slug, status, message });
  }

  broadcastRepoRevisionChange(
    repoId: string,
    repoUrl: string,
    previousVersion: number,
    currentVersion: number,
    previousRevisionId: string,
    currentRevisionId: string,
    sourceEnvSlug?: string | null,
  ): void {
    this.broadcastToAll({
      type: "repo-revision-changed",
      repoId,
      repoUrl,
      previousVersion,
      currentVersion,
      previousRevisionId,
      currentRevisionId,
      sourceEnvSlug,
    });
  }

  // ── Typed RPC methods (called from Worker via stub) ───────────

  createSession(
    id: string,
    tag: string,
    machineId: string | null,
    metadata: unknown,
  ): StoredSession {
    return Q.createSession(this.db, id, tag, machineId, metadata);
  }

  getSession(id: string): StoredSession | null {
    return Q.getSession(this.db, id);
  }

  getSessions(): StoredSession[] {
    return Q.getSessions(this.db);
  }

  updateSessionMetadata(id: string, metadata: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionMetadata(this.db, id, metadata, expectedVersion);
  }

  updateSessionAgentState(id: string, agentState: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionAgentState(this.db, id, agentState, expectedVersion);
  }

  updateSessionTodos(id: string, todos: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionTodos(this.db, id, todos, expectedVersion);
  }

  deleteSession(id: string): void {
    Q.deleteSession(this.db, id);
    this.broadcastToAll({ type: "session-deleted", sessionId: id });
  }

  setSessionActive(id: string, active: boolean): void {
    Q.setSessionActive(this.db, id, active);
  }

  getOrCreateMachine(id: string, metadata: unknown): StoredMachine {
    return Q.getOrCreateMachine(this.db, id, metadata);
  }

  getMachines(): StoredMachine[] {
    return Q.getMachines(this.db);
  }

  getActiveLocalRunnerConfig(): ActiveLocalRunnerConfig | null {
    let selected: {
      runnerUrl: string;
      relayUrl: string | null;
      registeredAtMs: number;
    } | null = null;

    for (const machine of Q.getMachines(this.db)) {
      if (machine.active !== 1) continue;

      let state: MachineRunnerState;
      try {
        state = JSON.parse(machine.runner_state) as MachineRunnerState;
      } catch {
        continue;
      }

      const runnerUrl = state.runnerUrl?.trim();
      if (!runnerUrl) continue;

      const relayUrl = state.relayUrl?.trim() || null;
      const parsedRegisteredAtMs = Date.parse(state.registeredAt ?? "");
      const registeredAtMs = Number.isFinite(parsedRegisteredAtMs) ? parsedRegisteredAtMs : 0;

      if (!selected || registeredAtMs > selected.registeredAtMs) {
        selected = {
          runnerUrl,
          relayUrl,
          registeredAtMs,
        };
      }
    }

    if (!selected) return null;
    return {
      runnerUrl: selected.runnerUrl,
      relayUrl: selected.relayUrl,
    };
  }

  addMessage(
    id: string,
    sessionId: string,
    content: unknown,
    localId: string | null,
  ): { message: StoredMessage; sessionSeq: number } {
    const result = Q.addMessage(this.db, id, sessionId, content, localId);

    // Broadcast to all WS clients (REST-originated messages need this
    // so CLI picks them up via its message-received handler)
    const event: WsServerMessage = {
      type: "message-received",
      id: result.message.id,
      sessionId,
      content: JSON.parse(result.message.content),
      seq: result.sessionSeq,
      localId: result.message.local_id ?? undefined,
    };
    this.broadcastToAll(event);

    return result;
  }

  getMessages(
    sessionId: string,
    opts: { limit?: number; beforeSeq?: number; afterSeq?: number },
  ): StoredMessage[] {
    return Q.getMessages(this.db, sessionId, opts);
  }

  // ── Permission RPC methods ──────────────────────────────────────

  createPermission(
    id: string,
    sessionId: string,
    toolName: string,
    toolInput: unknown,
  ): StoredPermission {
    const permission = Q.createPermission(this.db, id, sessionId, toolName, toolInput);
    this.broadcastToAll({ type: "permission-created", permission });
    return permission;
  }

  getPermission(permId: string): StoredPermission | null {
    return Q.getPermission(this.db, permId);
  }

  getPendingPermissions(sessionId: string): StoredPermission[] {
    return Q.getPendingPermissions(this.db, sessionId);
  }

  resolvePermission(
    permId: string,
    status: "allowed" | "denied",
    decisionReason?: string,
    allowForSession?: boolean,
  ): StoredPermission | null {
    const permission = Q.resolvePermission(this.db, permId, status, decisionReason);
    if (!permission) return null;

    // If "allow for session", add tool pattern to session's allowed_tools
    if (allowForSession && status === "allowed") {
      Q.addSessionAllowedTool(this.db, permission.session_id, permission.tool_name);
    }

    // Broadcast resolution to all WS clients
    this.broadcastToAll({ type: "permission-resolved", permission });

    // Resolve any waiting long-poll request
    const poll = this.pendingPolls.get(permId);
    if (poll) {
      clearTimeout(poll.timer);
      this.pendingPolls.delete(permId);
      poll.resolve({ status, decision_reason: decisionReason });
    }

    return permission;
  }

  addSessionAllowedTool(sessionId: string, toolPattern: string): void {
    Q.addSessionAllowedTool(this.db, sessionId, toolPattern);
  }

  /**
   * Long-poll: blocks until the permission is resolved or timeout (25s).
   * Returns { status: "timeout" } on timeout, or the resolution status.
   *
   * Registers the poll entry BEFORE checking DB status to close the race
   * window where resolvePermission() fires between the check and registration.
   */
  async waitForPermission(
    permId: string,
    timeout = 25_000,
  ): Promise<{ status: string; decision_reason?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPolls.delete(permId);
        resolve({ status: "timeout" });
      }, timeout);

      // Register poll first so a concurrent resolve won't be missed
      this.pendingPolls.set(permId, { resolve, timer });

      // Now check if already resolved — if so, resolve immediately
      const existing = Q.getPermission(this.db, permId);
      if (existing && existing.status !== "pending") {
        clearTimeout(timer);
        this.pendingPolls.delete(permId);
        resolve({ status: existing.status, decision_reason: existing.decision_reason ?? undefined });
      }
    });
  }

  // ── Config RPC methods (settings page secret storage) ─────────

  getAllConfig(): Record<string, string> {
    const rows = this.db
      .exec("SELECT key, value FROM config")
      .toArray() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  setConfig(key: string, value: string): void {
    this.db.exec(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
    );
  }

  deleteConfig(key: string): void {
    this.db.exec("DELETE FROM config WHERE key = ?", key);
  }

  // ── Alarm (stale session/machine cleanup) ─────────────────────

  async onAlarm(): Promise<void> {
    const live = this.getLiveReferences();

    // Mark stale machines with no live connections as inactive after a reconnect grace period.
    const machines = this.db
      .exec(
        `SELECT id
         FROM machines
         WHERE active = 1
           AND updated_at < datetime('now', ?)` ,
        `-${MACHINE_INACTIVE_GRACE_SECONDS} seconds`,
      )
      .toArray() as { id: string }[];
    for (const { id } of machines) {
      if (!live.machineIds.has(id)) {
        this.markMachineInactive(id);
      }
    }

    // Mark stale active sessions (no live connection) as inactive
    const activeSessions = this.db
      .exec("SELECT id FROM sessions WHERE active = 1")
      .toArray() as { id: string }[];
    for (const { id } of activeSessions) {
      if (!live.sessionIds.has(id)) {
        this.markSessionInactive(id);
      }
    }

    // For sessions that are inactive but not yet ended (crash/disconnect scenario),
    // soft-delete them: set ended_at and broadcast session-deleted to clean up the web UI.
    const inactiveSessions = this.db
      .exec("SELECT id FROM sessions WHERE active = 0 AND ended_at IS NULL")
      .toArray() as { id: string }[];
    for (const { id } of inactiveSessions) {
      if (!live.sessionIds.has(id)) {
        Q.markSessionEnded(this.db, id);
        this.broadcastToAll({ type: "session-deleted", sessionId: id });
      }
    }

    // Hard-delete sessions whose ended_at is older than 24 hours
    this.db.exec("DELETE FROM sessions WHERE ended_at < datetime('now', '-24 hours')");

    const activeMachineCount =
      (this.db.exec("SELECT COUNT(*) AS count FROM machines WHERE active = 1").toArray()[0] as { count: number } | undefined)
        ?.count ?? 0;

    // Reschedule while there are live connections or active machines still eligible for a future grace-period cleanup.
    if (live.hasConnections || activeMachineCount > 0) {
      this.scheduleAlarm();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private send(connection: Connection, message: WsServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  private broadcastToAll(message: WsServerMessage, excludeId?: string): void {
    const payload = JSON.stringify(message);
    for (const conn of this.getConnections()) {
      if (excludeId && conn.id === excludeId) continue;
      try { conn.send(payload); } catch { /* connection closing */ }
    }
  }
}
