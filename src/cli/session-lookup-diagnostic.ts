/**
 * The `[botmux send diagnostic] session_lookup_miss` line, as one pure builder
 * so its audience split (design doc 2026-08-12 §3.6) is testable without
 * spawning the whole `botmux send` path.
 */
import { detectSandboxContext } from './sandbox-host-hint.js';
import { isSessionScopedCliProcess } from '../services/session-store-copy.js';
import type { ResolveSessionDiagnostics } from './resolve-session-by-id.js';

export type LookupReadIsolation = 'required' | 'detected' | 'off';

export interface SessionLookupMissInput {
  sessionId: string;
  source: string;
  dataDir: string;
  reason: string;
  diagnostics?: ResolveSessionDiagnostics;
  cliVersion: string;
  relayPresent: boolean;
  readIsolation: LookupReadIsolation;
  capabilityPresent: boolean;
  envSessionId?: string;
  envLarkAppId?: string;
  originSessionId?: string;
}

export function formatSessionLookupMissLine(
  input: SessionLookupMissInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // §3.6 audience split: a session subprocess's stderr returns to the agent
  // (an unsandboxed session shell IS the host, and a relayed send re-execs
  // with BOTMUX_SESSION_ID set). It gets state, not version numbers — neither
  // the CLI's build nor the daemons' — and never a fleet-level command.
  const sessionScoped = isSessionScopedCliProcess(env);
  const askedDaemons = input.diagnostics?.askedDaemons ?? [];
  const askedRendered = askedDaemons.length
    ? askedDaemons
      .map(d => (sessionScoped ? d.appId : `${d.appId}@${d.version ?? '?'}`))
      .join(',')
    : '-';
  const context = env.BOTMUX_HOST_RELAY_AUTHORIZED === '1'
    ? 'host-relay'
    : detectSandboxContext(env).inSandbox
      ? 'sandbox'
      : 'host';
  return '[botmux send diagnostic] session_lookup_miss'
    + ` sessionId=${input.sessionId}`
    // Host relay re-exec of a sandboxed send vs. the sandbox itself vs. a
    // plain host shell: each sees a different store and daemon set.
    + ` context=${context}`
    + ` cliVersion=${sessionScoped ? '-' : input.cliVersion}`
    + ` askedDaemons=${askedRendered}`
    + ` storeOwnerAppId=${input.diagnostics?.ownerAppId ?? '-'}`
    + ` source=${input.source}`
    + ` dataDir=${input.dataDir}`
    + ` envSessionId=${input.envSessionId ?? '-'}`
    + ` envLarkAppId=${input.envLarkAppId ?? '-'}`
    + ` originSessionId=${input.originSessionId ?? '-'}`
    + ` reason=${input.reason}`
    + ` relayDir=${input.relayPresent ? 'present' : 'absent'}`
    + ` readIsolation=${input.readIsolation}`
    + ` capability=${input.capabilityPresent ? 'present' : 'absent'}`;
}
