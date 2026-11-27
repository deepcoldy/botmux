import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fetchDaemonIpc } from '../../core/daemon-ipc-auth.js';
import { fleetProcessIdentityRuntime, type FleetProcessIdentityRuntime } from '../../core/fleet-process-identity.js';
import {
  EXPECTED_CORE_BOOT_HEADER,
  nativeGatewaySourceIdentityPath,
  type NativeGatewaySourceIdentity,
} from '../../core/native-gateway-contract.js';
import { openDatabaseSyncOrThrow } from '../../services/sqlite-compat.js';
import { requestWecomSessionControl } from './gateway-control-client.js';
import { createDaemonClient } from '../daemon-internal-client.js';
import type { NativeTerminalRequest, NativeTerminalTarget } from './terminal-access.js';
import { parseWecomConfig, type WecomConfig } from '../../im/wecom/config/config.js';
import { readWecomConfigPaths, wecomConfigId, wecomRoot } from '../../im/wecom/config/discovery.js';
import { inspectWecomProcess, isFreshWecomRuntime, readWecomRuntime, wecomBotRoot } from '../../im/wecom/config/runtime.js';
import {
  WECOM_GATEWAY_CONTROL_PATHS,
  type WecomSessionOperation,
  type WecomTerminalAuthorization,
} from '../../im/wecom/contract/gateway-control.js';

// Core routes: the source-identity proof and the boot-pinning header come from
// the native gateway contract. `/healthz`, the session list / detail / insight
// reads, `rename`, `board` and the machine environment routes are the general
// Dashboard routes every daemon serves, so they stay literal here.

export type WecomSessionAction = 'history' | 'insight' | 'terminal' | 'takeover' | 'interrupt' | 'restart' | 'close' | 'resume'
  | 'rename' | 'board' | 'lock' | 'locate' | 'spawnCommand' | 'environment' | 'start' | 'monitorRoom' | 'input' | 'archive'
  | 'delete' | 'topics' | 'larkNative' | 'suspend';
export interface WecomSessionRow extends Record<string, unknown> {
  sessionId: string;
  provider: 'wecom';
  providerBotId: string;
  sourceId: string;
  botName: string;
  status: string;
  offline: boolean;
  capabilities: Partial<Record<WecomSessionAction, boolean>>;
}
interface BridgeTask {
  sessionId?: string;
  triggerId?: string;
  delivered?: boolean;
  result?: string;
  message?: { chatType?: string; text?: string };
  request?: { target?: { sessionId?: string }; envelope?: { rawText?: string } };
}
interface Scope {
  file: string;
  id: string;
  config: WecomConfig;
  coreIdentity: string;
  tasks: BridgeTask[];
  locks: Record<string, string>;
  snapshot: string;
}
interface LiveSource extends Scope {
  port: number;
  bootInstanceId: string;
  corePid: number;
  coreProcessStart: string;
  control?: { port: number; instanceId: string };
}
export interface WecomDashboardSessionsOptions {
  root?: string;
  runtime?: FleetProcessIdentityRuntime;
  now?: () => number;
  fetchCore?: (port: number, path: string, init?: RequestInit) => Promise<Response>;
  readParentPid?: (pid: number) => number | undefined;
  /** Dependency injection for isolated signed gateway IPC tests. */
  gatewaySecret?: string;
}
export function wecomCoreIdentity(config: WecomConfig): string {
  if (!config.managedCore) {
    throw new Error('wecom_external_core_unbound');
  }
  return createHash('sha256')
    .update(JSON.stringify([resolve(config.managedCore.stateDir), config.managedCore.botId]))
    .digest('hex');
}
export function encodeWecomSessionId(configId: string, coreIdentity: string, nativeSessionId: string): string {
  return `wecom:${configId}:${coreIdentity}:${Buffer.from(nativeSessionId).toString('base64url')}`;
}
export function decodeWecomSessionId(value: string): { configId: string; coreIdentity: string; nativeSessionId: string } | undefined {
  const match = /^wecom:([a-f0-9]{64}):([a-f0-9]{64}):([A-Za-z0-9_-]{1,700})$/.exec(value);
  if (!match) {
    return;
  }
  const sid = Buffer.from(match[3], 'base64url').toString('utf8');
  if (!sid || sid.length > 512 || /[\x00-\x1f\\/]/.test(sid) || Buffer.from(sid).toString('base64url') !== match[3]) {
    return;
  }
  return { configId: match[1], coreIdentity: match[2], nativeSessionId: sid };
}
function readParentPid(pid: number): number | undefined {
  try {
    if (process.platform === 'linux') {
      return Number(/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]) || undefined;
    }
    return Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim()) || undefined;
  } catch {
    return;
  }
}
const linked = (task: BridgeTask, sid: unknown) => task.sessionId === sid || task.request?.target?.sessionId === sid;
const time = (value: unknown): number => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0;
export class WecomDashboardSessions {
  private readonly root: string;
  private readonly runtime: FleetProcessIdentityRuntime;
  private readonly now: () => number;
  constructor(private readonly options: WecomDashboardSessionsOptions = {}) {
    this.root = options.root ?? wecomRoot();
    this.runtime = options.runtime ?? fleetProcessIdentityRuntime;
    this.now = options.now ?? Date.now;
  }
  /** Read-only readiness proof; never opens another platform socket. */
  async coreReady(id: string): Promise<boolean> {
    try {
      const file = readWecomConfigPaths(this.root).find(path => wecomConfigId(path) === id);
      if (!file) {
        return false;
      }
      const snapshot = readFileSync(file, 'utf8');
      const config = parseWecomConfig(JSON.parse(snapshot));
      if (!config.managedCore) {
        return false;
      }
      const record = readWecomRuntime(config.botId, this.root);
      if (record?.phase !== 'running' || record.connection !== 'connected' || !record.control) {
        return false;
      }
      const live = await this.live({ file, id, config, coreIdentity: wecomCoreIdentity(config), tasks: [], locks: {}, snapshot });
      const health = await this.fetch(config.managedCore.port, '/healthz', { headers: { [EXPECTED_CORE_BOOT_HEADER]: live.bootInstanceId } });
      if (!health.ok || (await health.json() as { ok?: boolean }).ok !== true
        || this.runtime.readIdentity(live.corePid) !== live.coreProcessStart) {
        return false;
      }
      const current = readWecomRuntime(config.botId, this.root);
      return readFileSync(file, 'utf8') === snapshot && current?.phase === 'running' && current.connection === 'connected'
        && current.instanceId === record.instanceId && current.processStart === record.processStart && current.pid === record.pid
        && current.control?.instanceId === record.control.instanceId && isFreshWecomRuntime(current, this.now());
    } catch {
      return false;
    }
  }
  private scopes(): Scope[] {
    return readWecomConfigPaths(this.root).flatMap(file => this.readScope(file) ?? []);
  }
  /** One registered configuration's scope, from its configuration file and the gateway's state file. */
  private readScope(file: string): Scope | undefined {
    try {
      const config = parseWecomConfig(JSON.parse(readFileSync(file, 'utf8')));
      if (!config.managedCore) {
        return;
      }
      const coreIdentity = wecomCoreIdentity(config);
      const stateFile = join(config.stateDir ? resolve(config.stateDir) : wecomBotRoot(config.botId, this.root), 'state.json');
      if (!existsSync(stateFile)) {
        return;
      }
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (state.version !== 1 || state.botId !== config.botId || (state.connectionId && state.connectionId !== wecomConfigId(file))
        || state.coreIdentity !== coreIdentity || !state.tasks || typeof state.tasks !== 'object') {
        return;
      }
      return {
        file,
        id: wecomConfigId(file),
        config,
        coreIdentity,
        tasks: Object.values(state.tasks),
        locks: state.sessionLocks ?? {},
        snapshot: readFileSync(file, 'utf8'),
      };
    } catch {
      // Invalid/unbound sources do not impersonate sessions.
      return;
    }
  }
  private async live(scope: Scope): Promise<LiveSource> {
    const record = readWecomRuntime(scope.config.botId, this.root);
    if (!record || record.configId !== scope.id || record.phase === 'stopped' || !isFreshWecomRuntime(record, this.now())
      || inspectWecomProcess(record, this.runtime).status !== 'exact') {
      throw new Error('wecom_core_offline');
    }
    const settings = scope.config.managedCore!;
    const descriptor = JSON.parse(readFileSync(join(settings.stateDir, 'dashboard-daemons', `${settings.botId}.json`), 'utf8'));
    if (descriptor.larkAppId !== settings.botId || descriptor.ipcPort !== settings.port || !descriptor.bootInstanceId
      || this.now() - descriptor.lastHeartbeat > 90000) {
      throw new Error('wecom_core_source_mismatch');
    }
    const birth = this.runtime.readIdentity(descriptor.pid);
    if (!birth || (this.options.readParentPid ?? readParentPid)(descriptor.pid) !== record.pid) {
      throw new Error('wecom_core_source_mismatch');
    }
    if (inspectWecomProcess({
      pid: descriptor.pid,
      processStart: birth,
      pidNamespace: this.runtime.readPidNamespace(descriptor.pid),
    }, this.runtime).status !== 'exact') {
      throw new Error('wecom_core_source_mismatch');
    }
    const response = await this.fetch(descriptor.ipcPort, nativeGatewaySourceIdentityPath());
    if (!response.ok) {
      throw new Error('wecom_core_identity_unavailable');
    }
    const proof = await response.json() as Partial<NativeGatewaySourceIdentity>;
    if (proof.coreOnly !== true || proof.coreBotId !== settings.botId || proof.bootInstanceId !== descriptor.bootInstanceId
      || proof.pid !== descriptor.pid || proof.processStart !== birth || this.runtime.readIdentity(descriptor.pid) !== birth) {
      throw new Error('wecom_core_source_mismatch');
    }
    return {
      ...scope,
      port: descriptor.ipcPort,
      bootInstanceId: descriptor.bootInstanceId,
      corePid: descriptor.pid,
      coreProcessStart: birth,
      ...((record as any).control ? { control: (record as any).control } : {}),
    };
  }
  /**
   * The scope as it is on disk now: still registered, with the same
   * configuration text and core. Reads the registry and this scope's own files
   * only, so rechecking every connection of a snapshot stays linear in their number.
   */
  private current(scope: Scope): Scope {
    const current = readWecomConfigPaths(this.root).includes(scope.file) ? this.readScope(scope.file) : undefined;
    if (!current || current.id !== scope.id || current.coreIdentity !== scope.coreIdentity || current.snapshot !== scope.snapshot) {
      throw new Error('wecom_source_changed');
    }
    return current;
  }
  private async recheck(live: LiveSource): Promise<Scope> {
    const scope = this.current(live);
    const current = await this.live(scope);
    if (current.bootInstanceId !== live.bootInstanceId || current.corePid !== live.corePid
      || current.coreProcessStart !== live.coreProcessStart || current.control?.instanceId !== live.control?.instanceId) {
      throw new Error('wecom_source_changed');
    }
    return scope;
  }
  private fetch(port: number, path: string, init: RequestInit = {}): Promise<Response> {
    return (this.options.fetchCore ?? fetchDaemonIpc)(port, path, { ...init, signal: init.signal ?? AbortSignal.timeout(2000) });
  }
  private disk(scope: Scope): Record<string, unknown>[] {
    const settings = scope.config.managedCore!;
    const path = join(settings.stateDir, 'session-stores', settings.botId, 'sessions.db');
    if (!existsSync(path)) {
      return [];
    }
    const db = openDatabaseSyncOrThrow(path, { readOnly: true });
    try {
      return (db.prepare('SELECT row FROM sessions').all() as { row: string }[])
        .map(item => JSON.parse(item.row))
        .filter(row => row.larkAppId === settings.botId && scope.tasks.some(task => linked(task, row.sessionId)));
    } finally {
      db.close();
    }
  }
  private project(scope: Scope, row: Record<string, unknown>, online: boolean): WecomSessionRow {
    const native = String(row.sessionId);
    const tasks = scope.tasks.filter(task => linked(task, native));
    const latest = tasks.at(-1);
    const generation = [...tasks].reverse().find(task => task.triggerId)?.triggerId;
    const pending = tasks.some(task => !task.delivered);
    const lock = scope.locks[native];
    const controlled = online && Boolean((scope as LiveSource).control);
    const rawStatus = String(row.status ?? 'dormant');
    const closed = rawStatus === 'closed';
    const status = closed ? 'closed' : online ? (rawStatus === 'active' ? 'dormant' : rawStatus) : 'dormant';
    // Terminal and takeover need the same thing: a live worker this row's proxy belongs to (one identity read).
    const attachable = online && !closed && !lock && typeof row.workerPid === 'number' && Boolean(this.runtime.readIdentity(row.workerPid))
      && Number.isInteger(row.proxyPort);
    const result: WecomSessionRow = {
      sessionId: encodeWecomSessionId(scope.id, scope.coreIdentity, native),
      provider: 'wecom',
      providerBotId: scope.id,
      sourceId: `wecom:${scope.id}:${scope.coreIdentity}`,
      botName: scope.config.displayName || '企业微信机器人',
      status,
      offline: !online,
      chatType: latest?.message?.chatType === 'group' ? 'group' : 'p2p',
      chatDisplayName: latest?.message?.chatType === 'group' ? '企微群聊' : '企微私聊',
      scope: 'chat',
      cliId: row.cliId ?? scope.config.managedCore?.cli,
      backendType: row.backendType ?? scope.config.managedCore?.backend,
      workingDir: row.workingDir ?? row.workingDirectory ?? scope.config.managedCore?.workingDirectory,
      spawnedAt: time(row.spawnedAt ?? row.createdAt),
      createdAt: time(row.createdAt ?? row.spawnedAt),
      lastMessageAt: time(row.lastMessageAt),
      ...(closed ? { closedAt: time(row.closedAt) } : {}),
      title: row.title ?? '企微会话',
      capabilities: {
        history: true,
        insight: online,
        rename: online,
        board: online && !closed && !row.queued,
        terminal: attachable,
        takeover: attachable,
        interrupt: controlled && pending && Boolean(generation),
        close: controlled && !closed,
        archive: controlled && !closed,
        delete: controlled,
        restart: controlled && !closed && !pending && !lock,
        resume: controlled && !closed && !pending && lock !== 'uncertain' && lock !== 'pending',
        suspend: controlled && !closed && !pending && !lock,
        topics: false,
        larkNative: false,
      },
      controlGeneration: generation ?? 'pending',
      ...(lock ? { managementState: lock } : {}),
      previewUserText: latest?.message?.text ?? latest?.request?.envelope?.rawText ?? '',
      previewUserFullText: latest?.message?.text ?? latest?.request?.envelope?.rawText ?? '',
      previewBotText: latest?.result ?? '',
      previewBotFullText: latest?.result ?? '',
      previewBotState: latest?.result ? 'replied' : 'pending',
    };
    for (const field of ['model', 'kanbanColumn', 'kanbanColumnAt', 'kanbanPosition', 'repoName', 'gitBranch', 'lastTurn', 'hasUnsettledTask']) {
      if (row[field] !== undefined) {
        result[field] = row[field];
      }
    }
    if (result.capabilities.terminal) {
      result.terminalUrl = `/wecom-terminal/${encodeURIComponent(result.sessionId)}/`;
    }
    return result;
  }
  async machineEnvironment(path: string, init: RequestInit = { method: 'GET' }): Promise<Response> {
    if (!/^\/api\/session-env(?:-global(?:\/reveal)?(?:\?.*)?|-tmux\/remove)$/.test(path)) {
      throw new Error('wecom_machine_environment_path');
    }
    for (const file of readWecomConfigPaths(this.root)) {
      try {
        const snapshot = readFileSync(file, 'utf8');
        const config = parseWecomConfig(JSON.parse(snapshot));
        if (!config.managedCore) {
          continue;
        }
        const scope: Scope = { file, id: wecomConfigId(file), config, coreIdentity: wecomCoreIdentity(config), tasks: [], locks: {}, snapshot };
        const live = await this.live(scope);
        const response = await this.fetch(live.port, path, init);
        if (readFileSync(file, 'utf8') !== snapshot) {
          throw new Error('wecom_source_changed');
        }
        const current = await this.live(scope);
        if (current.bootInstanceId !== live.bootInstanceId || current.corePid !== live.corePid
          || current.coreProcessStart !== live.coreProcessStart) {
          throw new Error('wecom_source_changed');
        }
        if (response.ok) {
          return response;
        }
      } catch { /* try another independently verified core; no IM task is required */ }
    }
    return Response.json({ ok: false, error: 'daemon_offline' }, { status: 503 });
  }
  async snapshot(): Promise<{ sessions: WecomSessionRow[]; complete: boolean }> {
    let complete = true;
    const batches = await Promise.all(this.scopes().map(async scope => {
      try {
        const live = await this.live(scope);
        const response = await this.fetch(live.port, '/api/sessions');
        if (!response.ok) {
          throw new Error('wecom_core_list_failed');
        }
        const body = await response.json() as { sessions?: Record<string, unknown>[] };
        const current = await this.recheck(live);
        return (body.sessions ?? [])
          .filter(row => row.larkAppId === scope.config.managedCore!.botId && scope.tasks.some(task => linked(task, row.sessionId)))
          .map(row => this.project({ ...current, ...live, tasks: current.tasks, locks: current.locks }, row, true));
      } catch {
        try {
          // Rows, tasks and locks all from the state as re-read now (as the detail fallback does).
          const current = this.current(scope);
          return this.disk(current).map(row => this.project(current, row, false));
        } catch {
          complete = false;
          return [];
        }
      }
    }));
    return { sessions: batches.flat(), complete };
  }
  async list(): Promise<WecomSessionRow[]> {
    return (await this.snapshot()).sessions;
  }
  async terminal(uiSessionId: string): Promise<{ nativeSessionId: string; proxyPort: number; binding: string }> {
    const parsed = decodeWecomSessionId(uiSessionId);
    if (!parsed) {
      throw new Error('wecom_invalid_session');
    }
    const scope = this.scopes().find(item => item.id === parsed.configId && item.coreIdentity === parsed.coreIdentity
      && item.tasks.some(task => linked(task, parsed.nativeSessionId)));
    if (!scope) {
      throw new Error('wecom_session_source_mismatch');
    }
    const live = await this.live(scope);
    const response = await this.fetch(live.port, `/api/sessions/${encodeURIComponent(parsed.nativeSessionId)}`);
    if (!response.ok) {
      throw new Error('wecom_terminal_unavailable');
    }
    const value = await response.json() as any;
    const row = value.session ?? value;
    const current = await this.recheck(live);
    const birth = typeof row.workerPid === 'number' ? this.runtime.readIdentity(row.workerPid) : undefined;
    const proofResponse = await this.fetch(live.port, nativeGatewaySourceIdentityPath(parsed.nativeSessionId));
    const proof = await proofResponse.json() as Partial<NativeGatewaySourceIdentity>;
    await this.recheck(live);
    if (!proofResponse.ok || proof.bootInstanceId !== live.bootInstanceId || proof.terminal?.sessionId !== parsed.nativeSessionId
      || proof.terminal.workerPid !== row.workerPid || proof.terminal.workerProcessStart !== birth || proof.terminal.proxyPort !== row.proxyPort
      || row.status === 'closed' || row.sessionId !== parsed.nativeSessionId || row.larkAppId !== scope.config.managedCore!.botId
      || !birth || !Number.isInteger(row.proxyPort) || row.proxyPort < 1 || row.proxyPort > 65535 || current.locks[parsed.nativeSessionId]) {
      throw new Error('wecom_terminal_unavailable');
    }
    return {
      nativeSessionId: parsed.nativeSessionId,
      proxyPort: row.proxyPort,
      binding: [scope.id, scope.coreIdentity, live.bootInstanceId, live.corePid, live.coreProcessStart, row.workerPid, birth, row.workerGeneration ?? ''].join(':'),
    };
  }
  /** A native browser is scoped to one authenticated channel principal and the
   * newest trigger. The gateway remains the live ACL/epoch authority. */
  async nativeTerminal(input: NativeTerminalRequest): Promise<NativeTerminalTarget> {
    const scope = this.scopes().find(item => item.id === input.identity.connectionId && item.config.botId === input.identity.botId
      && item.tasks.some(task => linked(task, input.sessionId)));
    if (!scope || input.identity.provider !== 'wecom') {
      throw new Error('wecom_terminal_identity_mismatch');
    }
    const live = await this.live(scope);
    if (!live.control) {
      throw new Error('wecom_terminal_authority_unavailable');
    }
    const client = createDaemonClient({
      dashboardUrl: `http://127.0.0.1:${live.control.port}`,
      appId: 'wecom-native-terminal',
      secret: this.options.gatewaySecret,
      timeoutMs: 5000,
    });
    const authorization = await client.request({
      method: 'POST',
      path: WECOM_GATEWAY_CONTROL_PATHS.terminalAuthorize,
      body: { ...input, instanceId: live.control.instanceId, coreIdentity: scope.coreIdentity },
    });
    const value = authorization.body as Partial<WecomTerminalAuthorization>;
    if (authorization.status !== 200 || value.allowed !== true || typeof value.epoch !== 'string' || !value.epoch) {
      throw new Error('wecom_terminal_forbidden');
    }
    await this.recheck(live);
    const uiSessionId = encodeWecomSessionId(scope.id, scope.coreIdentity, input.sessionId);
    const target = await this.terminal(uiSessionId);
    await this.recheck(live);
    const finalAuthorization = await client.request({
      method: 'POST',
      path: WECOM_GATEWAY_CONTROL_PATHS.terminalAuthorize,
      body: { ...input, instanceId: live.control.instanceId, coreIdentity: scope.coreIdentity },
    });
    const finalValue = finalAuthorization.body as Partial<WecomTerminalAuthorization>;
    if (finalAuthorization.status !== 200 || finalValue.allowed !== true || finalValue.epoch !== value.epoch) {
      throw new Error('wecom_terminal_forbidden');
    }
    return { uiSessionId, ...target, epoch: finalValue.epoch };
  }
  async request(uiSessionId: string, operation: string, body: Record<string, unknown> = {}, query = new URLSearchParams()): Promise<Response> {
    const parsed = decodeWecomSessionId(uiSessionId);
    if (!parsed) {
      return Response.json({ ok: false, error: 'wecom_invalid_session' }, { status: 400 });
    }
    const scope = this.scopes().find(item => item.id === parsed.configId && item.coreIdentity === parsed.coreIdentity
      && item.tasks.some(task => linked(task, parsed.nativeSessionId)));
    if (!scope) {
      return Response.json({ ok: false, error: 'wecom_session_source_mismatch' }, { status: 404 });
    }
    if (operation === 'history') {
      const current = this.current(scope);
      return Response.json({
        ok: true,
        messages: current.tasks.filter(task => linked(task, parsed.nativeSessionId)).flatMap(task => [
          { role: 'user', senderType: 'user', senderName: '企微用户', content: task.message?.text ?? task.request?.envelope?.rawText ?? '' },
          ...(task.result ? [{ role: 'assistant', senderType: 'bot', senderName: 'Botmux', content: task.result }] : []),
        ]),
      });
    }
    const controls = ['interrupt', 'close', 'archive', 'delete', 'restart', 'resume', 'suspend'];
    if (!['detail', 'insight', 'rename', 'board', ...controls].includes(operation) && !/^insight\/turn\/\d{1,6}$/.test(operation)) {
      return Response.json({ ok: false, error: 'wecom_operation_unsupported' }, { status: 409 });
    }
    try {
      const live = await this.live(scope);
      if (controls.includes(operation)) {
        const current = await this.recheck(live);
        const tasks = current.tasks.filter(task => linked(task, parsed.nativeSessionId));
        const generation = [...tasks].reverse().find(task => task.triggerId)?.triggerId ?? 'pending';
        if (!live.control || body.expectedGeneration !== generation) {
          return Response.json({ ok: false, error: 'wecom_stale_session_generation' }, { status: 409 });
        }
        const result = await requestWecomSessionControl({
          ...live.control,
          coreIdentity: scope.coreIdentity,
          sessionId: parsed.nativeSessionId,
          operation: operation as WecomSessionOperation,
          requestId: typeof body.requestId === 'string' ? body.requestId : randomUUID(),
          expectedGeneration: generation,
          expectedCoreBootId: live.bootInstanceId,
        });
        await this.recheck(live);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }
      if (operation === 'rename' || operation === 'board') {
        const current = await this.recheck(live);
        const tasks = current.tasks.filter(task => linked(task, parsed.nativeSessionId));
        const generation = [...tasks].reverse().find(task => task.triggerId)?.triggerId ?? 'pending';
        if (body.expectedGeneration !== generation) {
          return Response.json({ ok: false, error: 'wecom_stale_session_generation' }, { status: 409 });
        }
        const detail = await this.fetch(live.port, `/api/sessions/${encodeURIComponent(parsed.nativeSessionId)}`);
        const detailBody = await detail.json() as any;
        const record = detailBody.session ?? detailBody;
        if (!detail.ok || record.sessionId !== parsed.nativeSessionId || record.larkAppId !== scope.config.managedCore!.botId
          || (operation === 'board' && (record.queued || record.status === 'closed'))) {
          return Response.json({ ok: false, error: 'wecom_metadata_unavailable' }, { status: 409 });
        }
        await this.recheck(live);
        const payload = operation === 'rename' ? { title: body.title, source: 'dashboard' } : { column: body.column, position: body.position };
        const upstream = await this.fetch(live.port, `/api/sessions/${encodeURIComponent(parsed.nativeSessionId)}/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [EXPECTED_CORE_BOOT_HEADER]: live.bootInstanceId },
          body: JSON.stringify(payload),
        });
        const value = await upstream.json();
        await this.recheck(live);
        return Response.json(value, { status: upstream.status });
      }
      const insight = operation === 'insight' || operation.startsWith('insight/turn/');
      for (const [key, value] of query) {
        if (!insight || !['detail', 'offset', 'limit', 'q', 'role', 'tag'].includes(key) || value.length > 2000 || /[\x00-\x1f]/.test(value)) {
          return Response.json({ ok: false, error: 'wecom_invalid_query' }, { status: 400 });
        }
      }
      const search = query.size ? `?${query}` : '';
      const upstream = await this.fetch(live.port, `/api/sessions/${encodeURIComponent(parsed.nativeSessionId)}${insight ? `/${operation}${search}` : ''}`);
      const value = await upstream.json() as Record<string, unknown>;
      const current = await this.recheck(live);
      if (!upstream.ok) {
        return Response.json({ ok: false, error: 'wecom_core_unavailable' }, { status: upstream.status });
      }
      if (insight) {
        return Response.json(value);
      }
      const raw = (value.session ?? value) as Record<string, unknown>;
      if (raw.sessionId !== parsed.nativeSessionId || raw.larkAppId !== scope.config.managedCore!.botId) {
        throw new Error('wecom_session_source_mismatch');
      }
      return Response.json({ ok: true, session: this.project({ ...live, tasks: current.tasks, locks: current.locks }, raw, true) });
    } catch {
      if (operation === 'detail') {
        try {
          const current = this.current(scope);
          const row = this.disk(current).find(item => item.sessionId === parsed.nativeSessionId);
          if (row) {
            return Response.json({ ok: true, session: this.project(current, row, false) });
          }
        } catch {}
      }
      return Response.json({ ok: false, error: 'wecom_core_offline' }, { status: 503 });
    }
  }
}
