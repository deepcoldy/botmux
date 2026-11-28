import { isValidPluginId } from '../ids.js';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pluginRuntimeDir, pluginsHome } from '../paths.js';
import type { SessionMcpRuntimeManifest } from './session-runtime.js';
import type { GatewayTrustedTurnIdentity } from './gateway.js';
import type { WorkerSessionEventScope } from '../../../services/session-event-scope.js';

/** An administrator's exact, audited tool grants. MCP annotations are not authority. */
export type HostReadOnlyMcpTools = Readonly<Record<string, readonly string[]>>;

export function parseHostReadOnlyMcpTools(raw: unknown): HostReadOnlyMcpTools | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 32) {
    throw new Error('invalid host read-only MCP tools');
  }
  const entries = Object.entries(raw);
  if (entries.some(([id, tools]) => !isValidPluginId(id) || !Array.isArray(tools) || !tools.length || tools.length > 64
    || tools.some(tool => typeof tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tool))
    || new Set(tools).size !== tools.length)) throw new Error('invalid host read-only MCP tools');
  return Object.freeze(Object.fromEntries(entries.map(([id, tools]) => [id, Object.freeze([...tools])])));
}

export function approvedReadOnlyTools(policy: HostReadOnlyMcpTools | undefined, pluginId: string): readonly string[] {
  return policy && Object.hasOwn(policy, pluginId) ? policy[pluginId] : [];
}

/** Strict host execution consumes only a regular, private runtime tree. A link
 * install or an interior symlink would otherwise let an Agent rewrite code
 * outside the protected plugins home after the administrator approved a tool. */
export function assertHostReadOnlyMcpRuntimeTree(pluginId: string, pluginDir = pluginRuntimeDir(pluginId)): void {
  const fail = (): never => { throw new Error(`host read-only MCP runtime is not a frozen regular tree:${pluginId}`); };
  try {
    if (pluginDir !== pluginRuntimeDir(pluginId)) fail();
    const root = lstatSync(pluginDir);
    if (root.isSymbolicLink() || !root.isDirectory()) fail();
    const canonicalRoot = realpathSync(pluginDir), canonicalHome = realpathSync(pluginsHome());
    const rel = relative(canonicalHome, canonicalRoot);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail();
    const pending = [canonicalRoot]; let inspected = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++inspected > 10_000 || entry.isSymbolicLink()) fail();
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (!entry.isFile()) fail();
      }
    }
  } catch { fail(); }
}

/** Require the actual private snapshot, never a caller-supplied count/boolean. */
export function assertHostReadOnlyMcpRuntime(manifest: SessionMcpRuntimeManifest | null | undefined, policy: HostReadOnlyMcpTools | undefined): void {
  const grants = parseHostReadOnlyMcpTools(policy);
  if (!manifest || !grants || !Array.isArray(manifest.entries)
    || new Set(manifest.entries.map(entry => entry.pluginId)).size !== manifest.entries.length
    || manifest.entries.some(entry => !manifest.pluginIds.includes(entry.pluginId)
      || entry.server.transport !== 'stdio' || entry.server.protectedCapability || entry.server.protectedEgressPolicy
      || !Array.isArray(entry.readOnlyTools) || !entry.readOnlyTools.length
      || new Set(entry.readOnlyTools).size !== entry.readOnlyTools.length
      || entry.readOnlyTools.some(tool => !approvedReadOnlyTools(grants, entry.pluginId).includes(tool)))) {
    throw new Error('host read-only MCP snapshot is missing or unapproved');
  }
}

/** Scheduled turns need a proven execution, but never a fabricated human caller. */
export function readOnlyMcpTurnKey(identity: GatewayTrustedTurnIdentity | undefined): string | undefined {
  const origin = identity?.sessionOrigin;
  if (!identity?.turnId || !origin?.runtime || !origin.execution
    || origin.execution.turnId !== identity.turnId || origin.execution.dispatchAttempt !== identity.dispatchAttempt) return undefined;
  return JSON.stringify([identity.turnId, identity.dispatchAttempt, origin.bindingId,
    origin.runtime.runtimeId, origin.runtime.epoch, origin.execution.executionId]);
}

export function isCurrentReadOnlyMcpExecution(identity: GatewayTrustedTurnIdentity, scope: WorkerSessionEventScope | undefined): boolean {
  const origin = identity.sessionOrigin;
  const current = scope?.currentBinding()?.runtime;
  const execution = scope?.executionForTurn(identity.turnId, identity.dispatchAttempt);
  return !!readOnlyMcpTurnKey(identity) && !!scope && !!current && !!execution
    && scope.isExecutionActive(identity.turnId!, identity.dispatchAttempt)
    && execution.executionId === origin!.execution!.executionId
    && current.runtimeId === origin!.runtime!.runtimeId && current.epoch === origin!.runtime!.epoch;
}
